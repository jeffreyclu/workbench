import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
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


export function useCommitAndPushWorkspace(scope: WorkspaceDiffScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revision: string) => workspaceDiffData.commitAndPush(scope, revision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.detail(scope) });
    },
  });
}
