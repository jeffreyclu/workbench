import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';
import { workspaceDiffData, workspaceDiffQueryKeys } from './data.js';

export function useWorkspaceDiff(scope: WorkspaceDiffScope | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.detail(scope ?? { workItemId: '' }),
    queryFn: () => workspaceDiffData.get(scope!),
    enabled: Boolean(scope),
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
  const status = useQuery({
    queryKey: workspaceDiffQueryKeys.status(scope, revision ?? ''),
    queryFn: () => workspaceDiffData.getStatus(scope, revision!),
    enabled: Boolean(revision) && isRunning,
    refetchInterval: isRunning ? 1_500 : false,
    select: ({ changed }) => changed,
  });
  return status.data ?? false;
}

export function useWorkspaceDiffSnapshots(scope: WorkspaceDiffScope | null, revision: string | undefined) {
  const query = useQuery({
    queryKey: workspaceDiffQueryKeys.snapshots(scope ?? { workItemId: '' }),
    queryFn: () => workspaceDiffData.getSnapshots(scope!),
    enabled: Boolean(scope),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  // The current-diff route writes its immutable record before replying. Fetch
  // again when that revision arrives so a racing initial timeline request does
  // not omit the just-captured version.
  useEffect(() => {
    if (revision) void query.refetch();
  }, [revision, query.refetch]);
  return query;
}

/** Branches and worktrees available to review. Cheap enough to keep warm, but
 * it walks refs, so it is not on the diff's own refetch-always path. */
export function useWorkspaceRefs(scope: WorkspaceDiffScope | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refs(scope ?? { workItemId: '' }),
    queryFn: () => workspaceDiffData.getRefs(scope!),
    enabled: Boolean(scope),
    staleTime: 30_000,
  });
}

/** The diff for one selected branch or worktree. Only the selected ref is ever
 * fetched — enumerating every branch's patch would be the expensive mistake. */
export function useWorkspaceRefDiff(scope: WorkspaceDiffScope | null, ref: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refDiff(scope ?? { workItemId: '' }, ref ?? ''),
    queryFn: () => workspaceDiffData.getRefDiff(scope!, ref!),
    enabled: Boolean(scope) && Boolean(ref),
    staleTime: 0,
  });
}


/** The commits behind a branch, and one commit read on its own. Both are
 * asked for only once a branch is actually selected: a review that never
 * leaves the whole-branch reading pays for neither. */
export function useWorkspaceRefCommits(scope: WorkspaceDiffScope | null, ref: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.refCommits(scope ?? { workItemId: '' }, ref ?? ''),
    queryFn: () => workspaceDiffData.getRefCommits(scope!, ref!),
    enabled: Boolean(scope) && Boolean(ref),
    staleTime: 30_000,
  });
}

export function useWorkspaceCommitDiff(scope: WorkspaceDiffScope | null, commit: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.commitDiff(scope ?? { workItemId: '' }, commit ?? ''),
    queryFn: () => workspaceDiffData.getCommitDiff(scope!, commit!),
    enabled: Boolean(scope) && Boolean(commit),
    // A commit is immutable, so what was fetched stays true.
    staleTime: Infinity,
  });
}

export function useDiffHunkReviews(scope: WorkspaceDiffScope, revision: string | undefined) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.hunkReviews(scope, revision),
    queryFn: () => workspaceDiffData.getHunkReviews(scope, revision!),
    enabled: Boolean(revision),
    staleTime: Infinity,
  });
}

export function useUpsertDiffHunkReview(scope: WorkspaceDiffScope, revision: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { hunks: Array<{ filePath: string; hunkRange: string; contentHash: string }>; state: DiffHunkReviewState; note?: string }) => workspaceDiffData.upsertHunkReviews(scope, { ...input, revision: revision! }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.hunkReviews(scope, revision) });
    },
  });
}
