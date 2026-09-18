import { buildChangeMap, type ChangeMap } from './change-map.js';
import type { DiffHunkReview, WorkspaceDiffFile } from './contracts.js';
import { buildReviewDecisions, type ReviewDecision } from './review-decisions.js';
import { isDependencyLockfilePath } from './change-type.js';
import { isDelegatedTier, delegationAutoReviews, type DelegationTarget } from './review-delegation.js';
import { blockObligations } from './review-obligations.js';
import { routeReviewBlock, tierRank, type ReviewRouting, type ReviewTier } from './review-routing.js';

/** The model-backed fields the Review Director prepares before Jeffrey opens a
 * critical decision. The deterministic heuristic is already derived from the
 * decision itself and therefore needs no model action or second data store. */
export const REVIEW_DIRECTOR_CRITICAL_ACTIONS = ['score_risk', 'explain', 'what_could_break', 'compare_task_intent'] as const;
export type ReviewDirectorCriticalAction = typeof REVIEW_DIRECTOR_CRITICAL_ACTIONS[number];

export interface ReviewDirectorEntry {
  decision: ReviewDecision;
  routing: ReviewRouting;
  tier: ReviewTier;
  delegated: boolean;
  autoReview: boolean;
  critical: boolean;
  /** Populated for critical decisions. The caller may omit task comparison
   * when no linked task exists, but must prepare every other field. */
  enrichmentActions: readonly ReviewDirectorCriticalAction[];
  relationshipCount: number;
}

export interface ReviewDirectorPlan {
  decisions: ReviewDecision[];
  changeMap: ChangeMap;
  entries: ReviewDirectorEntry[];
  orderedDecisions: ReviewDecision[];
  byDecisionId: ReadonlyMap<string, ReviewDirectorEntry>;
  delegationTargets: DelegationTarget[];
  criticalDecisionIds: ReadonlySet<string>;
}

const REVIEW_STATE_ORDER: Record<NonNullable<ReviewDecision['state']>, number> = {
  needs_changes: 1,
  commented: 2,
  reviewed: 3,
};

/**
 * One authority for the complete review queue.
 *
 * It creates the decisions, prices each one, makes test-only work a low-priority
 * delegated review rather than a blind settlement, ranks production risk ahead
 * of graph complexity, and declares which decisions need full enrichment.
 */
export function createReviewDirectorPlan(files: WorkspaceDiffFile[], reviews: DiffHunkReview[]): ReviewDirectorPlan {
  const decisions = buildReviewDecisions(files, reviews);
  const changeMap = buildChangeMap(decisions);
  const nodes = new Map(changeMap.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, number>();
  for (const edge of changeMap.edges) outgoing.set(edge.fromId, (outgoing.get(edge.fromId) ?? 0) + 1);

  const entries = decisions.map((decision): ReviewDirectorEntry => {
    const routing = routeReviewBlock(decision, blockObligations(decision));
    const delegated = isDelegatedTier(routing.tier);
    const critical = routing.tier === 'T3';
    return {
      decision,
      routing,
      tier: routing.tier,
      delegated,
      autoReview: delegated && delegationAutoReviews(routing.tier),
      critical,
      enrichmentActions: critical ? REVIEW_DIRECTOR_CRITICAL_ACTIONS : [],
      relationshipCount: nodes.get(decision.id)?.degree ?? 0,
    };
  });

  const orderedEntries = [...entries].sort((left, right) => {
    const leftState = left.decision.state ? REVIEW_STATE_ORDER[left.decision.state] : 0;
    const rightState = right.decision.state ? REVIEW_STATE_ORDER[right.decision.state] : 0;
    if (leftState !== rightState) return leftState - rightState;

    const settled = Number(left.routing.autoSettled) - Number(right.routing.autoSettled);
    if (settled !== 0) return settled;

    // Lockfiles are generated dependency bookkeeping: one delegated decision
    // per file, always after source and tests rather than mixed into either.
    const lockfilePriority = Number(left.decision.filePaths.every(isDependencyLockfilePath)) - Number(right.decision.filePaths.every(isDependencyLockfilePath));
    if (lockfilePriority !== 0) return lockfilePriority;

    // Tests are reviewed automatically after production code, even when their
    // generic delegated tier matches a production decision's tier.
    const testPriority = Number(left.decision.changeType === 'test_only') - Number(right.decision.changeType === 'test_only');
    if (testPriority !== 0) return testPriority;

    const tier = tierRank(right.tier) - tierRank(left.tier);
    if (tier !== 0) return tier;
    const relationships = right.relationshipCount - left.relationshipCount;
    if (relationships !== 0) return relationships;
    const declarations = (outgoing.get(right.decision.id) ?? 0) - (outgoing.get(left.decision.id) ?? 0);
    if (declarations !== 0) return declarations;
    return left.decision.ordinal - right.decision.ordinal;
  });

  const byDecisionId = new Map(entries.map((entry) => [entry.decision.id, entry]));
  return {
    decisions,
    changeMap,
    entries,
    orderedDecisions: orderedEntries.map((entry) => entry.decision),
    byDecisionId,
    delegationTargets: orderedEntries.flatMap((entry) => (
      entry.decision.state === null && entry.delegated
        ? [{ decisionId: entry.decision.id, decision: entry.decision, tier: entry.tier }]
        : []
    )),
    criticalDecisionIds: new Set(entries.filter((entry) => entry.critical).map((entry) => entry.decision.id)),
  };
}

/**
 * Keep decisions claimed by the running delegated sweep behind work that still
 * needs the reviewer. This is a stable partition: the Director's risk order is
 * preserved inside both groups, and a failed/answered turn returns to its
 * normal priority as soon as it is no longer claimed.
 */
export function deferDelegatedReviewDecisions(
  decisions: readonly ReviewDecision[],
  pendingDelegation: ReadonlySet<string>,
): ReviewDecision[] {
  if (pendingDelegation.size === 0) return [...decisions];
  return [
    ...decisions.filter((decision) => !pendingDelegation.has(decision.id)),
    ...decisions.filter((decision) => pendingDelegation.has(decision.id)),
  ];
}

/** Advance in the Director's priority order, skipping proof-settled work. */
export function nextReviewDirectorDecisionId(
  plan: ReviewDirectorPlan,
  currentId: string,
  pendingDelegation: ReadonlySet<string> = new Set(),
): string | null {
  const orderedDecisions = deferDelegatedReviewDecisions(plan.orderedDecisions, pendingDelegation);
  const pending = plan.entries
    .filter((entry) => entry.decision.state === null && !entry.routing.autoSettled)
    .sort((left, right) => orderedDecisions.indexOf(left.decision) - orderedDecisions.indexOf(right.decision));
  const currentIndex = pending.findIndex((entry) => entry.decision.id === currentId);
  const next = pending[currentIndex + 1] ?? pending.find((entry) => entry.decision.id !== currentId);
  return next?.decision.id
    ?? orderedDecisions.find((decision) => decision.id !== currentId)?.id
    ?? null;
}
