import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkbenchDatabase } from './database.js';
import { changeTypeLabel, isReviewChangeType, type ReviewChangeType } from '../shared/change-type.js';
import { REVIEW_ASSIST_CONFIDENCE_PREFIX, REVIEW_ASSIST_MISSING_PREFIX, type ReviewAssistTier } from '../shared/contracts.js';
import { auditCitations, auditReferenceClaims, citationAuditNote, referenceClaimNote, type CoverageEvidence, type ReferenceEvidence } from '../shared/coverage-evidence.js';
import { auditParityTable, parityAuditNote, parityTableApplies, PARITY_DIRECTIVE } from '../shared/parity-table.js';

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
  /** Test hunks from elsewhere in the same review that name this decision's new
   * declarations. Optional because a stale tab still posts the old payload. */
  coverageEvidence?: CoverageEvidence;
  referenceEvidence?: ReferenceEvidence;
  /** The after-state of the files this block changes, when the calling surface
   * could read them. Optional for the same reason as the evidence packs, and
   * excluded from the cache key by `hashRequest`. */
  fileContext?: Array<{ filePath: string; content: string }>;
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
  'A message may carry a "Companion test hunks" block. Those hunks are from the same review but a different decision: they are evidence about the change, never part of it. Judge them only as coverage, and never score or critique them as if they were the change itself.',
  'Cite code as [path:line] using a path and a line number that appear in this message — for example [src/foo.ts:42]. A citation to a file or line you were not shown is a fabrication, so cite nothing rather than guess a number.',
  'Follow the instruction at the top of the message exactly. No preamble, no markdown headings, no restating the diff back verbatim.',
].join(' ');

/** Bumped whenever the system prompt, an action directive, or the spend behind
 * a tier changes what a good answer looks like. It is part of the cache key, so
 * a corrected rubric recomputes stale answers once instead of serving the old
 * judgement forever. Bumped to 7 when the tiers started buying different
 * models: every T2 and T3 answer already cached was produced by the cheap turn
 * and would otherwise keep being served with the deep tier's authority.
 *
 * Bumped to 8 when the confidence question was recalibrated. The old wording
 * asked for low confidence "whenever answering properly needed something you
 * were not given", and a diff fragment always does — so 12 of the first 17
 * delegated answers came back low, every one of them escalated, and delegation
 * handed the whole queue back to the reviewer with extra steps. Those answers
 * are cached judgements made against the wrong question and must not survive
 * the fix. */
const ASSIST_PROMPT_VERSION = 8;

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
  new_code: 'This is brand-new code. Coverage first: for every visible branch — guard, catch, early return, loop, switch arm — emit one line pairing the logic with its proof, as [logic path:line] <- [test path:line], or mark the branch UNCOVERED with no test citation. Draw test citations from the companion test hunks when they are supplied. If no test hunk names this code at all, say coverage is not visible rather than guessing either way. Then judge correctness, naming, and complexity of the new logic itself.',
  extension: 'This extends existing logic rather than rewriting it. Ask which previously handled inputs now take the new path, and whether the existing behavior is preserved for everything else. Cite the added branch as [path:line], and cite a companion test line for it when one is supplied.',
  behavior_edit: 'This edits existing behavior in place. State the old behavior and the new behavior in one line each, then name who would notice the difference.',
  refactor_pure: 'This looks like a behavior-preserving refactor. Compare old and new on the same axes and in the same order: signature, error handling, ordering and control flow, complexity. Name every difference that is not cosmetic. Call sites are visible only through a surviving-reference block below; without one, do not claim they are updated.',
  replacement: 'This replaces an existing implementation. Compare the removed and added versions on signature, error handling, edge cases, and ordering, then say which callers must be re-checked. Callers are visible only through a surviving-reference block below; without one, list them as unverified rather than as fine.',
  move_rename: 'This moves or renames code. The only questions that matter are whether the body changed while moving, and whether references to the old location or name are updated. References outside this diff are visible only through a surviving-reference block below; without one, say so.',
  deletion: 'This deletes code. Say the most likely reason it was deleted, and say plainly when the reason is not visible in the diff. Then say what breaks if anything still references it, and flag any test deleted alongside it. Remaining references are visible only through a surviving-reference block below: cite it when it names one, and otherwise treat "is it still referenced?" as unverified, never as safe.',
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

