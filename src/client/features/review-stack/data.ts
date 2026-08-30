import { api } from '../../data/api.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { UpsertDiffBlockReviewInput } from '../../../shared/contracts.js';

const scopeKey = (scope: WorkspaceDiffScope) => ('workItemId' in scope ? scope.workItemId : scope.conversationId);

/** Review's query keys are its own. Sharing a key with the Changes view would
 * make one surface's invalidation refetch — and re-render — the other. */
export const reviewStackQueryKeys = {
  blockReviews: (scope: WorkspaceDiffScope, revision: string | undefined) => ['review-stack-block-reviews', scopeKey(scope), revision] as const,
};

export const reviewStackData = {
  getBlockReviews: (scope: WorkspaceDiffScope, revision: string) => api.getDiffBlockReviews(scope, revision),
  upsertBlockReview: (scope: WorkspaceDiffScope, input: UpsertDiffBlockReviewInput) => api.upsertDiffBlockReview(scope, input),
};
