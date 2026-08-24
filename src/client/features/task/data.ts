import { api } from '../../api';

export const taskQueryKeys = {
  detail: (taskId: string) => ['work-item', taskId] as const,
  workItems: ['work-items'] as const,
};

export const taskData = {
  get: (taskId: string) => api.getWorkItem(taskId),
  update: api.updateWorkItem,
};
