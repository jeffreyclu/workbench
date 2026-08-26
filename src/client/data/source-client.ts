import type { BrokerConnection, BrokerSearchResponse, BrokerSourceId, ResolvedSourceDraft } from '../../shared/contracts';
import type { GitHubPullRequestDiff, WorkspaceDiff, WorkspacePublishResult } from '../../shared/contracts';
import { request } from './request';

export const sourceClient = {
  resolveSourceUrl: (url: string) => request<{ draft: ResolvedSourceDraft }>('/api/sources/resolve', { method: 'POST', body: JSON.stringify({ url }) }),
  searchSources: (query: string, sources: BrokerSourceId[], signal?: AbortSignal) => request<BrokerSearchResponse>('/api/sources/search', { method: 'POST', body: JSON.stringify({ query, sources }), signal }),
  listSourceConnections: () => request<{ connections: BrokerConnection[] }>('/api/source-connections'),
  getFigmaScope: () => request<{ roots: string[] }>('/api/source-connections/figma/scope'),
  updateFigmaScope: (roots: string[]) => request<{ roots: string[] }>('/api/source-connections/figma/scope', { method: 'PUT', body: JSON.stringify({ roots }) }),
  startMcpOAuth: (provider: 'confluence' | 'slack' | 'figma' | 'gmail', serverUrl?: string) => request<{ url: string }>(`/api/source-connections/${provider}/mcp/oauth/start`, { method: 'POST', body: JSON.stringify({ serverUrl }) }),
  startManagedMcpOAuth: (provider: 'figma' | 'atlassian') => request<{ url: string }>(`/api/source-connections/${provider}/managed/oauth/start`, { method: 'POST' }),
  disconnectSource: (provider: 'confluence' | 'slack' | 'figma' | 'gmail' | 'github') => request<void>(`/api/source-connections/${provider}`, { method: 'DELETE' }),
  getWorkspaceDiff: (workItemId: string) => request<{ diff: WorkspaceDiff }>(`/api/work-items/${workItemId}/workspace-diff`),
  getWorkspaceDiffStatus: (workItemId: string, revision: string) => request<{ changed: boolean }>(`/api/work-items/${workItemId}/workspace-diff/status?revision=${encodeURIComponent(revision)}`),
  commitAndPushWorkspace: (workItemId: string, revision: string) => request<{ result: WorkspacePublishResult }>(`/api/work-items/${workItemId}/workspace-diff/commit-and-push`, { method: 'POST', body: JSON.stringify({ revision }) }),
  getGitHubPullRequestDiff: (url: string) => request<{ diff: GitHubPullRequestDiff }>(`/api/github/pull-request-diff?url=${encodeURIComponent(url)}`),
  assessDiffBlocks: (blocks: Array<{ key: string; lines: string[] }>) => request<{ assessments: Record<string, number> }>('/api/diff-confidence', { method: 'POST', body: JSON.stringify({ blocks }) }),
};
