import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentRun, WorkItem } from '../../../shared/contracts';
import { api } from '../../api';
import { toastError } from '../../toast-store';
import { queueQueryKeys } from './data';

export function useTaskClassification(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nextKind: AgentRun['kind']) => api.classifyWorkItem(itemId, nextKind),
    onMutate: async (nextKind) => {
      await queryClient.cancelQueries({ queryKey: queueQueryKeys.workItem(itemId) });
      const previous = queryClient.getQueryData<{ item: WorkItem }>(queueQueryKeys.workItem(itemId));
      queryClient.setQueryData<{ item: WorkItem }>(queueQueryKeys.workItem(itemId), (current) => current && ({ ...current, item: { ...current.item, classificationKind: nextKind } }));
      return { previous };
    },
    onError: (error, _nextKind, context) => {
      if (context?.previous) queryClient.setQueryData(queueQueryKeys.workItem(itemId), context.previous);
      toastError('Could not update the task type.', error);
    },
    onSettled: async () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queueQueryKeys.workItems }),
      queryClient.invalidateQueries({ queryKey: queueQueryKeys.workItem(itemId) }),
    ]),
  });
}

export function useUnblockWorkItem(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => api.unblockWorkItem(itemId, reason),
    onSuccess: async () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queueQueryKeys.workItems }),
      queryClient.invalidateQueries({ queryKey: queueQueryKeys.workItem(itemId) }),
    ]),
  });
}
