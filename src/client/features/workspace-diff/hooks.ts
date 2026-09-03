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

/**
 * The repository every workspace-diff request will actually be answered from.
 * Repo Explorer's selection is server state, so it cannot be read off the URL
 * and has to be resolved before anything is cached under it. Requests wait for
 * it rather than firing against an unknown repository, because the answer would
 * then be cached under the wrong key.
 */
export function useSelectedWorkspacePath(scope: WorkspaceDiffScope | null) {
  const conversationId = scope && 'conversationId' in scope ? scope.conversationId : null;
  const workItemId = scope && 'workItemId' in scope ? scope.workItemId : null;
  const explorer = useQuery({
    queryKey: workspaceExplorerQueryKey(scope),
    queryFn: () => conversationId ? conversationClient.getConversationWorkspaces(conversationId) : sourceClient.getWorkItemWorkspaces(workItemId!),
    enabled: Boolean(conversationId || workItemId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  // A standalone review owns one repository for its whole life: there is no
  // picker, so there is nothing to resolve and nothing to wait for.
  if (!conversationId && !workItemId) return { workspacePath: null, isResolved: true };
  // A failed explorer read still resolves: the server answers from its own
  // selection either way, and the key corrects itself when the read recovers.
  return { workspacePath: explorer.data?.selectedPath ?? null, isResolved: explorer.isSuccess || explorer.isError };
}

export function useWorkspaceDiff(scope: WorkspaceDiffScope | null) {
  const { workspacePath, isResolved } = useSelectedWorkspacePath(scope);
  return useQuery({
    queryKey: workspaceDiffQueryKeys.detail(scope ?? { workItemId: '' }, workspacePath),
    queryFn: () => workspaceDiffData.get(scope!),
    enabled: Boolean(scope) && isResolved,
    // Never reuse a clean diff from a previous visit: the server may have
    // selected a detached agent worktree since this panel was last visible.
    // We still do not poll the full patch while it is being read; the status
    // endpoint handles that separately.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}

export function useWorkspaceDiffChanges(scope: WorkspaceDiffScope, revision: string | undefined, isRunning: boolean) {
  const { workspacePath } = useSelectedWorkspacePath(scope);
  const status = useQuery({
    queryKey: workspaceDiffQueryKeys.status(scope, workspacePath, revision ?? ''),
    queryFn: () => workspaceDiffData.getStatus(scope, revision!),
    enabled: Boolean(revision) && isRunning,
    refetchInterval: isRunning ? 1_500 : false,
    select: ({ changed }) => changed,
  });
  return status.data ?? false;
}

export function useWorkspaceDiffSnapshots(scope: WorkspaceDiffScope | null, revision: string | undefined) {
  const { workspacePath, isResolved } = useSelectedWorkspacePath(scope);
  const query = useQuery({
    queryKey: workspaceDiffQueryKeys.snapshots(scope ?? { workItemId: '' }, workspacePath),
    queryFn: () => workspaceDiffData.getSnapshots(scope!),
    enabled: Boolean(scope) && isResolved,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  // The current-diff route writes its immutable record before replying. Fetch
  // again when that revision arrives so a racing initial timeline request does
  // not omit the just-captured version. This stays a refetch rather than part
  // of the key: the timeline already loaded is still this repository's, and
  // dropping it would blank the History control every time the diff moves.
  useEffect(() => {
    if (revision) void query.refetch();
  }, [revision, query.refetch]);
  return query;
}

/** Branches and worktrees available to review. Cheap enough to keep warm, but
 * it walks refs, so it is not on the diff's own refetch-always path. */
export function useWorkspaceRefs(scope: WorkspaceDiffScope | null) {
  const { workspacePath, isResolved } = useSelectedWorkspacePath(scope);
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refs(scope ?? { workItemId: '' }, workspacePath),
    queryFn: () => workspaceDiffData.getRefs(scope!),
    enabled: Boolean(scope) && isResolved,
    staleTime: 30_000,
  });
}

/** The diff for one selected branch or worktree. Only the selected ref is ever
 * fetched — enumerating every branch's patch would be the expensive mistake. */
export function useWorkspaceRefDiff(scope: WorkspaceDiffScope | null, ref: string | null) {
  const { workspacePath, isResolved } = useSelectedWorkspacePath(scope);
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refDiff(scope ?? { workItemId: '' }, workspacePath, ref ?? ''),
    queryFn: () => workspaceDiffData.getRefDiff(scope!, ref!),
    enabled: Boolean(scope) && Boolean(ref) && isResolved,
    staleTime: 0,
  });
}


/** The commits behind a branch, and one commit read on its own. Both are
 * asked for only once a branch is actually selected: a review that never
 * leaves the whole-branch reading pays for neither. */
export function useWorkspaceRefCommits(scope: WorkspaceDiffScope | null, ref: string | null) {
  const { workspacePath, isResolved } = useSelectedWorkspacePath(scope);
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refCommits(scope ?? { workItemId: '' }, workspacePath, ref ?? ''),
    queryFn: () => workspaceDiffData.getRefCommits(scope!, ref),
    enabled: Boolean(scope) && isResolved,
    staleTime: 30_000,
  });
}

export function useWorkspaceCommitDiff(scope: WorkspaceDiffScope | null, commit: string | null) {
  const { workspacePath, isResolved } = useSelectedWorkspacePath(scope);
  return useQuery({
    queryKey: workspaceDiffQueryKeys.commitDiff(scope ?? { workItemId: '' }, workspacePath, commit ?? ''),
    queryFn: () => workspaceDiffData.getCommitDiff(scope!, commit!),
    enabled: Boolean(scope) && Boolean(commit) && isResolved,
    // A commit is immutable, so what was fetched stays true.
    staleTime: Infinity,
  });
}

export function useDiffHunkReviews(scope: WorkspaceDiffScope, revision: string | undefined) {
  const { workspacePath } = useSelectedWorkspacePath(scope);
  return useQuery({
    queryKey: workspaceDiffQueryKeys.hunkReviews(scope, workspacePath, revision),
    queryFn: () => workspaceDiffData.getHunkReviews(scope, revision!),
    enabled: Boolean(revision),
    staleTime: Infinity,
  });
}

export function useUpsertDiffHunkReview(scope: WorkspaceDiffScope, revision: string | undefined) {
  const queryClient = useQueryClient();
  const { workspacePath } = useSelectedWorkspacePath(scope);
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
export function useWorkspaceFileSource(scope: WorkspaceDiffScope | null, filePath: string | null, revision: string | null, enabled: boolean) {
  const { workspacePath, isResolved } = useSelectedWorkspacePath(scope);
  return useQuery({
    queryKey: workspaceDiffQueryKeys.fileSource(scope ?? { workItemId: '' }, workspacePath, filePath ?? '', revision),
    queryFn: () => workspaceDiffData.getFileSource(scope!, filePath!, revision),
    enabled: Boolean(scope) && Boolean(filePath) && enabled && isResolved,
    // A committed revision is immutable; the working tree is re-read whenever
    // the reader comes back to it.
    staleTime: revision ? Infinity : 0,
    refetchOnWindowFocus: revision ? false : 'always',
  });
}
