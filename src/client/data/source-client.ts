import type { BrokerConnection, BrokerSearchResponse, BrokerSourceId, ResolvedSourceDraft } from '../../shared/contracts';
import type { DiffHunkReview, DiffHunkReviewState, GitHubPullRequestDiff, UpsertDiffHunkReviewsInput, WorkspaceDiff, WorkspaceDiffSnapshot } from '../../shared/contracts';
import { request } from './request';

// A conversation with no linked task still has a real workspace (see
// resolveSharedReplyWorkingDirectory server-side), so the diff surface is
// scoped to either a task or a conversation rather than a task alone.
export type WorkspaceDiffScope = { workItemId: string } | { conversationId: string };
const workspaceDiffBasePath = (scope: WorkspaceDiffScope) => 'workItemId' in scope
  ? `/api/work-items/${scope.workItemId}`
  : `/api/shared/conversations/${scope.conversationId}`;

export const sourceClient = {
  resolveSourceUrl: (url: string) => request<{ draft: ResolvedSourceDraft }>('/api/sources/resolve', { method: 'POST', body: JSON.stringify({ url }) }),
  searchSources: (query: string, sources: BrokerSourceId[], signal?: AbortSignal) => request<BrokerSearchResponse>('/api/sources/search', { method: 'POST', body: JSON.stringify({ query, sources }), signal }),
  listSourceConnections: () => request<{ connections: BrokerConnection[] }>('/api/source-connections'),
  getFigmaScope: () => request<{ roots: string[] }>('/api/source-connections/figma/scope'),
  updateFigmaScope: (roots: string[]) => request<{ roots: string[] }>('/api/source-connections/figma/scope', { method: 'PUT', body: JSON.stringify({ roots }) }),
  startMcpOAuth: (provider: 'confluence' | 'slack' | 'figma' | 'gmail', serverUrl?: string) => request<{ url: string }>(`/api/source-connections/${provider}/mcp/oauth/start`, { method: 'POST', body: JSON.stringify({ serverUrl }) }),
  startManagedMcpOAuth: (provider: 'figma' | 'atlassian') => request<{ url: string }>(`/api/source-connections/${provider}/managed/oauth/start`, { method: 'POST' }),
  configureGrafana: (token: string) => request<{ configured: true }>('/api/source-connections/grafana', { method: 'PUT', body: JSON.stringify({ token }) }),
  disconnectSource: (provider: 'confluence' | 'slack' | 'figma' | 'grafana' | 'gmail' | 'github') => request<void>(`/api/source-connections/${provider}`, { method: 'DELETE' }),
  getWorkspaceDiff: (scope: WorkspaceDiffScope) => request<{ diff: WorkspaceDiff }>(`${workspaceDiffBasePath(scope)}/workspace-diff`),
  getWorkspaceDiffSnapshots: (scope: WorkspaceDiffScope) => request<{ snapshots: WorkspaceDiffSnapshot[] }>(`${workspaceDiffBasePath(scope)}/workspace-diff/snapshots`),
  getWorkspaceDiffStatus: (scope: WorkspaceDiffScope, revision: string) => request<{ changed: boolean }>(`${workspaceDiffBasePath(scope)}/workspace-diff/status?revision=${encodeURIComponent(revision)}`),
  getDiffHunkReviews: (scope: WorkspaceDiffScope, revision: string) => request<{ reviews: DiffHunkReview[] }>(`${workspaceDiffBasePath(scope)}/workspace-diff/hunk-reviews?revision=${encodeURIComponent(revision)}`),
  upsertDiffHunkReview: (scope: WorkspaceDiffScope, input: { revision: string; filePath: string; hunkRange: string; state: DiffHunkReviewState; note?: string }) => request<{ review: DiffHunkReview }>(`${workspaceDiffBasePath(scope)}/workspace-diff/hunk-reviews`, { method: 'PUT', body: JSON.stringify(input) }),
  upsertDiffHunkReviews: (scope: WorkspaceDiffScope, input: UpsertDiffHunkReviewsInput) => request<{ reviews: DiffHunkReview[] }>(`${workspaceDiffBasePath(scope)}/workspace-diff/hunk-reviews/batch`, { method: 'PUT', body: JSON.stringify(input) }),
  getWorkItemWorkspaces: (id: string) => request<{ selectedPath: string | null; workspaces: Array<{ path: string; label: string; selected: boolean }> }>(`/api/work-items/${id}/workspaces`),
  selectWorkItemWorkspace: (id: string, workspacePath: string) => request<{ selectedPath: string; workspaces: Array<{ path: string; label: string; selected: boolean }> }>(`/api/work-items/${id}/workspaces/selection`, { method: 'PUT', body: JSON.stringify({ workspacePath }) }),
  getGitHubPullRequestDiff: (url: string, page = 1) => request<{ diff: GitHubPullRequestDiff }>(`/api/github/pull-request-diff?url=${encodeURIComponent(url)}&page=${page}`),
  assessDiffBlocks: (blocks: Array<{ key: string; lines: string[] }>) => request<{ assessments: Record<string, { risk: number | null; reasoning: string }> }>('/api/diff-confidence', { method: 'POST', body: JSON.stringify({ blocks }) }),
};
