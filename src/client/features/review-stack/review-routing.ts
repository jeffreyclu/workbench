import type { ReviewDecision } from '../../../shared/review-decisions.js';
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

export interface ReviewRouting {
  tier: ReviewTier;
  /** Why this tier, in the reviewer's words. A queue that sorts without
   * saying why is a black box, and a black box gets overridden or ignored. */
  reason: string;
  /** T0 only: settled by proof, collapsed out of the way, still reachable. */
  autoSettled: boolean;
}

/** Bigger than this is not one thought regardless of what it touches. */
const STUDY_CHANGED_LINES = 40;
/** Under this, a proof-settled block is small enough that reading it costs
 * less than arguing with the router about it. */
const TRIVIAL_CHANGED_LINES = 60;

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

/** Route a block to the attention it deserves, deterministically. No model is
 * consulted here: routing decides whether a model is consulted at all. */
export function routeReviewBlock(decision: ReviewDecision, obligations: ReviewObligation[]): ReviewRouting {
  if (isGeneratedOutput(decision)) return { tier: 'T0', reason: 'Generated output — review its source, not this.', autoSettled: true };
  if (isFormattingOnlyChange(decision)) return { tier: 'T0', reason: 'Whitespace only — the code is byte-identical.', autoSettled: true };
  if (isImportOnlyChange(decision)) return { tier: 'T0', reason: 'Imports only — the compiler proves this one.', autoSettled: true };
  if (decision.changeType === 'move_rename' && isPureRelocation(decision)) {
    return { tier: 'T0', reason: 'Moved unchanged — every line survives on both sides.', autoSettled: true };
  }

  const heaviest = heaviestObligation(obligations);
  const size = changedLines(decision);
  if (heaviest === 'proof') {
    return size <= TRIVIAL_CHANGED_LINES
      ? { tier: 'T0', reason: 'Settled by the patch itself.', autoSettled: true }
      : { tier: 'T1', reason: 'Proof-settled, but large enough to skim.', autoSettled: false };
  }
  if (heaviest === 'ai') {
    return { tier: 'T1', reason: 'Bounded question — delegated.', autoSettled: false };
  }

  const humanObligations = obligations.filter((obligation) => obligation.settledBy === 'human');
  const gravest = decision.riskSignals.filter((signal) => signal === 'auth' || signal === 'persistence' || signal === 'public_api');
  if (gravest.length > 0) return { tier: 'T3', reason: `Costly to get wrong: ${gravest.join(', ')}.`, autoSettled: false };
  if (humanObligations.length > 1) return { tier: 'T3', reason: 'Several independent things to be sure of.', autoSettled: false };
  if (size > STUDY_CHANGED_LINES) return { tier: 'T3', reason: 'Large enough that reading it is the work.', autoSettled: false };
  return { tier: 'T2', reason: humanObligations[0]?.question ?? 'Needs a judgment call.', autoSettled: false };
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

export function tierRank(tier: ReviewTier): number {
  return REVIEW_TIERS.indexOf(tier);
}
