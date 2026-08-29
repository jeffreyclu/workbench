import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkbenchDatabase } from './database.js';
import { changeTypeLabel, isReviewChangeType, type ReviewChangeType } from '../shared/change-type.js';

export type ReviewAssistAction = 'explain' | 'what_could_break' | 'compare_task_intent' | 'score_risk';

export type ReviewAssistDecision = {
  behavior: string;
  /** Selects the obligations block in the prompt: what a reviewer must
   * establish differs by kind of change, so one rubric for every diff asked
   * new code and a deletion the same useless question. */
  changeType: ReviewChangeType;
  secondaryChangeTypes: ReviewChangeType[];
  /** Still accepted on the wire — the queue sends one payload shape to every
   * review surface — but deliberately ignored here: see `hashRequest`. */
  state: string;
  hunks: Array<{ filePath: string; location: string; lines: string[] }>;
};

export type ReviewAssistTaskIntent = { title: string; description: string } | null;

/** One warm agent serves every Changes question, so the action lives in the
 * turn rather than in a per-action process. Three specialised processes could
 * only ever keep one of them warm for the button a reviewer actually clicks. */
const CHANGES_AGENT_SYSTEM_PROMPT = [
  'You assist a code reviewer reading one diff decision at a time in Workbench.',
  'Every user message is self-contained: answer only from that message and ignore anything earlier in this session.',
  // Judging a changed assertion as production risk was the single most common
  // wrong answer this surface produced: the model read the lines and never the
  // path they came from. Every hunk is labelled with its file path, so say
  // outright what that path implies.
  'Each hunk is labelled with the file path it came from. Read the path before judging the lines.',
  'A path matching *.test.*, *.spec.*, __tests__/, /tests/, /e2e/, /__mocks__/, or /fixtures/ is test code. It ships to no user and cannot break production behavior on its own: changing, tightening, or updating assertions there is routine low-risk work. Judge a test change only on whether it weakens, deletes, or wrongly relaxes coverage — an assertion updated to match intended new behavior is expected, not a risk.',
  'Documentation, comment, styling, fixture, and lockfile-free config changes likewise carry far less blast radius than production source under src/, lib/, app/, or server/.',
  // The worker runs with no tools and cwd /tmp: it can see the hunks in the
  // message and nothing else. Left unsaid, it answered "all call sites are
  // updated" about call sites it had never been shown, which is the most
  // damaging thing this surface can do — a fabricated all-clear is worse than
  // no answer.
  'You are shown only the hunks in this message. You cannot see the rest of the file, the pre-change version, call sites, or the test suite. Never assert anything about code you were not shown: say "not visible here" and name what would have to be checked.',
  'Follow the instruction at the top of the message exactly. No preamble, no markdown headings, no restating the diff back verbatim.',
].join(' ');

/** Bumped whenever the system prompt or an action directive changes what a good
 * answer looks like. It is part of the cache key, so a corrected rubric
 * recomputes stale answers once instead of serving the old judgement forever. */
const ASSIST_PROMPT_VERSION = 3;

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
  score_risk: 'Instruction: rate how risky this change is for a reviewer to approve, from 0 (trivially safe) to 100 (dangerous, easy to get wrong, wide blast radius). Blast radius is set by the file path as much as by the lines: a test, fixture, or documentation file scores under 20 unless it removes or weakens coverage. Reply with exactly two lines and nothing else. First line: "SCORE: <number>". Second line: at most fifteen words saying why.',
};

/** The per-type half of the rubric. The action says what the reviewer asked
 * for; this says what counts as a good answer for this kind of change. Each
 * one names the evidence the model does not have, because the alternative is
 * that it invents it. */
