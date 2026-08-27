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
    // A diff is a review surface, not a live log. Background refetches replace
    // the rendered patch while someone is reading it, so updates are explicit.
    staleTime: Infinity,
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
    staleTime: Infinity,
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
    mutationFn: (input: { filePath: string; hunkRange: string; state: DiffHunkReviewState; note?: string }) => workspaceDiffData.upsertHunkReview(scope, { ...input, revision: revision! }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.hunkReviews(scope, revision) });
    },
  });
}