/** Only `what_could_break` asks for the parity table. It is the action whose
 * question — what does this supposedly equivalent change actually alter — the
 * table *is* the answer to. `explain` is capped at three sentences and
 * `score_risk` at two lines, so a four-line table there would either overflow
 * the shape the client parses or crowd out the answer itself. */
const PARITY_ACTIONS = new Set<ReviewAssistAction>(['what_could_break']);

function parityContractApplies(action: ReviewAssistAction, changeType: ReviewChangeType): boolean {
  return PARITY_ACTIONS.has(action) && parityTableApplies(changeType);
}

/** Cheapest possible turn whose only job is to pay the session's one-time
 * initialisation before a reviewer is waiting on it. Measured on this machine:
 * a session's first turn costs ~2.0s, every later turn ~0.9s, and pre-spawning
 * without priming saves nothing because the CLI initialises lazily on the
 * first message. */
const PRIME_PROMPT = 'Instruction: reply with the single word ready.';

/** How hard to look. Keying the tier without spending it differently would be
 * the worst of both: two cache entries, one answer, twice the spend. These are
 * appended only for a tiered request, so the untiered Changes prompt is byte
 * for byte the prompt it has always been. */
const TIER_DIRECTIVES: Record<ReviewAssistTier, string> = {
  T0: 'Depth: none. Proof settled this block before you were asked, so this is a formality. One line, and no speculation about what else it might reach.',
  T1: 'Depth: skim. A bounded question with a bounded answer: at most three sentences, drawn from what this diff shows. Do not reason about callers you were not given.',
  T2: 'Depth: read. A human reads this block after you. Say what they would otherwise have to work out for themselves, and skip what the diff already makes plain.',
  T3: 'Depth: study. This one is costly to get wrong. Work through what it changes, what depends on it, and what would have to be true for it to be safe — and name which of those you could not check.',
};

/** What each tier actually costs. The directives above only ask the model to
 * look harder; until this existed every one of them was answered by the same
 * haiku/low turn, so 'study this one' and 'skim this one' differed in wording
 * alone while the cache filed them under separate keys — precisely the two
 * entries, one answer trade the comment above warns against.
 *
 * T0 and T1 hold the pool's own configuration, because they are the
 * interactive path and must keep landing on a warm session. Only T2 and T3,
 * which routing hands out sparingly, pay for a cold one.
 *
 * The timeout climbs with the tier because it has to: thinking for longer is
 * the thing a deep tier is buying, and leaving all four at the skim's 30s would
 * have converted every study into a timeout instead of a better answer. */
type AssistSpend = { model: string; effort: string; timeoutMs: number };

const DEFAULT_SPEND: AssistSpend = { model: 'haiku', effort: 'low', timeoutMs: 30_000 };

const TIER_SPEND: Record<ReviewAssistTier, AssistSpend> = {
  T0: DEFAULT_SPEND,
  T1: DEFAULT_SPEND,
  T2: { model: 'sonnet', effort: 'medium', timeoutMs: 90_000 },
  T3: { model: 'opus', effort: 'high', timeoutMs: 180_000 },
};

/** An untiered request is a Changes question, which has always been the cheap
 * turn — it keeps the pool's spend exactly, so nothing about Changes moves. */
function spendFor(tier: ReviewAssistTier | null): AssistSpend {
  return tier ? TIER_SPEND[tier] : DEFAULT_SPEND;
}

/** The escalation hinge. A cheap tier is only worth buying if its answer can
 * admit it was too cheap; without this, an under-informed skim reads exactly
 * like a settled one and the reviewer never learns which is which. */
const CONFIDENCE_DIRECTIVE = [
  `End with a line "${REVIEW_ASSIST_CONFIDENCE_PREFIX} high" or "${REVIEW_ASSIST_CONFIDENCE_PREFIX} low".`,
  'This rates the answer you just gave, at the depth you were asked for. It is not a wish list.',
  'You are never given the whole repository, and the question above was written knowing that:',
  'if the material in this message answers it, say high even though callers, the rest of the file, or the test suite were withheld.',
  'Say low only when the question itself cannot be answered from what you were shown — the change is unintelligible without something absent, or answering would require asserting something about code not in this message —',
  `and then add a line "${REVIEW_ASSIST_MISSING_PREFIX} <what would have to be read>".`,
  'Low sends the block back to a human, so it must mean this question was priced too cheaply, not that more context would have been pleasant.',
].join(' ');

