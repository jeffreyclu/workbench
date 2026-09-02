import { api } from '../../data/api.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { DiffHunkReviewState, UpsertDiffHunkReviewsInput } from '../../../shared/contracts.js';

// Prefixed so a review, a task and a conversation can never share a cache
// entry just because their ids collide.
export const workspaceDiffScopeKey = (scope: WorkspaceDiffScope) => {
  if ('workItemId' in scope) return `work-item:${scope.workItemId}`;
  if ('reviewId' in scope) return `review:${scope.reviewId}`;
  return `conversation:${scope.conversationId}`;
};

export const workspaceDiffQueryKeys = {
  detailPrefix: (scope: WorkspaceDiffScope) => ['workspace-diff', workspaceDiffScopeKey(scope)] as const,
  snapshotsPrefix: (scope: WorkspaceDiffScope) => ['workspace-diff-snapshots', workspaceDiffScopeKey(scope)] as const,
  hunkReviewsPrefix: (scope: WorkspaceDiffScope) => ['workspace-diff-hunk-reviews', workspaceDiffScopeKey(scope)] as const,
  detail: (scope: WorkspaceDiffScope, workspacePath: string | null) => ['workspace-diff', workspaceDiffScopeKey(scope), workspacePath] as const,
  snapshots: (scope: WorkspaceDiffScope, workspacePath: string | null) => ['workspace-diff-snapshots', workspaceDiffScopeKey(scope), workspacePath] as const,
  refs: (scope: WorkspaceDiffScope, workspacePath: string | null) => ['workspace-diff-refs', workspaceDiffScopeKey(scope), workspacePath] as const,
  refDiff: (scope: WorkspaceDiffScope, workspacePath: string | null, ref: string) => ['workspace-diff-ref', workspaceDiffScopeKey(scope), workspacePath, ref] as const,
  refCommits: (scope: WorkspaceDiffScope, workspacePath: string | null, ref: string) => ['workspace-diff-ref-commits', workspaceDiffScopeKey(scope), workspacePath, ref] as const,
  commitDiff: (scope: WorkspaceDiffScope, workspacePath: string | null, commit: string) => ['workspace-diff-commit', workspaceDiffScopeKey(scope), workspacePath, commit] as const,
  status: (scope: WorkspaceDiffScope, workspacePath: string | null, revision: string) => ['workspace-diff-status', workspaceDiffScopeKey(scope), workspacePath, revision] as const,
  fileSource: (scope: WorkspaceDiffScope, workspacePath: string | null, filePath: string, revision: string | null) => ['workspace-diff-file-source', workspaceDiffScopeKey(scope), workspacePath, filePath, revision] as const,
  hunkReviews: (scope: WorkspaceDiffScope, workspacePath: string | null, revision: string | undefined) => ['workspace-diff-hunk-reviews', workspaceDiffScopeKey(scope), workspacePath, revision] as const,
};

export const workspaceDiffData = {
  get: (scope: WorkspaceDiffScope, workspacePath: string | null) => api.getWorkspaceDiff(scope, workspacePath),
  getSnapshots: (scope: WorkspaceDiffScope, workspacePath: string | null) => api.getWorkspaceDiffSnapshots(scope, workspacePath),
  getRefs: (scope: WorkspaceDiffScope, workspacePath: string | null) => api.getWorkspaceRefs(scope, workspacePath),
  getRefDiff: (scope: WorkspaceDiffScope, workspacePath: string | null, ref: string) => api.getWorkspaceRefDiff(scope, workspacePath, ref),
  getRefCommits: (scope: WorkspaceDiffScope, workspacePath: string | null, ref: string | null) => api.getWorkspaceRefCommits(scope, workspacePath, ref),
  getCommitDiff: (scope: WorkspaceDiffScope, workspacePath: string | null, commit: string) => api.getWorkspaceCommitDiff(scope, workspacePath, commit),
  getStatus: (scope: WorkspaceDiffScope, workspacePath: string | null, revision: string) => api.getWorkspaceDiffStatus(scope, workspacePath, revision),
  getFileSource: (scope: WorkspaceDiffScope, workspacePath: string | null, filePath: string, revision: string | null) => api.getWorkspaceFileSource(scope, workspacePath, filePath, revision),
  getHunkReviews: (scope: WorkspaceDiffScope, revision: string) => api.getDiffHunkReviews(scope, revision),
  upsertHunkReview: (scope: WorkspaceDiffScope, input: { revision: string; filePath: string; hunkRange: string; state: DiffHunkReviewState; note?: string }) => api.upsertDiffHunkReview(scope, input),
  upsertHunkReviews: (scope: WorkspaceDiffScope, input: UpsertDiffHunkReviewsInput) => api.upsertDiffHunkReviews(scope, input),
};
