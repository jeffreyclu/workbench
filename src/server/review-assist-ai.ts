import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkbenchDatabase } from './database.js';

export type ReviewAssistAction = 'explain' | 'what_could_break' | 'compare_task_intent' | 'score_risk';

export type ReviewAssistDecision = {
  behavior: string;
  state: string;
  hunks: Array<{ filePath: string; location: string; lines: string[] }>;
};

export type ReviewAssistTaskIntent = { title: string; description: string } | null;

/** One warm agent serves every Changes question, so the action lives in the
 * turn rather than in a per-action process. Three specialised processes could
 * only ever keep one of them warm for the button a reviewer actually clicks. */
const CHANGES_AGENT_SYSTEM_PROMPT = 'You assist a code reviewer reading one diff decision at a time in Workbench. Every user message is self-contained: answer only from that message and ignore anything earlier in this session. Follow the instruction at the top of the message exactly. No preamble, no markdown headings, no restating the diff back verbatim.';

// Answer length is the dominant latency term once the session is primed:
// measured on this machine a warm turn spends ~0.9s on session overhead and the
// rest generating tokens, so these caps are a deliberate speed/detail trade and
// are the first knob to loosen if answers read as too terse.
const ACTION_DIRECTIVES: Record<ReviewAssistAction, string> = {
  explain: 'Instruction: explain in plain English what this change does and why it plausibly exists. At most three sentences, and stop as soon as the point is made.',
  what_could_break: 'Instruction: list the concrete, plausible ways this change could break something — edge cases, missed call sites, race conditions, silent behavior changes. At most four bullet points, one short line each. If nothing plausible comes to mind, say so directly instead of inventing risk.',
  compare_task_intent: 'Instruction: judge whether this change matches the task it was meant to accomplish. Say directly whether it looks aligned, partially aligned, or off-target, with a one-sentence reason. At most three sentences.',
  // The two-line shape is a contract with the client, which parses the first
  // line into the badge number. An answer that does not follow it is rendered
  // as plain text rather than being coerced into a fake score.
  score_risk: 'Instruction: rate how risky this change is for a reviewer to approve, from 0 (trivially safe) to 100 (dangerous, easy to get wrong, wide blast radius). Reply with exactly two lines and nothing else. First line: "SCORE: <number>". Second line: at most fifteen words saying why.',
};

/** Cheapest possible turn whose only job is to pay the session's one-time
 * initialisation before a reviewer is waiting on it. Measured on this machine:
 * a session's first turn costs ~2.0s, every later turn ~0.9s, and pre-spawning
 * without priming saves nothing because the CLI initialises lazily on the
 * first message. */
const PRIME_PROMPT = 'Instruction: reply with the single word ready.';

function hashRequest(action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent): string {
  return createHash('sha256').update(JSON.stringify({ action, decision, taskIntent })).digest('hex');
}

function readCached(database: WorkbenchDatabase, hash: string): string | undefined {
  const row = database.prepare('SELECT answer FROM review_assist_cache WHERE hash = ?').get(hash) as { answer: string } | undefined;
  return row?.answer;
}

function writeCached(database: WorkbenchDatabase, hash: string, answer: string): void {
  database.prepare('INSERT OR REPLACE INTO review_assist_cache (hash, answer, created_at) VALUES (?, ?, ?)')
    .run(hash, answer, new Date().toISOString());
}

/** Cache-only read: never spawns a model turn. Lets the reviewer see an answer
 * they (or another window) already paid for the instant they open a hunk,
 * without turning this surface back into ambient AI spend for hunks nobody
 * has asked about yet. */
export function lookupReviewAssist(database: WorkbenchDatabase, action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent): string | null {
  return readCached(database, hashRequest(action, decision, taskIntent)) ?? null;
}

function buildPrompt(action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent): string {
  const hunkText = decision.hunks.map((hunk) => `${hunk.filePath} (${hunk.location}):\n${hunk.lines.join('\n')}`).join('\n\n');
  const parts = [
    ACTION_DIRECTIVES[action],
    `Decision: ${decision.behavior}`,
    `Review state: ${decision.state}`,
    `Diff:\n${hunkText}`,
  ];
  if (action === 'compare_task_intent') {
    parts.push(taskIntent ? `Task title: ${taskIntent.title}\nTask description: ${taskIntent.description}` : 'No task is linked to this review; say so and note that alignment cannot be judged.');
  }
  return parts.join('\n\n');
}

