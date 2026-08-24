import { useQuery } from '@tanstack/react-query';
import { taskData, taskQueryKeys } from './data';

export function useTaskDetail(taskId: string) {
  return useQuery({
    queryKey: taskQueryKeys.detail(taskId),
    queryFn: () => taskData.get(taskId),
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === 'queued' || run.status === 'running') ? 1_000 : false,
  });
}
