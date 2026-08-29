import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const IDLE_SHUTDOWN_MS = 5 * 60_000;
const CLASSIFIER_TIMEOUT_MS = 8_000;
const WARMUP_TIMEOUT_MS = 20_000;
const SYSTEM_PROMPT = `You are Workbench's conversation supervisor. Convert a conversation into the one authoritative objective the coding agent must execute now.

Rules:
- The newest user correction overrides every conflicting earlier request, plan, hypothesis, implementation, and agent claim.
- A newest message beginning with "no", "not that", "that's not", "instead", or equivalent rejects the immediately preceding proposal. Never carry the rejected deliverable into the objective unless the correction explicitly retains it.
- If the newest user message is a continuation such as "continue", "do it", "build that", or "fix it", resolve it to the most recent concrete unresolved user request. Never use an agent's exploratory narration as the objective.
- Preserve exact scope, named locations, and named existing UI controls. Do not invent architecture, persistence, schema, migrations, or adjacent cleanup unless the user requested it.
- Acceptance criteria must describe observable completion. Exclusions must name tempting but conflicting work that should not be done.
- Set continuation=true only when the newest message is shorthand that cannot stand as a concrete instruction by itself. A concrete correction is not a continuation.
- Keep the objective compact and executable. Do not include analysis or a plan.

Return exactly one JSON object and nothing else:
{"objective":string,"acceptanceCriteria":string[],"exclusions":string[],"continuation":boolean}`;

type Pending = { prompt: string; resolve: (output: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null; timeoutMs: number };
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
  const pending = active;
  pending.timer = setTimeout(() => {
    if (active !== pending) return;
    active = null;
    try { worker?.kill('SIGTERM'); } catch { /* already stopped */ }
    worker = null;
    buffer = '';
    settle(pending, new Error(`Haiku turn-grounding classifier timed out after ${pending.timeoutMs / 1_000}s.`));
    if (queue.length) ensureWorker();
    dispatch();
  }, pending.timeoutMs);
  pending.timer.unref();
  worker.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: pending.prompt } })}\n`);
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
export function groundTurnWithHaiku(prompt: string, timeoutMs = CLASSIFIER_TIMEOUT_MS): Promise<string> {
  ensureWorker();
  return new Promise((resolve, reject) => {
    const pending: Pending = { prompt, resolve, reject, timer: null, timeoutMs };
    queue.push(pending);
    dispatch();
  });
}

/** Pay the one-time CLI/model handshake during server startup, off the request path. */
export function warmTurnGroundingClassifier(): void {
  void groundTurnWithHaiku('Warm-up only. Return {"objective":"ready","acceptanceCriteria":[],"exclusions":[],"continuation":false}.', WARMUP_TIMEOUT_MS).catch(() => {
    // Best effort. A real turn retains its human-only fallback.
  });
}

export function shutdownTurnGroundingClassifier(): void {
  stop(new Error('Turn-grounding classifier stopped during runtime shutdown.'));
}
