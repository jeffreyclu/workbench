import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const IDLE_SHUTDOWN_MS = 30_000;
const CLASSIFIER_TIMEOUT_MS = 8_000;
const SYSTEM_PROMPT = `You are Workbench's conversation supervisor. Convert a conversation into the one authoritative objective the coding agent must execute now.

Rules:
- The newest user correction overrides every conflicting earlier request, plan, hypothesis, implementation, and agent claim.
- If the newest user message is a continuation such as "continue", "do it", "build that", or "fix it", resolve it to the most recent concrete unresolved user request. Never use an agent's exploratory narration as the objective.
- Preserve exact scope, named locations, and named existing UI controls. Do not invent architecture, persistence, schema, migrations, or adjacent cleanup unless the user requested it.
- Acceptance criteria must describe observable completion. Exclusions must name tempting but conflicting work that should not be done.
- Keep the objective compact and executable. Do not include analysis or a plan.

Return exactly one JSON object and nothing else:
{"objective":string,"acceptanceCriteria":string[],"exclusions":string[],"continuation":boolean}`;

type Pending = { prompt: string; resolve: (output: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null };
let worker: ChildProcessWithoutNullStreams | null = null;
let active: Pending | null = null;
let buffer = '';
const queue: Pending[] = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function settle(pending: Pending, error?: Error, output?: string): void {
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  if (error) pending.reject(error);
  else pending.resolve(output ?? '');
}

function stop(error: Error): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const child = worker;
  worker = null;
  buffer = '';
  try { child?.kill('SIGTERM'); } catch { /* already stopped */ }
  if (active) { settle(active, error); active = null; }
  while (queue.length) settle(queue.shift()!, error);
}

function scheduleIdleShutdown(): void {
  if (active || queue.length || !worker) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stop(new Error('Turn-grounding classifier shut down while idle.')), IDLE_SHUTDOWN_MS);
  idleTimer.unref();
}

function dispatch(): void {
  if (!worker || active || queue.length === 0) { scheduleIdleShutdown(); return; }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  active = queue.shift()!;
  worker.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: active.prompt } })}\n`);
}

function ensureWorker(): ChildProcessWithoutNullStreams {
  if (worker && worker.exitCode === null && !worker.killed) return worker;
  const classifier = worker = spawn('claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPT,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  classifier.stdout.setEncoding('utf8');
  classifier.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (event.type !== 'result' || !active) continue;
        const pending = active; active = null;
        event.is_error || typeof event.result !== 'string'
          ? settle(pending, new Error('Haiku turn-grounding classifier failed.'))
          : settle(pending, undefined, event.result);
        dispatch();
      } catch { /* Ignore non-terminal stream records. */ }
    }
  });
  const stopClassifier = (error: Error) => {
    if (worker === classifier) stop(error);
  };
  classifier.once('exit', () => stopClassifier(new Error('Haiku turn-grounding classifier stopped unexpectedly.')));
  classifier.once('error', stopClassifier);
  classifier.stdin.on('error', stopClassifier);
  return classifier;
}

/** One tiny, tool-free model call shared by every agent answering the same user turn. */
export function groundTurnWithHaiku(prompt: string): Promise<string> {
  ensureWorker();
  return new Promise((resolve, reject) => {
    const pending: Pending = { prompt, resolve, reject, timer: null };
    pending.timer = setTimeout(() => {
      const index = queue.indexOf(pending);
      if (index >= 0) queue.splice(index, 1);
      if (active === pending) {
        active = null;
        try { worker?.kill('SIGTERM'); } catch { /* already stopped */ }
        worker = null;
        buffer = '';
        dispatch();
      }
      settle(pending, new Error(`Haiku turn-grounding classifier timed out after ${CLASSIFIER_TIMEOUT_MS / 1_000}s.`));
    }, CLASSIFIER_TIMEOUT_MS);
    pending.timer.unref();
    queue.push(pending);
    dispatch();
  });
}

export function shutdownTurnGroundingClassifier(): void {
  stop(new Error('Turn-grounding classifier stopped during runtime shutdown.'));
}
