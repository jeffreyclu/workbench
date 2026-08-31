import { LOGIC_HAZARD_REASONS, LOGIC_HAZARD_WEIGHT, isLogicHazard, type LogicHazardName } from '../../../shared/contracts.js';
import type { ReviewDecision } from '../../../shared/review-decisions.js';
import type { BlockAnalysis } from './logic-blocks.js';
import { heaviestObligation, type ReviewObligation } from './review-obligations.js';

/** The attention a block is routed to.
 *
 * The tiers are a spending decision, not a severity label: T0 costs nothing,
 * T1 buys a bounded model turn, and only T2/T3 are allowed to cost Jeffrey's
 * reading time — or the relationship map's analysis and render budget. */
export const REVIEW_TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
export type ReviewTier = typeof REVIEW_TIERS[number];

export const REVIEW_TIER_LABELS: Record<ReviewTier, string> = {
  T0: 'Automatic', T1: 'Delegated', T2: 'Read', T3: 'Study',
};

/** What routing needs to know about the review a block sits in. */
export interface ReviewRoutingContext {
  /** True when every change in the review is test code, which is the one case
   * where a test edit has no production block to be judged alongside. */
  reviewIsTestOnly: boolean;
}

export interface ReviewRouting {
  tier: ReviewTier;
  /** Why this tier, in the reviewer's words. A queue that sorts without
   * saying why is a black box, and a black box gets overridden or ignored. */
  reason: string;
  /** T0 only: settled by proof, collapsed out of the way, still reachable. */
  autoSettled: boolean;
}

/** At or above this weight, a hazard is what Jeffrey opens the diff for: a
 * guard that stopped rejecting input, or a failure that stopped being
 * reported. Nothing lighter earns study — the compiler found it, said what it
 * was, and a delegated turn can answer it. */
const HAZARD_STUDY_WEIGHT = 10;

/** Between this and study, a hazard is read but not studied. Below it — a
 * moved boundary, a changed loop bound, an extra return — the hazard is real
 * and still leaves T0, but it is a bounded question, so it is delegated. */
const HAZARD_READ_WEIGHT = 7;

/** The costliest hazard the compiler put on a block, or null when it found
 * none. Unknown names are skipped rather than trusted: a hazard this bundle
 * does not know is a newer server, and weighing it would be a guess. */
export function gravestHazard(hazards: readonly string[]): LogicHazardName | null {
  let worst: LogicHazardName | null = null;
  for (const hazard of hazards) {
    if (!isLogicHazard(hazard)) continue;
    if (worst === null || LOGIC_HAZARD_WEIGHT[hazard] > LOGIC_HAZARD_WEIGHT[worst]) worst = hazard;
  }
  return worst;
}

/** What the compiler reads when nothing in the block executes. Both effects
 * weigh zero because the type checker has already proved them, so no quantity
 * of them adds up to a question worth asking a person. */
const NON_RUNNING_EFFECTS = new Set(['declaration', 'literal']);

/** True only when the compiler read the block and found nothing that runs. A
 * null analysis proves nothing — an unparsed file routes on text exactly as it
 * did before the parser existed. The score is checked as well as the effect so
 * that a hazard, which always carries weight, can never be routed away here. */
function readsAsNonRunning(analysis: BlockAnalysis | null): boolean {
  return analysis !== null && analysis.score === 0 && NON_RUNNING_EFFECTS.has(analysis.effect);
}

/** Bigger than this is not one thought regardless of what it touches. Set
 * where a block stops being skimmable rather than where it stops being small:
 * size is length, not risk, and a queue that studied every long block spent
 * Jeffrey's day on the diff's shape instead of its dangers. */
const STUDY_CHANGED_LINES = 150;
/** A human question on a block smaller than this is delegated rather than
 * read. The question is still owed an answer; it is not owed *his* answer
 * until there is enough code under it to be worth the interruption. */
const READ_CHANGED_LINES = 30;
/** Under this, a proof-settled block is small enough that reading it costs
 * less than arguing with the router about it. */
const TRIVIAL_CHANGED_LINES = 200;

