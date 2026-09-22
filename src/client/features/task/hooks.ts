import { useQuery } from '@tanstack/react-query';
import { taskData, taskQueryKeys } from './data';

export function useTaskDetail(taskId: string) {
  return useQuery({
    queryKey: taskQueryKeys.detail(taskId),
    queryFn: () => taskData.get(taskId),
  });
}
