import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkbenchDatabase } from './database.js';

export type ReviewAssistAction = 'explain' | 'what_could_break' | 'compare_task_intent';

export type ReviewAssistDecision = {
  behavior: string;
  state: string;
  hunks: Array<{ filePath: string; location: string; lines: string[] }>;
};

export type ReviewAssistTaskIntent = { title: string; description: string } | null;

const SYSTEM_PROMPTS: Record<ReviewAssistAction, string> = {
  explain: 'You help a code reviewer understand one already-identified diff decision. Explain in plain English what this change does and why it plausibly exists. Be concise: at most six sentences. No preamble, no restating the diff back verbatim.',
  what_could_break: 'You help a code reviewer stress-test one already-identified diff decision. List the concrete, plausible ways this change could break something — edge cases, missed call sites, race conditions, silent behavior changes. Be concise: at most six bullet points, one line each. If nothing plausible comes to mind, say so directly instead of inventing risk.',
  compare_task_intent: 'You help a code reviewer judge whether one diff decision matches the task it was meant to accomplish. Compare the change against the stated task title and description, and say directly whether it looks aligned, partially aligned, or off-target, with a one-sentence reason. Be concise: at most six sentences.',
};

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
    `Decision: ${decision.behavior}`,
    `Review state: ${decision.state}`,
    `Diff:\n${hunkText}`,
  ];
  if (action === 'compare_task_intent') {
    parts.push(taskIntent ? `Task title: ${taskIntent.title}\nTask description: ${taskIntent.description}` : 'No task is linked to this review; say so and note that alignment cannot be judged.');
  }
  return parts.join('\n\n');
}

type PendingTurn = { resolve: (answer: string) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> | null };
type AssistWorker = { action: ReviewAssistAction; child: ChildProcessWithoutNullStreams; outputBuffer: string; active: PendingTurn | null };

const TURN_TIMEOUT_MS = 30_000;
const IDLE_SHUTDOWN_MS = 60_000;

/** One warm worker per action, kept alive so a reviewer's click pays only for
 * the model turn, not the ~1-3s Claude CLI cold start on top of it. Recycled
 * after each turn (no session reuse across decisions) and immediately
 * replaced so the next click still lands on a warm process. */
const workers = new Map<ReviewAssistAction, AssistWorker>();
const idleShutdowns = new Map<ReviewAssistAction, ReturnType<typeof setTimeout>>();

function scheduleIdleShutdown(action: ReviewAssistAction): void {
  const existing = idleShutdowns.get(action);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    const worker = workers.get(action);
    if (worker && !worker.active) recycleWorker(worker);
  }, IDLE_SHUTDOWN_MS);
  timeout.unref();
  idleShutdowns.set(action, timeout);
}

function recycleWorker(worker: AssistWorker): void {
  if (workers.get(worker.action) !== worker) return;
  workers.delete(worker.action);
  try { worker.child.kill('SIGTERM'); } catch { /* already stopped */ }
}

function startWorker(action: ReviewAssistAction): AssistWorker {
  const child = spawn('claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPTS[action],
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const worker: AssistWorker = { action, child, outputBuffer: '', active: null };
  workers.set(action, worker);
  (child.stdout as unknown as { setEncoding?: (encoding: string) => void }).setEncoding?.('utf8');
  child.stdout.on('data', (chunk: string) => {
    worker.outputBuffer += chunk;
    for (;;) {
      const newline = worker.outputBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = worker.outputBuffer.slice(0, newline);
      worker.outputBuffer = worker.outputBuffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (event.type !== 'result' || !worker.active) continue;
        const pending = worker.active;
        worker.active = null;
        if (pending.timeout) clearTimeout(pending.timeout);
        if (event.is_error || typeof event.result !== 'string' || !event.result.trim()) pending.reject(new Error('AI review assist returned no answer.'));
        else pending.resolve(event.result.trim());
        recycleWorker(worker);
        ensureWarmWorker(action);
      } catch { /* Ignore non-result stream events. */ }
    }
  });
  const stopWorker = (error: Error) => {
    if (workers.get(action) !== worker) return;
    recycleWorker(worker);
    const pending = worker.active;
    worker.active = null;
    if (pending) { if (pending.timeout) clearTimeout(pending.timeout); pending.reject(error); }
  };
  child.once('exit', () => stopWorker(new Error('AI review assist stopped unexpectedly.')));
  child.once('error', stopWorker);
  child.stdin.on('error', stopWorker);
  return worker;
}

function ensureWarmWorker(action: ReviewAssistAction): AssistWorker {
  return workers.get(action) ?? startWorker(action);
}

function runTurn(action: ReviewAssistAction, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = ensureWarmWorker(action);
    const idleShutdown = idleShutdowns.get(action);
    if (idleShutdown) clearTimeout(idleShutdown);
    if (worker.active) {
      // The warm worker is mid-turn (a second click landed before the first
      // resolved); fall back to a fresh one-off process rather than queueing
      // the reviewer behind an unrelated question.
      runOneOffTurn(action, prompt).then(resolve, reject);
      return;
    }
    const pending: PendingTurn = { resolve, reject, timeout: null };
    pending.timeout = setTimeout(() => {
      if (worker.active !== pending) return;
      worker.active = null;
      recycleWorker(worker);
      reject(new Error(`AI review assist timed out after ${TURN_TIMEOUT_MS / 1_000} seconds.`));
      ensureWarmWorker(action);
    }, TURN_TIMEOUT_MS);
    pending.timeout.unref();
    worker.active = pending;
    worker.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  }).finally(() => scheduleIdleShutdown(action));
}

function runOneOffTurn(action: ReviewAssistAction, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPTS[action],
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
 * window, or after a restart — pays for it twice. */
export async function requestReviewAssist(database: WorkbenchDatabase, action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent): Promise<string> {
  const hash = hashRequest(action, decision, taskIntent);
  const cached = readCached(database, hash);
  if (cached) return cached;
  const answer = await runTurn(action, buildPrompt(action, decision, taskIntent));
  writeCached(database, hash, answer);
  return answer;
}

/** Start one warm worker per action during server boot, before a reviewer
 * clicks anything, so the first real click of each kind is not the one that
 * pays for CLI startup. */
export function warmReviewAssist(): void {
  for (const action of Object.keys(SYSTEM_PROMPTS) as ReviewAssistAction[]) {
    ensureWarmWorker(action);
    scheduleIdleShutdown(action);
  }
}

/** Runtime promotion must reap these processes; otherwise an old release can
 * retain a Claude session and contend with a real agent turn indefinitely. */
export function shutdownReviewAssist(): void {
  for (const timeout of idleShutdowns.values()) clearTimeout(timeout);
  idleShutdowns.clear();
  const error = new Error('AI review assist stopped during runtime shutdown.');
  for (const worker of [...workers.values()]) {
    if (worker.active?.timeout) clearTimeout(worker.active.timeout);
    worker.active?.reject(error);
    worker.active = null;
    recycleWorker(worker);
  }
}