function changedLines(decision: Pick<ReviewDecision, 'additions' | 'deletions'>): number {
  return decision.additions + decision.deletions;
}

function changedCode(decision: Pick<ReviewDecision, 'hunks'>): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const hunk of decision.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
      else if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
    }
  }
  return { added, removed };
}

export function isImportOnlyChange(decision: Pick<ReviewDecision, 'hunks'>): boolean {
  const { added, removed } = changedCode(decision);
  const lines = [...added, ...removed].map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^(?:import\b|export\s+(?:\*|\{)|from\s|['"][^'"]+['"];?$|\}\s*from\b)/.test(line));
}

/** Same code, different whitespace. Compared with all whitespace removed
 * rather than trimmed, so re-indentation and re-wrapping both settle. */
export function isFormattingOnlyChange(decision: Pick<ReviewDecision, 'hunks'>): boolean {
  const { added, removed } = changedCode(decision);
  if (added.length === 0 && removed.length === 0) return false;
  const squeeze = (lines: string[]) => lines.join('').replace(/\s+/g, '');
  return squeeze(added) === squeeze(removed);
}

/** Content that moved without changing: the multiset of code lines is equal on
 * both sides, so nothing was rewritten on the way. */
export function isPureRelocation(decision: Pick<ReviewDecision, 'hunks'>): boolean {
  const { added, removed } = changedCode(decision);
  if (added.length === 0 || added.length !== removed.length) return false;
  const normalise = (lines: string[]) => [...lines].map((line) => line.trim()).sort().join('\n');
  return normalise(added) === normalise(removed);
}

const GENERATED_PATH = /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.snap|\.min\.(?:js|css)|^dist\/|\/dist\/|^build\/|\/build\/|\.generated\.)/;

export function isGeneratedOutput(decision: Pick<ReviewDecision, 'filePaths'>): boolean {
  return decision.filePaths.length > 0 && decision.filePaths.every((path) => GENERATED_PATH.test(path));
}

/** The checks a `proof` obligation claims already exist.
 *
 * `settledBy: 'proof'` means the patch itself answers the question — and the
 * router spends T0 on that promise. Until something runs the check, though,
 * the promise is only the change type's word for it: a `move_rename` that
 * rewrites the code as it moves, or a `docs_comment` block carrying real
 * statements, is auto-settled on a claim nobody tested. These are the three
 * claims that can be checked from the patch and the compiler's reading;
 * everything else is left unresolved rather than asserted. */
const OBLIGATION_PROOFS: Record<
  string,
  (decision: ReviewDecision, analysis: BlockAnalysis | null) => Pick<ReviewObligation, 'outcome' | 'evidence'> | null
> = {
  move_identical: (decision) => (isPureRelocation(decision)
    ? { outcome: 'proven', evidence: 'Every added line appears among the removed ones once whitespace is normalised.' }
    : { outcome: 'failed', evidence: 'The content was rewritten as it moved, so the move is not the whole change.' }),
  docs_accurate: (_decision, analysis) => {
    // A null analysis proves nothing in either direction — the file did not
    // parse, and guessing from text is exactly what this replaces.
    if (analysis === null) return null;
    return readsAsNonRunning(analysis)
      ? { outcome: 'proven', evidence: 'The compiler read nothing that runs here, so the prose stands beside unchanged behaviour.' }
      : { outcome: 'failed', evidence: 'The compiler read executable code in a block classified as prose.' };
  },
  // Only the affirmative half is checkable: paths that are not generated
  // artefacts leave the question open rather than answering it "no".
  generated_source: (decision) => (isGeneratedOutput(decision)
    ? { outcome: 'proven', evidence: 'Every path in this block is a generated artefact.' }
    : null),
};

/** Run the checks, recording what answered each question. Pure and idempotent:
 * re-settling an already-settled obligation reaches the same conclusion, and an
 * obligation nothing can check routes exactly as it did before outcomes
 * existed. `ai` and `human` obligations are never touched — they are owed a
 * turn or Jeffrey, and claiming otherwise here would be the same defect. */
