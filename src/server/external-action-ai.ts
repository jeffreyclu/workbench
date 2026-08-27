import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const IDLE_SHUTDOWN_MS = 30_000;
const SYSTEM_PROMPT = `You classify whether Jeffrey's current message grants one external mutation capability. Respect natural language and immediate conversational context. Grant only when he is clearly directing the action or clearly authorizing it; otherwise deny. A capability is one operation and expires after this turn. Return exactly <external-authorization>{"granted":true|false,"operation":"exact operation and destination, or null"}</external-authorization>.`;

type Pending = { prompt: string; resolve: (output: string) => void; reject: (error: Error) => void };
let worker: ChildProcessWithoutNullStreams | null = null;
let active: Pending | null = null;
let buffer = '';
const queue: Pending[] = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function stop(error: Error): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const child = worker;
  worker = null;
  buffer = '';
  try { child?.kill('SIGTERM'); } catch { /* already stopped */ }
  if (active) { active.reject(error); active = null; }
  while (queue.length) queue.shift()!.reject(error);
}

function scheduleIdleShutdown(): void {
  if (active || queue.length || !worker) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stop(new Error('Authorization classifier shut down while idle.')), IDLE_SHUTDOWN_MS);
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
          ? pending.reject(new Error('Haiku authorization classifier failed.'))
          : pending.resolve(event.result);
        dispatch();
      } catch { /* Ignore non-terminal stream records. */ }
    }
  });
  const stopClassifier = (error: Error) => {
    if (worker === classifier) stop(error);
  };
  classifier.once('exit', () => stopClassifier(new Error('Haiku authorization classifier stopped unexpectedly.')));
  classifier.once('error', stopClassifier);
  classifier.stdin.on('error', stopClassifier);
  return classifier;
}

/** A dedicated tiny model call; it never invokes the full Codex/Claude agent runtime. */
export function classifyExternalActionWithHaiku(prompt: string): Promise<string> {
  ensureWorker();
  return new Promise((resolve, reject) => { queue.push({ prompt, resolve, reject }); dispatch(); });
}

export function shutdownExternalActionClassifier(): void {
  stop(new Error('Authorization classifier stopped during runtime shutdown.'));
}
