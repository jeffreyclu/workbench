import { api } from '../../api.js';

export const workspaceDiffQueryKeys = {
  detail: (workItemId: string) => ['workspace-diff', workItemId] as const,
  status: (workItemId: string, revision: string) => ['workspace-diff-status', workItemId, revision] as const,
};

export const workspaceDiffData = {
  get: (workItemId: string) => api.getWorkspaceDiff(workItemId),
  getStatus: (workItemId: string, revision: string) => api.getWorkspaceDiffStatus(workItemId, revision),
};