export function settleObligations(
  obligations: readonly ReviewObligation[],
  decision: ReviewDecision,
  analysis: BlockAnalysis | null = null,
): ReviewObligation[] {
  return obligations.map((obligation) => {
    if (obligation.settledBy !== 'proof') return obligation;
    const settled = OBLIGATION_PROOFS[obligation.id]?.(decision, analysis);
    return settled ? { ...obligation, ...settled } : obligation;
  });
}

/** Route a block to the attention it deserves, deterministically. No model is
 * consulted here: routing decides whether a model is consulted at all. */
export function routeReviewBlock(
  decision: ReviewDecision,
  obligations: ReviewObligation[],
  /** What the compiler read inside the block. Null whenever the file could not
   * be parsed, which is the ordinary case and routes exactly as before. */
  analysis: BlockAnalysis | null = null,
  /** What the rest of the review looks like. Routing is otherwise a per-block
   * decision, but one question genuinely needs the whole change set: a test
   * edit is only interesting when the tests are the change. */
  context: ReviewRoutingContext = { reviewIsTestOnly: false },
): ReviewRouting {
  if (isGeneratedOutput(decision)) return { tier: 'T0', reason: 'Generated output — review its source, not this.', autoSettled: true };
  if (isFormattingOnlyChange(decision)) return { tier: 'T0', reason: 'Whitespace only — the code is byte-identical.', autoSettled: true };
  if (isImportOnlyChange(decision)) return { tier: 'T0', reason: 'Imports only — the compiler proves this one.', autoSettled: true };
  if (decision.changeType === 'move_rename' && isPureRelocation(decision)) {
    return { tier: 'T0', reason: 'Moved unchanged — every line survives on both sides.', autoSettled: true };
  }

  // Tests ship to nobody. Beside a production change they are the evidence for
  // it, and the block that changed the behaviour is where that evidence is
  // judged — reading the assertions separately is the same review twice. A
  // review that is *only* tests has no such block, so there the tests are the
  // change and route on their own merits.
  if (decision.changeType === 'test_only' && !context.reviewIsTestOnly) {
    return { tier: 'T0', reason: 'Test-only — judged with the production change it covers.', autoSettled: true };
  }

  // Above every heuristic below, and below every proof above. The four rules
  // already passed are proofs that the code did not change; a hazard is a proof
  // read off the AST that it did, so it outranks obligations guessed from text.
  const hazard = gravestHazard(analysis?.hazards ?? []);
  if (hazard) {
    const weight = LOGIC_HAZARD_WEIGHT[hazard];
    return {
      tier: weight >= HAZARD_STUDY_WEIGHT ? 'T3' : weight >= HAZARD_READ_WEIGHT ? 'T2' : 'T1',
      reason: LOGIC_HAZARD_REASONS[hazard],
      autoSettled: false,
    };
  }

  const settled = settleObligations(obligations, decision, analysis);
  const heaviest = heaviestObligation(settled);
  const size = changedLines(decision);
  if (heaviest === 'proof') {
    // This branch is the one place a label alone buys T0. A proof obligation
    // the patch actively contradicts is the opposite of a settled block, so it
    // is read rather than collapsed out of the way.
    const disproved = settled.find((obligation) => obligation.outcome === 'failed');
    if (disproved) return { tier: 'T2', reason: disproved.evidence ?? disproved.question, autoSettled: false };
    return size <= TRIVIAL_CHANGED_LINES
      ? { tier: 'T0', reason: 'Settled by the patch itself.', autoSettled: true }
      : { tier: 'T1', reason: 'Proof-settled, but large enough to skim.', autoSettled: false };
  }
  if (heaviest === 'ai') {
    return { tier: 'T1', reason: 'Bounded question — delegated.', autoSettled: false };
  }

  // Every rule below is guessed from the patch text: `public_api` fires on the
  // word `export`, `error_path` on the word `error` in a comment, and size is
  // length rather than risk. Once the compiler has read the block and found
  // nothing that runs, those guesses are describing text rather than behaviour
  // — a pure `export interface` would otherwise buy the same study as a
  // rewritten auth check. The proof outranks the guess, so a non-running block
  // is skimmed and never costs Jeffrey's reading time.
  if (readsAsNonRunning(analysis)) {
    return { tier: 'T1', reason: 'Nothing here runs — types and literals the compiler already checks.', autoSettled: false };
  }

  // Two signals, not three. `auth` and `persistence` name damage that outlives
  // the deploy — a request let through, a database migrated wrong. `public_api`
  // used to sit here and fired on the word `export`, which in this codebase is
  // most of the diff: it made study the default and the default is what buried
  // the real ones.
  const humanObligations = obligations.filter((obligation) => obligation.settledBy === 'human');
  const gravest = decision.riskSignals.filter((signal) => signal === 'auth' || signal === 'persistence');
  if (gravest.length > 0) return { tier: 'T3', reason: `Costly to get wrong: ${gravest.join(', ')}.`, autoSettled: false };
  if (size > STUDY_CHANGED_LINES) return { tier: 'T3', reason: 'Large enough that reading it is the work.', autoSettled: false };
  // A human obligation is a question nothing in the patch can answer. That
  // makes it worth asking — but on a small block, asking a model first and
  // showing Jeffrey the answer costs him a glance instead of a read.
  if (humanObligations.length > 0 && size > READ_CHANGED_LINES) {
    return { tier: 'T2', reason: humanObligations[0]!.question, autoSettled: false };
  }
  return { tier: 'T1', reason: humanObligations[0]?.question ?? 'Bounded enough to delegate.', autoSettled: false };
}

