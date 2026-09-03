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

/**
 * Which repository the server will answer from is shared selection state, not
 * a request parameter, so two repositories produce byte-identical URLs. Every
 * entry is therefore keyed by the selected checkout as well: without it,
 * picking a different repository in Repo Explorer keeps rendering the previous
 * repository's cached diff, history and files until a refetch happens to land.
 * The `*Prefix` keys stay repository-agnostic so an invalidation still reaches
 * every repository's entry.
 */
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

/** Every cache root that answers from the selected repository. Switching the
 * picker must evict all of them: between the selection landing on the server
 * and the explorer read reporting the new path, any refetch already in flight
 * answers from the new repository and would be stored under the previous
 * repository's key - the stale entry a later visit then renders. */
export const workspaceDiffQueryKeyRoots = [
  'workspace-diff',
  'workspace-diff-snapshots',
  'workspace-diff-refs',
  'workspace-diff-ref',
  'workspace-diff-ref-commits',
  'workspace-diff-commit',
  'workspace-diff-status',
  'workspace-diff-file-source',
  'workspace-diff-hunk-reviews',
] as const;

export const workspaceDiffScopeKeys = (scope: WorkspaceDiffScope) =>
  workspaceDiffQueryKeyRoots.map((root) => [root, workspaceDiffScopeKey(scope)] as const);

export const workspaceDiffData = {
  get: (scope: WorkspaceDiffScope) => api.getWorkspaceDiff(scope),
  getSnapshots: (scope: WorkspaceDiffScope) => api.getWorkspaceDiffSnapshots(scope),
  getRefs: (scope: WorkspaceDiffScope) => api.getWorkspaceRefs(scope),
  getRefDiff: (scope: WorkspaceDiffScope, ref: string) => api.getWorkspaceRefDiff(scope, ref),
  getRefCommits: (scope: WorkspaceDiffScope, ref: string | null) => api.getWorkspaceRefCommits(scope, ref),
  getCommitDiff: (scope: WorkspaceDiffScope, commit: string) => api.getWorkspaceCommitDiff(scope, commit),
  getStatus: (scope: WorkspaceDiffScope, revision: string) => api.getWorkspaceDiffStatus(scope, revision),
  getFileSource: (scope: WorkspaceDiffScope, filePath: string, revision: string | null) => api.getWorkspaceFileSource(scope, filePath, revision),
  getHunkReviews: (scope: WorkspaceDiffScope, revision: string) => api.getDiffHunkReviews(scope, revision),
  upsertHunkReview: (scope: WorkspaceDiffScope, input: { revision: string; filePath: string; hunkRange: string; state: DiffHunkReviewState; note?: string }) => api.upsertDiffHunkReview(scope, input),
  upsertHunkReviews: (scope: WorkspaceDiffScope, input: UpsertDiffHunkReviewsInput) => api.upsertDiffHunkReviews(scope, input),
};
