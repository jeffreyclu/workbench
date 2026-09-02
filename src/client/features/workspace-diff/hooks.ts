import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { conversationClient } from '../../data/conversation-client.js';
import { sourceClient } from '../../data/source-client.js';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';
import { workspaceDiffData, workspaceDiffQueryKeys } from './data.js';

export const workspaceExplorerQueryKey = (scope: WorkspaceDiffScope | null) =>
  scope && 'conversationId' in scope
    ? ['conversation-workspaces', scope.conversationId] as const
    : ['work-item-workspaces', scope && 'workItemId' in scope ? scope.workItemId : null] as const;

export function useWorkspaceExplorer(scope: WorkspaceDiffScope | null, isRunning = false) {
  const conversationId = scope && 'conversationId' in scope ? scope.conversationId : null;
  const workItemId = scope && 'workItemId' in scope ? scope.workItemId : null;
  return useQuery({
    queryKey: workspaceExplorerQueryKey(scope),
    queryFn: () => conversationId
      ? conversationClient.getConversationWorkspaces(conversationId)
      : sourceClient.getWorkItemWorkspaces(workItemId!),
    enabled: Boolean(conversationId || workItemId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: isRunning ? 2_000 : false,
  });
}

const canReadWorkspace = (scope: WorkspaceDiffScope | null, workspacePath: string | null) =>
  Boolean(scope) && (Boolean(workspacePath) || Boolean(scope && 'reviewId' in scope));

export function useWorkspaceDiff(scope: WorkspaceDiffScope | null, workspacePath: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.detail(scope ?? { workItemId: '' }, workspacePath),
    queryFn: () => workspaceDiffData.get(scope!, workspacePath),
    enabled: canReadWorkspace(scope, workspacePath),
    // The open diff is a stable reading snapshot. A status poll may advertise
    // a newer revision, but only the explicit Refresh action replaces it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useWorkspaceDiffChanges(scope: WorkspaceDiffScope, workspacePath: string | null, revision: string | undefined, isRunning: boolean) {
  const status = useQuery({
    queryKey: workspaceDiffQueryKeys.status(scope, workspacePath, revision ?? ''),
    queryFn: () => workspaceDiffData.getStatus(scope, workspacePath, revision!),
    enabled: Boolean(revision) && canReadWorkspace(scope, workspacePath) && isRunning,
    refetchInterval: isRunning ? 1_500 : false,
    select: ({ changed }) => changed,
  });
  return status.data ?? false;
}

export function useWorkspaceDiffSnapshots(scope: WorkspaceDiffScope | null, workspacePath: string | null, revision: string | undefined) {
  const query = useQuery({
    queryKey: workspaceDiffQueryKeys.snapshots(scope ?? { workItemId: '' }, workspacePath),
    queryFn: () => workspaceDiffData.getSnapshots(scope!, workspacePath),
    enabled: canReadWorkspace(scope, workspacePath),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  const refetch = query.refetch;
  // The current-diff route writes its immutable record before replying. Fetch
  // again when that revision arrives so a racing initial timeline request does
  // not omit the just-captured version. This stays a refetch rather than part
  // of the key: the timeline already loaded is still this repository's, and
  // dropping it would blank the History control every time the diff moves.
  useEffect(() => {
    if (revision) void refetch();
  }, [revision, refetch]);
  return query;
}

/** Branches and worktrees available to review. Cheap enough to keep warm, but
 * it walks refs, so it is not on the diff's own refetch-always path. */
export function useWorkspaceRefs(scope: WorkspaceDiffScope | null, workspacePath: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refs(scope ?? { workItemId: '' }, workspacePath),
    queryFn: () => workspaceDiffData.getRefs(scope!, workspacePath),
    enabled: canReadWorkspace(scope, workspacePath),
    staleTime: 30_000,
  });
}

/** The diff for one selected branch or worktree. Only the selected ref is ever
 * fetched — enumerating every branch's patch would be the expensive mistake. */
export function useWorkspaceRefDiff(scope: WorkspaceDiffScope | null, workspacePath: string | null, ref: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refDiff(scope ?? { workItemId: '' }, workspacePath, ref ?? ''),
    queryFn: () => workspaceDiffData.getRefDiff(scope!, workspacePath, ref!),
    enabled: Boolean(ref) && canReadWorkspace(scope, workspacePath),
    staleTime: 0,
  });
}


/** The commits behind a branch, and one commit read on its own. Both are
 * asked for only once a branch is actually selected: a review that never
 * leaves the whole-branch reading pays for neither. */
export function useWorkspaceRefCommits(scope: WorkspaceDiffScope | null, workspacePath: string | null, ref: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refCommits(scope ?? { workItemId: '' }, workspacePath, ref ?? ''),
    queryFn: () => workspaceDiffData.getRefCommits(scope!, workspacePath, ref),
    enabled: canReadWorkspace(scope, workspacePath),
    staleTime: 30_000,
  });
}

export function useWorkspaceCommitDiff(scope: WorkspaceDiffScope | null, workspacePath: string | null, commit: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.commitDiff(scope ?? { workItemId: '' }, workspacePath, commit ?? ''),
    queryFn: () => workspaceDiffData.getCommitDiff(scope!, workspacePath, commit!),
    enabled: Boolean(commit) && canReadWorkspace(scope, workspacePath),
    // A commit is immutable, so what was fetched stays true.
    staleTime: Infinity,
  });
}

export function useDiffHunkReviews(scope: WorkspaceDiffScope, revision: string | undefined) {
  const workspacePath = null;
  return useQuery({
    queryKey: workspaceDiffQueryKeys.hunkReviews(scope, workspacePath, revision),
    queryFn: () => workspaceDiffData.getHunkReviews(scope, revision!),
    enabled: Boolean(revision),
    staleTime: Infinity,
  });
}

export function useUpsertDiffHunkReview(scope: WorkspaceDiffScope, revision: string | undefined) {
  const queryClient = useQueryClient();
  const workspacePath = null;
  return useMutation({
    mutationFn: (input: { hunks: Array<{ filePath: string; hunkRange: string; contentHash: string }>; state: DiffHunkReviewState; note?: string }) => workspaceDiffData.upsertHunkReviews(scope, { ...input, revision: revision! }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.hunkReviews(scope, workspacePath, revision) });
    },
  });
}

/** One file read whole, fetched only while the reviewer is actually reading it
 * that way. Keyed on path and revision, so switching blocks inside a file the
 * reader already has costs nothing and a committed revision — which cannot
 * change — stays cached. */
export function useWorkspaceFileSource(scope: WorkspaceDiffScope | null, workspacePath: string | null, filePath: string | null, revision: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.fileSource(scope ?? { workItemId: '' }, workspacePath, filePath ?? '', revision),
    queryFn: () => workspaceDiffData.getFileSource(scope!, workspacePath, filePath!, revision),
    enabled: Boolean(filePath) && enabled && canReadWorkspace(scope, workspacePath),
    // A committed revision is immutable; the working tree is re-read whenever
    // the reader comes back to it.
    staleTime: revision ? Infinity : 0,
    refetchOnWindowFocus: revision ? false : 'always',
  });
}
