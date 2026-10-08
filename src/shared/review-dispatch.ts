/** Whether a completed execute run's change gets a review. `always` dispatches
 * one, `judgment` suggests one on the task, `never` records the skip. */
export type ReviewDispatchMode = 'always' | 'never' | 'judgment';

/** How deep that review should go. */
export type ReviewDepthTier = 'sensitive' | 'standard' | 'trivial';

export interface AgentRunReviewDispatch {
  mode: ReviewDispatchMode;
  tier: ReviewDepthTier;
  reason: string;
  /** Changed files the decision was made from. */
  files: string[];
  /** Added plus removed lines; null when no diff stats were available. */
  changedLines: number | null;
  /** The review run dispatched for an `always` decision, once it exists. */
  reviewRunId: string | null;
  decidedAt: string;
}

export function reviewDispatchLabel(dispatch: Pick<AgentRunReviewDispatch, 'mode' | 'tier' | 'reason'>): string {
  return `review: ${dispatch.mode} / ${dispatch.tier}, because ${dispatch.reason}`;
}
