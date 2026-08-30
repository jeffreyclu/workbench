import type { ChangeMap } from '../../../shared/change-map.js';
import type { ReviewDecision } from '../../../shared/review-decisions.js';
import { blockObligations, type ReviewObligation } from './review-obligations.js';
import { blockRelationships, relationshipEscalation, warrantsRelationshipMap, type ReviewRelationships } from './review-relationships.js';
import { assistAnswersEscalationReason } from './review-escalation.js';
import { escalateRouting, escalateRoutingToStudy, routeReviewBlock, settleObligations, tierRank, type ReviewRouting, type ReviewTier } from './review-routing.js';
import type { ReviewBlockIdentity } from './review-blocks.js';
import type { BlockAnalysis } from './logic-blocks.js';

export interface ReviewQueueEntry {
  decision: ReviewDecision;
  /** Every block this entry covers. Usually one, but the shared builder groups
   * a change with the imports it needed and with its counterparts in other
   * files — one thought spread across hunks is still one queue position, and
   * judging it writes a row per block. Empty only for a patch that could not be
   * re-emitted at block level (binary, whole-file placeholder). */
  identities: ReviewBlockIdentity[];
  routing: ReviewRouting;
  /** The tier routing priced this block at before anything escalated it.
   * Assist answers are bought and cached per tier, and an escalation is read
   * back out of an answer bought at this tier — so a lookup that used the
   * escalated tier would miss the very answer that caused the escalation, drop
   * the block back to its old tier, and oscillate there forever. */
  assistTier: ReviewTier;
  obligations: ReviewObligation[];
  relationships: ReviewRelationships;
  /** Whether this block has earned the relationship map's cost. */
  showsMap: boolean;
  /** The compiler's reading of every block this entry covers, merged. Null
   * when none of them could be parsed. */
  analysis: BlockAnalysis | null;
}

/** An entry can cover several blocks, so its analysis is the worst of them: a
 * queue position is earned by the most dangerous thing standing at it, and the
 * hazards of all of them, because each is a separate question to answer. */
function mergeAnalysis(identities: ReviewBlockIdentity[]): BlockAnalysis | null {
  const found = identities.flatMap((identity) => (identity.analysis ? [identity.analysis] : []));
  if (found.length === 0) return null;
  const worst = found.reduce((left, right) => (right.score > left.score ? right : left));
  return {
    effect: worst.effect,
    score: worst.score,
    hazards: [...new Set(found.flatMap((analysis) => analysis.hazards))].sort(),
  };
}

/** Ranked by attention deserved, not by file order.
 *
 * Already-judged blocks sink, then auto-settled ones, so what is left at the
 * top is only what is still owed an answer. Within that, tier decides —
 * routing has already priced each block — and then the compiler's own score,
 * which is what a block costs to get wrong measured from the syntax rather than
 * from the router's rules. Relationship degree breaks what is left, because a
 * change other changes hang off is the one worth understanding first, and
 * source ordinal keeps every remaining tie stable across renders. */
function compareEntries(left: ReviewQueueEntry, right: ReviewQueueEntry): number {
  const judged = Number(left.decision.state !== null) - Number(right.decision.state !== null);
  if (judged !== 0) return judged;
  const settled = Number(left.routing.autoSettled) - Number(right.routing.autoSettled);
  if (settled !== 0) return settled;
  const tier = tierRank(right.routing.tier) - tierRank(left.routing.tier);
  if (tier !== 0) return tier;
  const score = (right.analysis?.score ?? 0) - (left.analysis?.score ?? 0);
  if (score !== 0) return score;
  const degree = right.relationships.degree - left.relationships.degree;
  if (degree !== 0) return degree;
  return left.decision.ordinal - right.decision.ordinal;
}

export function buildReviewQueue(
  decisions: ReviewDecision[],
  map: ChangeMap,
  blocks: Map<string, ReviewBlockIdentity>,
  /** Assist answers already paid for, by decision id. Only what the reviewer
   * has opened is ever in here; an empty map is the normal case and ranks
   * exactly as it did before tiered answers existed. */
  assistAnswers: ReadonlyMap<string, readonly (string | null | undefined)[]> = new Map(),
): ReviewQueueEntry[] {
  const entries = decisions.map((decision): ReviewQueueEntry => {
    const relationships = blockRelationships(map, decision.id);
    const identities = decision.hunks.flatMap((hunk) => { const identity = blocks.get(hunk.id); return identity ? [identity] : []; });
    const analysis = mergeAnalysis(identities);
    // Settled here as well as inside routing, because the entry is what the
    // reviewer reads: a question shown without its answer is the claim again.
    const obligations = settleObligations(blockObligations(decision), decision, analysis);
    let routing = routeReviewBlock(decision, obligations, analysis);
    const assistTier = routing.tier;
    // Discovering broader impact is the one thing routing cannot see from the
    // patch alone, so it is applied after the neighbourhood is known.
    const escalation = routing.autoSettled ? null : relationshipEscalation(relationships);
    if (escalation) routing = escalateRouting(routing, escalation);
    // Last, and it overrides the rest: every earlier step is a guess made from
    // the patch, while this one is a turn that actually read the block and
    // reported it could not settle it.
    const unconfident = routing.autoSettled ? null : assistAnswersEscalationReason(assistAnswers.get(decision.id) ?? []);
    if (unconfident) routing = escalateRoutingToStudy(routing, unconfident);
    return {
      decision, identities, routing, assistTier, obligations, relationships,
      showsMap: warrantsRelationshipMap(routing, relationships),
      analysis,
    };
  });
  return entries.sort(compareEntries);
}

/** The next block still owed an answer, skipping everything routing settled.
 * Falls back to the auto-settled tail only when nothing else is left, so
 * "advance" always moves rather than dead-ending. */
export function nextUnsettledBlockId(queue: ReviewQueueEntry[], currentId: string | null): string | null {
  const pending = queue.filter((entry) => entry.decision.state === null && !entry.routing.autoSettled);
  const index = pending.findIndex((entry) => entry.decision.id === currentId);
  const next = pending[index + 1] ?? pending.find((entry) => entry.decision.id !== currentId);
  if (next) return next.decision.id;
  return queue.find((entry) => entry.decision.state === null && entry.decision.id !== currentId)?.decision.id ?? null;
}

export interface ReviewQueueProgress {
  total: number;
  settled: number;
  judged: number;
  /** What is actually left for Jeffrey: unjudged, not auto-settled. */
  remaining: number;
  byTier: Record<string, number>;
}

export function reviewQueueProgress(queue: ReviewQueueEntry[]): ReviewQueueProgress {
  const byTier: Record<string, number> = {};
  let settled = 0;
  let judged = 0;
  for (const entry of queue) {
    byTier[entry.routing.tier] = (byTier[entry.routing.tier] ?? 0) + 1;
    if (entry.routing.autoSettled) settled += 1;
    if (entry.decision.state !== null) judged += 1;
  }
  const remaining = queue.filter((entry) => entry.decision.state === null && !entry.routing.autoSettled).length;
  return { total: queue.length, settled, judged, remaining, byTier };
}
