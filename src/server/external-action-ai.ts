import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const IDLE_SHUTDOWN_MS = 5 * 60_000;
const CLASSIFIER_TIMEOUT_MS = 12_000;
const WARMUP_TIMEOUT_MS = 20_000;
const WARMUP_PROMPT = 'Warm-up only. Return {"granted":false,"operation":null}.';

export const EXTERNAL_ACTION_CLASSIFIER_PROMPT = `You are Workbench's one-turn external-action authorization service. Decide whether Jeffrey's newest message authorizes an agent to mutate an external service in THIS turn.

The current message is Jeffrey's instruction. Grant when it asks, commands, directs, approves, or states that an external mutation needs, must, or should happen now. The word "permission" is not required. Natural wording, abbreviations, imperatives, passive imperatives, and emphatic wording all count. Examples that grant: "push it", "open the PR", "the FE PR and branch needs to be relinked to CON-230", "post that comment", "you can publish", and "I have push permissions now for the BE repo, push it".

Judge authorization intent only. Do not enforce the external service's credentials, repository hooks, branch state, or any other feasibility policy here. A message that reports credentials are available and then commands the mutation is a grant, not a denial.

A terse permission may authorize the immediately preceding pending external operation supplied in context. Do not grant from quoted text, an old approval, or a description of what somebody else requested. A grant is only for the operation requested by the current message and expires when this agent turn completes.

Return exactly one JSON object and nothing else: {"granted":boolean,"operation":string|null}. When granted, operation must name the exact action and destination.`;

type Pending = {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
};

type ClassifierWorker = {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  pending: Pending | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  warmupTimer: ReturnType<typeof setTimeout> | null;
  phase: 'warming' | 'ready' | 'classifying' | 'stopped';
  claimed: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
};

const workers = new Set<ClassifierWorker>();
let standby: ClassifierWorker | null = null;

function stopWorker(worker: ClassifierWorker, error?: Error): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  if (worker.warmupTimer) clearTimeout(worker.warmupTimer);
  worker.idleTimer = null;
  worker.warmupTimer = null;
  worker.phase = 'stopped';
  worker.resolveReady();
  if (standby === worker) standby = null;
  workers.delete(worker);
  const pending = worker.pending;
  worker.pending = null;
  if (pending && !pending.settled) {
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error ?? new Error('Haiku authorization classifier stopped unexpectedly.'));
  }
  try { worker.child.kill('SIGTERM'); } catch { /* already stopped */ }
}

function createWorker(): ClassifierWorker {
  const child = spawn(process.env.CLAUDE_BIN?.trim() || 'claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--system-prompt', EXTERNAL_ACTION_CLASSIFIER_PROMPT,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let resolveReady = () => {};
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const worker: ClassifierWorker = { child, buffer: '', pending: null, idleTimer: null, warmupTimer: null, phase: 'warming', claimed: false, ready, resolveReady };
  workers.add(worker);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    worker.buffer += chunk;
    for (;;) {
      const newline = worker.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = worker.buffer.slice(0, newline);
      worker.buffer = worker.buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (event.type !== 'result') continue;
        if (worker.phase === 'warming') {
          if (worker.warmupTimer) clearTimeout(worker.warmupTimer);
          worker.warmupTimer = null;
          if (event.is_error || typeof event.result !== 'string') {
            stopWorker(worker, new Error('Haiku authorization classifier warm-up failed.'));
            continue;
          }
          worker.phase = 'ready';
          worker.resolveReady();
          if (!worker.claimed) {
            worker.idleTimer = setTimeout(() => stopWorker(worker), IDLE_SHUTDOWN_MS);
            worker.idleTimer.unref();
          }
          continue;
        }
        if (worker.phase !== 'classifying' || !worker.pending) continue;
        const pending = worker.pending;
        worker.pending = null;
        if (pending.settled) continue;
        pending.settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        if (event.is_error || typeof event.result !== 'string') pending.reject(new Error('Haiku authorization classifier failed.'));
        else pending.resolve(event.result);
      } catch { /* Ignore non-terminal stream records. */ }
    }
  });
  child.once('error', (error) => stopWorker(worker, error));
  child.once('exit', () => {
    if (worker.pending) stopWorker(worker, new Error('Haiku authorization classifier stopped unexpectedly.'));
    else {
      if (worker.idleTimer) clearTimeout(worker.idleTimer);
      if (standby === worker) standby = null;
      workers.delete(worker);
    }
  });
  child.stdin.on('error', (error) => stopWorker(worker, error));
  worker.warmupTimer = setTimeout(() => stopWorker(worker, new Error('Haiku authorization classifier warm-up timed out.')), WARMUP_TIMEOUT_MS);
  worker.warmupTimer.unref();
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: WARMUP_PROMPT } })}\n`, (error) => {
    if (error) stopWorker(worker, error);
  });
  return worker;
}

function ensureStandby(): ClassifierWorker {
  if (standby && standby.child.exitCode === null && !standby.child.killed) return standby;
  const worker = createWorker();
  standby = worker;
  return worker;
}

function claimWorker(): ClassifierWorker {
  const worker = ensureStandby();
  standby = null;
  worker.claimed = true;
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;
  // Keep the next single-use process warm while this isolated judgment runs.
  ensureStandby();
  return worker;
}

/**
 * One isolated tiny-model judgment per user message. The worker process is
 * single-use and stdin closes after one request, so authorization history can
 * never leak from one message into the next. Independent messages classify in
 * parallel instead of waiting behind one shared conversational worker.
 */
export function classifyExternalActionWithHaiku(prompt: string, timeoutMs = CLASSIFIER_TIMEOUT_MS): Promise<string> {
  const worker = claimWorker();
  return new Promise((resolve, reject) => {
    const pending: Pending = {
      resolve,
      reject,
      settled: false,
      timer: null,
    };
    worker.pending = pending;
    void worker.ready.then(() => {
      if (pending.settled) return;
      if (worker.phase !== 'ready') {
        stopWorker(worker, new Error('Haiku authorization classifier stopped before it was ready.'));
        return;
      }
      worker.phase = 'classifying';
      pending.timer = setTimeout(() => stopWorker(worker, new Error(`Haiku authorization classifier timed out after ${timeoutMs / 1_000}s.`)), timeoutMs);
      pending.timer.unref();
      worker.child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    });
  });
}

/** Pre-spawn one single-use CLI process without creating a shared conversation. */
export function warmExternalActionClassifier(): void {
  ensureStandby();
}

export function shutdownExternalActionClassifier(): void {
  for (const worker of [...workers]) stopWorker(worker, new Error('Authorization classifier stopped during runtime shutdown.'));
  standby = null;
}