type PendingTurn = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  onDelta?: (text: string) => void;
};

type PrimeWaiter = { resolve: () => void; reject: (error: Error) => void };

type AssistWorker = {
  child: ChildProcessWithoutNullStreams;
  outputBuffer: string;
  active: PendingTurn | null;
  primed: boolean;
  primeWaiters: PrimeWaiter[];
};

const TURN_TIMEOUT_MS = 30_000;
const PRIME_TIMEOUT_MS = 20_000;
/** Primed sessions stay resident for the life of the runtime, because an
 * idle-shutdown timer only guarantees that the next reviewer pays the cold
 * start again. Two, not one: the dwell prefetch below fires automatically on
 * every decision a reviewer lands on, and a replacement session is only
 * *started* when one is handed out -- it needs its own ~2.0s prime turn before
 * it is warm. With a single session, a click arriving while a background
 * prefetch held it fell through to an unprimed worker and paid that cold start
 * anyway, which is the case this pool exists to prevent. One spare keeps the
 * interactive click warm while a prefetch is in flight; deeper is not free,
 * since each idle primed Claude session holds roughly 230MB. */
const POOL_TARGET = 2;

const idlePool: AssistWorker[] = [];
const liveWorkers = new Set<AssistWorker>();

function writeTurn(worker: AssistWorker, prompt: string): void {
  worker.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
}

function disposeWorker(worker: AssistWorker, error: Error): void {
  if (!liveWorkers.delete(worker)) return;
  const pooled = idlePool.indexOf(worker);
  if (pooled >= 0) idlePool.splice(pooled, 1);
  const pending = worker.active;
  worker.active = null;
  if (pending?.timeout) clearTimeout(pending.timeout);
  pending?.reject(error);
  for (const waiter of worker.primeWaiters.splice(0)) waiter.reject(error);
  try { worker.child.kill('SIGTERM'); } catch { /* already stopped */ }
}

function handleWorkerLine(worker: AssistWorker, line: string): void {
  let event: { type?: string; result?: unknown; is_error?: boolean; event?: { type?: string; delta?: { type?: string; text?: string } } };
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'stream_event') {
    // Thinking deltas are deliberately dropped: the reviewer asked a question,
    // not for the model's scratchpad.
    const delta = event.event?.type === 'content_block_delta' ? event.event.delta : undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') worker.active?.onDelta?.(delta.text);
    return;
  }
  if (event.type !== 'result') return;
  if (!worker.active) {
    worker.primed = true;
    for (const waiter of worker.primeWaiters.splice(0)) waiter.resolve();
    return;
  }
  const pending = worker.active;
  worker.active = null;
  if (pending.timeout) clearTimeout(pending.timeout);
  if (event.is_error || typeof event.result !== 'string' || !event.result.trim()) pending.reject(new Error('AI review assist returned no answer.'));
  else pending.resolve(event.result.trim());
  // Retire the session rather than reusing it, so no decision's diff leaks
  // into the next reviewer question. The warm replacement was already started
  // when this worker was taken out of the pool.
  disposeWorker(worker, new Error('AI review assist worker retired after its turn.'));
  ensureWarmPool();
}

