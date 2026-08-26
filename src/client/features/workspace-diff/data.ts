import { api } from '../../api.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';

const scopeKey = (scope: WorkspaceDiffScope) => ('workItemId' in scope ? scope.workItemId : scope.conversationId);

export const workspaceDiffQueryKeys = {
  detail: (scope: WorkspaceDiffScope) => ['workspace-diff', scopeKey(scope)] as const,
  status: (scope: WorkspaceDiffScope, revision: string) => ['workspace-diff-status', scopeKey(scope), revision] as const,
};

export const workspaceDiffData = {
  get: (scope: WorkspaceDiffScope) => api.getWorkspaceDiff(scope),
  getStatus: (scope: WorkspaceDiffScope, revision: string) => api.getWorkspaceDiffStatus(scope, revision),
  commitAndPush: (scope: WorkspaceDiffScope, revision: string) => api.commitAndPushWorkspace(scope, revision),
};
