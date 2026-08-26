import { api } from '../../api.js';

export const workspaceDiffQueryKeys = {
  detail: (workItemId: string) => ['workspace-diff', workItemId] as const,
};

export const workspaceDiffData = {
  get: (workItemId: string) => api.getWorkspaceDiff(workItemId),
};
