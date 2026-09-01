import { api } from '../../data/api.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { DiffHunkReviewState, UpsertDiffHunkReviewsInput } from '../../../shared/contracts.js';

// Prefixed so a review, a task and a conversation can never share a cache
// entry just because their ids collide.
export const workspaceDiffScopeKey = (scope: WorkspaceDiffScope) => {
  if ('workItemId' in scope) return `work-item:${scope.workItemId}`;
  return `conversation:${scope.conversationId}`;
};

export const workspaceDiffQueryKeys = {
  detail: (scope: WorkspaceDiffScope) => ['workspace-diff', workspaceDiffScopeKey(scope)] as const,
  snapshots: (scope: WorkspaceDiffScope) => ['workspace-diff-snapshots', workspaceDiffScopeKey(scope)] as const,
  refs: (scope: WorkspaceDiffScope) => ['workspace-diff-refs', workspaceDiffScopeKey(scope)] as const,
  refDiff: (scope: WorkspaceDiffScope, ref: string) => ['workspace-diff-ref', workspaceDiffScopeKey(scope), ref] as const,
  refCommits: (scope: WorkspaceDiffScope, ref: string) => ['workspace-diff-ref-commits', workspaceDiffScopeKey(scope), ref] as const,
  commitDiff: (scope: WorkspaceDiffScope, commit: string) => ['workspace-diff-commit', workspaceDiffScopeKey(scope), commit] as const,
  status: (scope: WorkspaceDiffScope, revision: string) => ['workspace-diff-status', workspaceDiffScopeKey(scope), revision] as const,
  hunkReviews: (scope: WorkspaceDiffScope, revision: string | undefined) => ['workspace-diff-hunk-reviews', workspaceDiffScopeKey(scope), revision] as const,
};

export const workspaceDiffData = {
  get: (scope: WorkspaceDiffScope) => api.getWorkspaceDiff(scope),
  getSnapshots: (scope: WorkspaceDiffScope) => api.getWorkspaceDiffSnapshots(scope),
  getRefs: (scope: WorkspaceDiffScope) => api.getWorkspaceRefs(scope),
  getRefDiff: (scope: WorkspaceDiffScope, ref: string) => api.getWorkspaceRefDiff(scope, ref),
  getRefCommits: (scope: WorkspaceDiffScope, ref: string) => api.getWorkspaceRefCommits(scope, ref),
  getCommitDiff: (scope: WorkspaceDiffScope, commit: string) => api.getWorkspaceCommitDiff(scope, commit),
  getStatus: (scope: WorkspaceDiffScope, revision: string) => api.getWorkspaceDiffStatus(scope, revision),
  getHunkReviews: (scope: WorkspaceDiffScope, revision: string) => api.getDiffHunkReviews(scope, revision),
  upsertHunkReview: (scope: WorkspaceDiffScope, input: { revision: string; filePath: string; hunkRange: string; state: DiffHunkReviewState; note?: string }) => api.upsertDiffHunkReview(scope, input),
  upsertHunkReviews: (scope: WorkspaceDiffScope, input: UpsertDiffHunkReviewsInput) => api.upsertDiffHunkReviews(scope, input),
};