/** Keyed on exactly what the prompt reads. Only `compare_task_intent` puts the
 * task into its prompt, so folding intent into every key fragmented the cache:
 * an edited task description threw away a score that did not depend on it, and
 * a background-computed score missed the moment the reviewer's window derived
 * intent even slightly differently. */
function hashRequest(action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent, tier: ReviewAssistTier | null = null): string {
  // Review state is deliberately excluded from both the key and the prompt.
  // Whether a human has already ticked "Reviewed" does not change what the code
  // does, and folding it in threw the answer away the instant a reviewer
  // settled the decision — every settled hunk then paid for a fresh model turn
  // on the next visit, which is exactly the rescore loop this cache prevents.
  // It would also bias the score: an already-approved change reads as safer.
  // Change type is keyed: it selects a different obligations block, so the
  // same hunks classified differently are a different question with a
  // different right answer.
  // Evidence packs are keyed as well, because the prompt states their
  // conclusions as searched-the-whole-review fact. Keying only the conclusions
  // and the hunk identities, never the evidence bodies: whole-text keying would
  // throw a good answer away every time an unrelated line moved in a companion
  // hunk, which is the fragmentation the pack size caps already guard against.
  // `symbols` is omitted from both because it is derived from hunks, which are
  // keyed already; `clearedSymbols` is omitted as the complement of residual.
  const keyedEvidence = {
    coverage: decision.coverageEvidence
      ? [decision.coverageEvidence.uncitedSymbols, decision.coverageEvidence.hunks.map((hunk) => `${hunk.filePath}:${hunk.symbols.join(',')}`)]
      : null,
    references: decision.referenceEvidence
      ? [decision.referenceEvidence.residualSymbols, decision.referenceEvidence.hunks.map((hunk) => `${hunk.kind}:${hunk.filePath}:${hunk.symbols.join(',')}`)]
      : null,
  };
  const keyedDecision = { behavior: decision.behavior, changeType: decision.changeType, secondaryChangeTypes: decision.secondaryChangeTypes, hunks: decision.hunks, evidence: keyedEvidence };
  // `tier` is only present for review-stack requests, and `JSON.stringify`
  // omits an undefined value: a request without a tier hashes to exactly the
  // string it hashed to before tiering existed, so no cached Changes answer is
  // invalidated by this key gaining a field.
  const keyed = action === 'compare_task_intent'
    ? { version: ASSIST_PROMPT_VERSION, action, decision: keyedDecision, taskIntent, tier: tier ?? undefined }
    : { version: ASSIST_PROMPT_VERSION, action, decision: keyedDecision, tier: tier ?? undefined };
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
export function lookupReviewAssist(database: WorkbenchDatabase, action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent, tier: ReviewAssistTier | null = null): string | null {
  return readCached(database, hashRequest(action, decision, taskIntent, tier)) ?? null;
}

function buildPrompt(action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent, tier: ReviewAssistTier | null = null): string {
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
  const evidence = decision.coverageEvidence;
  if (evidence && evidence.hunks.length > 0) {
    const evidenceText = evidence.hunks
      .map((hunk) => `${hunk.filePath} (${hunk.location}) — exercises ${hunk.symbols.join(', ')}:\n${hunk.lines.join('\n')}`)
      .join('\n\n');
    parts.push(`Companion test hunks (same review, different decision — evidence only, not part of this change):\n${evidenceText}`);
  }
  // Stated as a searched-and-not-found fact, because the model cannot tell the
  // difference between "no test exists" and "the test was not put in front of
  // me" — and left to guess, it has picked either one.
  if (evidence && evidence.uncitedSymbols.length > 0) {
    parts.push(`The whole review was searched: no test hunk anywhere in it mentions ${evidence.uncitedSymbols.join(', ')}. Treat those as uncovered, not as unverifiable.`);
  }
  const references = decision.referenceEvidence;
  if (references && references.hunks.length > 0) {
    const referenceText = references.hunks
      .map((hunk) => {
        const claim = hunk.kind === 'residual'
          ? `still references ${hunk.symbols.join(', ')} on a line this review keeps`
          : `drops its references to ${hunk.symbols.join(', ')}`;
        return `${hunk.filePath} (${hunk.location}) — ${claim}:\n${hunk.lines.join('\n')}`;
      })
      .join('\n\n');
    parts.push(`Surviving-reference block for declarations this change removes (same review, different decision — evidence only, not part of this change):\n${referenceText}`);
  }
  if (references && references.residualSymbols.length > 0) {
    parts.push(`Still referenced after this change: ${references.residualSymbols.join(', ')}. Cite the hunk that proves it and report a break, not a possibility.`);
  }
  // Asymmetric on purpose. A surviving reference found in the review is proof of
  // breakage; finding none is not proof of safety, because the review is not the
  // repository and an untouched caller never appears in any diff. Stating the
  // negative as "cleared" would manufacture exactly the false all-clear the
  // deletion directive was written to prevent.
  if (references && references.clearedSymbols.length > 0) {
    parts.push(`No surviving line anywhere in this review mentions ${references.clearedSymbols.join(', ')}. This review is not the whole repository, so that narrows the risk without clearing it: say references outside the reviewed files remain unverified.`);
  }
  // The system prompt tells every worker it cannot see past the hunks, because
  // for most requests that is true and a worker that forgets it invents call
  // sites. When the file is actually here, that standing instruction is wrong
  // and has to be revoked explicitly for these paths — left in place, the model
  // reads the file and still reports it as unseen.
  const fileContext = decision.fileContext ?? [];
  if (fileContext.length > 0) {
    const contextText = fileContext.map((file) => `${file.filePath}:\n${file.content}`).join('\n\n');
    parts.push(`Whole files, as this change leaves them (the diff above is the change; this is the code around it):\n${contextText}`);
    parts.push(`You can see all of ${fileContext.map((file) => file.filePath).join(', ')}. For those files the usual "you were shown only the hunks" limit does not apply: read them before saying something is not visible, and cite line numbers from them.`);
  }
  if (parityContractApplies(action, changeType)) parts.push(PARITY_DIRECTIVE);
  if (action === 'score_risk') parts.push(`Defensible range for this change type: ${CHANGE_TYPE_RISK_BANDS[changeType]}. Leave it only for a reason you state in the second line.`);
  if (action === 'compare_task_intent') {
    parts.push(taskIntent ? `Task title: ${taskIntent.title}\nTask description: ${taskIntent.description}` : 'No task is linked to this review; say so and note that alignment cannot be judged.');
  }
  if (tier) parts.push(TIER_DIRECTIVES[tier], CONFIDENCE_DIRECTIVE);
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
const inFlightRequests = new Map<string, Promise<string>>();

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
  if (event.is_error) pending.reject(new Error(typeof event.result === 'string' && event.result.trim() ? event.result.trim() : 'AI review assist returned no answer.'));
  else if (typeof event.result !== 'string' || !event.result.trim()) pending.reject(new Error('AI review assist returned no answer.'));
  else pending.resolve(event.result.trim());
  // Retire the session rather than reusing it, so no decision's diff leaks
  // into the next reviewer question. The warm replacement was already started
  // when this worker was taken out of the pool.
  disposeWorker(worker, new Error('AI review assist worker retired after its turn.'));
  ensureWarmPool();
}

function startWorker(spend: AssistSpend = DEFAULT_SPEND, prime = true): AssistWorker {
  const child = spawn('claude', [
    '-p', '--verbose', '--model', spend.model, '--effort', spend.effort, '--tools', '',
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
  // A dedicated deep-tier session answers one question and is retired, so
  // priming it would buy a whole extra turn to save nothing.
  if (prime) writeTurn(worker, PRIME_PROMPT);
  else worker.primed = true;
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

function dispatchTurn(worker: AssistWorker, prompt: string, timeoutMs: number, onDelta?: (text: string) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pending: PendingTurn = { resolve, reject, timeout: null, onDelta };
    pending.timeout = setTimeout(() => {
      if (worker.active !== pending) return;
      worker.active = null;
      reject(new Error(`AI review assist timed out after ${timeoutMs / 1_000} seconds.`));
      disposeWorker(worker, new Error('AI review assist worker retired after a timeout.'));
      ensureWarmPool();
    }, timeoutMs);
    pending.timeout.unref();
    worker.active = pending;
    writeTurn(worker, prompt);
  });
}

async function runTurn(prompt: string, spend: AssistSpend, onDelta?: (text: string) => void): Promise<string> {
  if (spend !== DEFAULT_SPEND) {
    // The pool is haiku. Handing a deep tier a pooled session would return a
    // skim under the expensive tier's cache key, which is worse than not
    // offering the tier at all — so it gets its own session at its own model.
    // It starts cold, which is a rounding error against the turn it is buying,
    // and it still streams, so the reviewer is not left on a spinner.
    return dispatchTurn(startWorker(spend, false), prompt, spend.timeoutMs, onDelta);
  }
  const worker = takeWorker();
  try {
    await whenPrimed(worker);
  } catch {
    // The warm session died or never came up. A one-off process is slower but
    // still answers, and a genuine model failure still surfaces to the client.
    return runOneOffTurn(prompt, spend);
  }
  return dispatchTurn(worker, prompt, spend.timeoutMs, onDelta);
}

function runOneOffTurn(prompt: string, spend: AssistSpend): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', '--model', spend.model, '--effort', spend.effort, '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--no-session-persistence', '--no-chrome', '--system-prompt', CHANGES_AGENT_SYSTEM_PROMPT,
      '--output-format', 'json',
    ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`AI review assist timed out after ${spend.timeoutMs / 1_000} seconds.`));
    }, spend.timeoutMs);
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
/** Appends the deterministic checks to an answer before it is cached, so a
 * reviewer never has to take a cited line, a reassurance about code the model
 * could not see, or a claim of equivalence on trust. `score_risk` is
 * exempt: its two-line shape is a parsing contract with the client, and a third
 * line would break the badge. It asks for no citations anyway. */