const CHANGE_TYPE_DIRECTIVES: Record<ReviewChangeType, string> = {
  new_code: 'This is brand-new code. Coverage first: for every visible branch — guard, catch, early return, loop, switch arm — name the test line in this diff that exercises it, or mark it UNCOVERED. If no test file appears in this diff, say coverage is not visible rather than guessing either way. Then judge correctness, naming, and complexity of the new logic itself.',
  extension: 'This extends existing logic rather than rewriting it. Ask which previously handled inputs now take the new path, and whether the existing behavior is preserved for everything else.',
  behavior_edit: 'This edits existing behavior in place. State the old behavior and the new behavior in one line each, then name who would notice the difference.',
  refactor_pure: 'This looks like a behavior-preserving refactor. Compare old and new on the same axes and in the same order: signature, error handling, ordering and control flow, complexity. Name every difference that is not cosmetic. Call sites are not visible here — do not claim they are updated.',
  replacement: 'This replaces an existing implementation. Compare the removed and added versions on signature, error handling, edge cases, and ordering, then say which callers must be re-checked. Callers are not visible here — list them as unverified rather than as fine.',
  move_rename: 'This moves or renames code. The only questions that matter are whether the body changed while moving, and whether references to the old location or name are updated. References outside this diff are not visible — say so.',
  deletion: 'This deletes code. Say the most likely reason it was deleted, and say plainly when the reason is not visible in the diff. Then say what breaks if anything still references it, and flag any test deleted alongside it. Remaining references are not visible here: treat "is it still referenced?" as unverified, never as safe.',
  test_only: 'This is test-only and ships to no user. Judge it solely on whether coverage got weaker: assertions deleted, loosened, or skipped. An assertion updated to match intended new behavior is expected, not a risk.',
  config_dep: 'This is configuration or dependency change. Judge the size of the version jump, environment coupling, and whether build or runtime behavior moves with it.',
  docs_comment: 'This is documentation or comments only, with no runtime behavior. Judge only whether the text now contradicts the code.',
  generated: 'This is generated or vendored output, not hand-written. Judge only whether it looks consistently regenerated.',
};

/** Defensible score ranges per type, so the number means the same thing across
 * a diff. The model may leave a band, but only for a reason it states. */
const CHANGE_TYPE_RISK_BANDS: Record<ReviewChangeType, string> = {
  new_code: '20-70', extension: '20-60', behavior_edit: '25-75', refactor_pure: '20-60',
  replacement: '40-85', move_rename: '20-60', deletion: '40-90', test_only: '0-20',
  config_dep: '10-60', docs_comment: '0-10', generated: '0-10',
};

/** Cheapest possible turn whose only job is to pay the session's one-time
 * initialisation before a reviewer is waiting on it. Measured on this machine:
 * a session's first turn costs ~2.0s, every later turn ~0.9s, and pre-spawning
 * without priming saves nothing because the CLI initialises lazily on the
 * first message. */
const PRIME_PROMPT = 'Instruction: reply with the single word ready.';

/** Keyed on exactly what the prompt reads. Only `compare_task_intent` puts the
 * task into its prompt, so folding intent into every key fragmented the cache:
 * an edited task description threw away a score that did not depend on it, and
 * a background-computed score missed the moment the reviewer's window derived
 * intent even slightly differently. */
function hashRequest(action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent): string {
  // Review state is deliberately excluded from both the key and the prompt.
  // Whether a human has already ticked "Reviewed" does not change what the code
  // does, and folding it in threw the answer away the instant a reviewer
  // settled the decision — every settled hunk then paid for a fresh model turn
  // on the next visit, which is exactly the rescore loop this cache prevents.
  // It would also bias the score: an already-approved change reads as safer.
  // Change type is keyed: it selects a different obligations block, so the
  // same hunks classified differently are a different question with a
  // different right answer.
  const keyedDecision = { behavior: decision.behavior, changeType: decision.changeType, secondaryChangeTypes: decision.secondaryChangeTypes, hunks: decision.hunks };
  const keyed = action === 'compare_task_intent'
    ? { version: ASSIST_PROMPT_VERSION, action, decision: keyedDecision, taskIntent }
    : { version: ASSIST_PROMPT_VERSION, action, decision: keyedDecision };
  return createHash('sha256').update(JSON.stringify(keyed)).digest('hex');
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
  const changeType = isReviewChangeType(decision.changeType) ? decision.changeType : 'behavior_edit';
  const secondary = decision.secondaryChangeTypes.filter(isReviewChangeType);
  const typeLine = secondary.length > 0
    ? `Change type: ${changeTypeLabel(changeType)} (also involves: ${secondary.map(changeTypeLabel).join(', ')}).`
    : `Change type: ${changeTypeLabel(changeType)}.`;
  const parts = [
    ACTION_DIRECTIVES[action],
    `${typeLine}\n${CHANGE_TYPE_DIRECTIVES[changeType]}`,
    `Decision: ${decision.behavior}`,
    `Diff:\n${hunkText}`,
  ];
  if (action === 'score_risk') parts.push(`Defensible range for this change type: ${CHANGE_TYPE_RISK_BANDS[changeType]}. Leave it only for a reason you state in the second line.`);
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
