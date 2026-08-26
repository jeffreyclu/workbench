import { useQuery } from '@tanstack/react-query';
import { workspaceDiffData, workspaceDiffQueryKeys } from './data.js';

export function useWorkspaceDiff(workItemId: string | null) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.detail(workItemId ?? ''),
    queryFn: () => workspaceDiffData.get(workItemId!),
    enabled: Boolean(workItemId),
    // A diff is a review surface, not a live log. Background refetches replace
    // the rendered patch while someone is reading it, so updates are explicit.
    staleTime: Infinity,
  });
}

export function useWorkspaceDiffChanges(workItemId: string, revision: string | undefined, isRunning: boolean) {
  const status = useQuery({
    queryKey: workspaceDiffQueryKeys.status(workItemId, revision ?? ''),
    queryFn: () => workspaceDiffData.getStatus(workItemId, revision!),
    enabled: Boolean(revision) && isRunning,
    refetchInterval: isRunning ? 1_500 : false,
    select: ({ changed }) => changed,
  });
  return status.data ?? false;
}