function withAnswerAudits(action: ReviewAssistAction, decision: ReviewAssistDecision, answer: string): string {
  if (action === 'score_risk') return answer;
  const changeType = isReviewChangeType(decision.changeType) ? decision.changeType : 'behavior_edit';
  const supplied = [...decision.hunks, ...(decision.coverageEvidence?.hunks ?? []), ...(decision.referenceEvidence?.hunks ?? [])];
  // Ordered narrowest-claim-first: whether the cited lines exist, then whether
  // a reassurance about unseen code was earned, then whether the comparison was
  // complete. A reviewer reads the notes as an increasingly broad set of doubts.
  const notes = [
    citationAuditNote(auditCitations(answer, supplied)),
    referenceClaimNote(auditReferenceClaims(answer, decision.referenceEvidence), decision.referenceEvidence),
    parityContractApplies(action, changeType) ? parityAuditNote(auditParityTable(answer)) : null,
  ].filter((note): note is string => note !== null);
  return notes.length > 0 ? `${answer}\n\n${notes.join('\n')}` : answer;
}

export async function requestReviewAssist(
  database: WorkbenchDatabase,
  action: ReviewAssistAction,
  decision: ReviewAssistDecision,
  taskIntent: ReviewAssistTaskIntent,
  onDelta?: (text: string) => void,
  tier: ReviewAssistTier | null = null,
): Promise<string> {
  const hash = hashRequest(action, decision, taskIntent, tier);
  const cached = readCached(database, hash);
  if (cached) return cached;
  // Task and conversation scopes intentionally score the same diff at the
  // same time. Coalesce identical misses before either reaches Claude, or the
  // background scheduler doubles both spend and pool pressure.
  const existing = inFlightRequests.get(hash);
  if (existing) return existing;
  const request = (async () => {
    const raw = await runTurn(buildPrompt(action, decision, taskIntent, tier), spendFor(tier), onDelta);
    const answer = withAnswerAudits(action, decision, raw);
    writeCached(database, hash, answer);
    return answer;
  })();
  inFlightRequests.set(hash, request);
  try { return await request; }
  finally {
    if (inFlightRequests.get(hash) === request) inFlightRequests.delete(hash);
  }
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
