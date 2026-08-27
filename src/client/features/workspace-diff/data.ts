import { api } from '../../data/api.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';

const scopeKey = (scope: WorkspaceDiffScope) => ('workItemId' in scope ? scope.workItemId : scope.conversationId);

export const workspaceDiffQueryKeys = {
  detail: (scope: WorkspaceDiffScope) => ['workspace-diff', scopeKey(scope)] as const,
  snapshots: (scope: WorkspaceDiffScope) => ['workspace-diff-snapshots', scopeKey(scope)] as const,
  status: (scope: WorkspaceDiffScope, revision: string) => ['workspace-diff-status', scopeKey(scope), revision] as const,
  hunkReviews: (scope: WorkspaceDiffScope, revision: string | undefined) => ['workspace-diff-hunk-reviews', scopeKey(scope), revision] as const,
};

export const workspaceDiffData = {
  get: (scope: WorkspaceDiffScope) => api.getWorkspaceDiff(scope),
  getSnapshots: (scope: WorkspaceDiffScope) => api.getWorkspaceDiffSnapshots(scope),
  getStatus: (scope: WorkspaceDiffScope, revision: string) => api.getWorkspaceDiffStatus(scope, revision),
  commitAndPush: (scope: WorkspaceDiffScope, revision: string, message?: string) => api.commitAndPushWorkspace(scope, revision, message),
  getHunkReviews: (scope: WorkspaceDiffScope, revision: string) => api.getDiffHunkReviews(scope, revision),
  upsertHunkReview: (scope: WorkspaceDiffScope, input: { revision: string; filePath: string; hunkRange: string; state: DiffHunkReviewState; note?: string }) => api.upsertDiffHunkReview(scope, input),
};