function startWorker(): AssistWorker {
  const child = spawn('claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--include-partial-messages',
    '--system-prompt', CHANGES_AGENT_SYSTEM_PROMPT,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const worker: AssistWorker = { child, outputBuffer: '', active: null, primed: false, primeWaiters: [] };
  liveWorkers.add(worker);
  (child.stdout as unknown as { setEncoding?: (encoding: string) => void }).setEncoding?.('utf8');
  child.stdout.on('data', (chunk: string) => {
    worker.outputBuffer += chunk;
    for (;;) {
      const newline = worker.outputBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = worker.outputBuffer.slice(0, newline);
      worker.outputBuffer = worker.outputBuffer.slice(newline + 1);
      handleWorkerLine(worker, line);
    }
  });
  const stop = (error: Error) => disposeWorker(worker, error);
  child.once('exit', () => stop(new Error('AI review assist stopped unexpectedly.')));
  child.once('error', stop);
  child.stdin.on('error', stop);
  writeTurn(worker, PRIME_PROMPT);
  return worker;
}

function ensureWarmPool(): void {
  while (idlePool.length < POOL_TARGET) idlePool.push(startWorker());
}

/** Hands out an exclusive session and immediately starts its replacement, so
 * the pool is refilled while this turn is still running rather than after it. */
function takeWorker(): AssistWorker {
  const primed = idlePool.findIndex((worker) => worker.primed);
  const worker = primed >= 0 ? idlePool.splice(primed, 1)[0] : idlePool.shift() ?? startWorker();
  ensureWarmPool();
  return worker;
}

function whenPrimed(worker: AssistWorker): Promise<void> {
  if (worker.primed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('AI review assist worker never became ready.')), PRIME_TIMEOUT_MS);
    timeout.unref();
    worker.primeWaiters.push({
      resolve: () => { clearTimeout(timeout); resolve(); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
  });
}

function dispatchTurn(worker: AssistWorker, prompt: string, onDelta?: (text: string) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pending: PendingTurn = { resolve, reject, timeout: null, onDelta };
    pending.timeout = setTimeout(() => {
      if (worker.active !== pending) return;
      worker.active = null;
      reject(new Error(`AI review assist timed out after ${TURN_TIMEOUT_MS / 1_000} seconds.`));
      disposeWorker(worker, new Error('AI review assist worker retired after a timeout.'));
      ensureWarmPool();
    }, TURN_TIMEOUT_MS);
    pending.timeout.unref();
    worker.active = pending;
    writeTurn(worker, prompt);
  });
}

async function runTurn(prompt: string, onDelta?: (text: string) => void): Promise<string> {
  const worker = takeWorker();
  try {
    await whenPrimed(worker);
  } catch {
    // The warm session died or never came up. A one-off process is slower but
    // still answers, and a genuine model failure still surfaces to the client.
    return runOneOffTurn(prompt);
  }
  return dispatchTurn(worker, prompt, onDelta);
}

function runOneOffTurn(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--no-session-persistence', '--no-chrome', '--system-prompt', CHANGES_AGENT_SYSTEM_PROMPT,
      '--output-format', 'json',
    ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('AI review assist timed out after 30 seconds.'));
    }, TURN_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`AI review assist failed: ${stderr.trim() || `exit code ${code}`}`)); return; }
      try {
        const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
        if (envelope.is_error || typeof envelope.result !== 'string' || !envelope.result.trim()) {
          reject(new Error('AI review assist returned no answer.'));
          return;
        }
        resolve(envelope.result.trim());
      } catch {
        reject(new Error('AI review assist returned an unreadable response.'));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Reads the cache first; only an uncached question pays for a model turn,
 * and its answer is persisted so no reviewer — in this window, another
 * window, or after a restart — pays for it twice. `onDelta` streams the answer
 * as it is generated so the reviewer reads the first sentence about a second
 * in, instead of staring at a spinner until the whole turn completes. */
export async function requestReviewAssist(
  database: WorkbenchDatabase,
  action: ReviewAssistAction,
  decision: ReviewAssistDecision,
  taskIntent: ReviewAssistTaskIntent,
  onDelta?: (text: string) => void,
): Promise<string> {
  const hash = hashRequest(action, decision, taskIntent);
  const cached = readCached(database, hash);
  if (cached) return cached;
  const answer = await runTurn(buildPrompt(action, decision, taskIntent), onDelta);
  writeCached(database, hash, answer);
  return answer;
}

/** Start and prime the warm Changes agents during server boot, before a
 * reviewer clicks anything, so no real click ever pays session startup. */
export function warmReviewAssist(): void {
  ensureWarmPool();
}

/** Runtime promotion must reap these processes; otherwise an old release can
 * retain a Claude session and contend with a real agent turn indefinitely. */
export function shutdownReviewAssist(): void {
  const error = new Error('AI review assist stopped during runtime shutdown.');
  for (const worker of [...liveWorkers]) disposeWorker(worker, error);
  idlePool.length = 0;
}
