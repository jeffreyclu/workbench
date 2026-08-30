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
    mutationFn: (input: { hunks: Array<{ filePath: string; hunkRange: string }>; state: DiffHunkReviewState; note?: string }) => workspaceDiffData.upsertHunkReviews(scope, { ...input, revision: revision! }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.hunkReviews(scope, revision) });
    },
  });
}

/** One file read whole, fetched only while the reviewer is actually reading it
 * that way. Keyed on path and revision, so switching blocks inside a file the
 * reader already has costs nothing and a committed revision — which cannot
 * change — stays cached. */
export function useWorkspaceFileSource(scope: WorkspaceDiffScope | null, filePath: string | null, revision: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.fileSource(scope ?? { workItemId: '' }, filePath ?? '', revision),
    queryFn: () => workspaceDiffData.getFileSource(scope!, filePath!, revision),
    enabled: Boolean(scope) && Boolean(filePath) && enabled,
    // A committed revision is immutable; the working tree is re-read whenever
    // the reader comes back to it.
    staleTime: revision ? Infinity : 0,
    refetchOnWindowFocus: revision ? false : 'always',
  });
}