/** A lower-tier block that turned out to reach further than it looked. The
 * escalated block gains the map; nothing else about the queue moves. */
export function escalateRouting(routing: ReviewRouting, reason: string): ReviewRouting {
  const tier: ReviewTier = routing.tier === 'T3' ? 'T3' : routing.tier === 'T2' ? 'T3' : 'T2';
  return { tier, reason, autoSettled: false };
}

/** The model was asked and answered that it could not tell. This goes
 * straight to study rather than one step up: a cheaper turn has already been
 * bought and came back short, so the next thing that can settle the block is
 * a person reading it. */
export function escalateRoutingToStudy(routing: ReviewRouting, reason: string): ReviewRouting {
  return { tier: 'T3', reason, autoSettled: false };
}

/** How many blocks one review is allowed to cost Jeffrey.
 *
 * Routing says which changes are risky; this says how many of them he actually
 * opens. The two are not the same problem. A 300-file branch can contain forty
 * defensible "read this" cards, and a queue that hands back forty is a queue
 * nobody finishes — an unfinished queue reviews nothing, while the three that
 * mattered sit unread at position thirty. Twelve is one sitting. Everything
 * past it is delegated, not dropped: the turn is still bought and the answer is
 * still there when he goes looking. */
export const HUMAN_REVIEW_BUDGET = 12;

/** How dangerous a block is next to the others in the same review.
 *
 * This never chooses a tier. It only orders the blocks routing already sent to
 * a human against each other, so that when there are more of them than there
 * are seats, the seats go to the worst ones rather than to whichever files the
 * diff happened to list first. */
export function blockReviewRisk(
  routing: ReviewRouting,
  decision: Pick<ReviewDecision, 'riskSignals' | 'additions' | 'deletions'>,
  analysis: BlockAnalysis | null = null,
): number {
  if (routing.autoSettled) return 0;
  const hazard = gravestHazard(analysis?.hazards ?? []);
  const signals = decision.riskSignals.reduce((total, signal) => total + (RISK_SIGNAL_WEIGHT[signal] ?? 0), 0);
  return tierRank(routing.tier) * 100
    + (hazard ? LOGIC_HAZARD_WEIGHT[hazard] * 20 : 0)
    + signals
    + Math.min(analysis?.score ?? 0, 100)
    + Math.min(changedLines(decision), 400) / 10;
}

/** What each signal is worth when the seats are being handed out. `auth` and
 * `persistence` outrank the rest by the same logic that lets them reach study
 * at all: they name damage that survives the deploy. */
const RISK_SIGNAL_WEIGHT: Record<string, number> = {
  auth: 60, persistence: 55, public_api: 15, cross_file: 10, error_path: 10,
};

export function tierRank(tier: ReviewTier): number {
  return REVIEW_TIERS.indexOf(tier);
}
