import { useQuery } from '@tanstack/react-query';
import { workspaceDiffData, workspaceDiffQueryKeys } from './data.js';

export function useWorkspaceDiff(workItemId: string, isRunning: boolean) {
  return useQuery({
    queryKey: workspaceDiffQueryKeys.detail(workItemId),
    queryFn: () => workspaceDiffData.get(workItemId),
    refetchInterval: isRunning ? 1_500 : false,
    staleTime: isRunning ? 0 : 30_000,
  });
}
