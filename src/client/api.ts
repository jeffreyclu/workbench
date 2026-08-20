import type {
  Activity,
  AgentRun,
  ExecutionPlan,
  GeneratedTaskDraft,
  LinearSyncResult,
  LinearTeam,
  LinearProviderConfig,
  QueueProposal,
  QueueOrderChange,
  QueueItemExplanation,
  ResolvedSourceDraft,
  BrokerConnection,
  BrokerSearchResponse,
  BrokerSourceId,
  SharedMessage,
  SharedConversation,
  SharedSearchResponse,
  ConversationPage,
  Memory,
  WorkItem,
  WorkItemDetail,
  WorkItemPage,
  PublishedArtifact,
  ArtifactSummary,
  ArtifactDetail,
  ArtifactComment,
  DiscoveryInbox,
  WorkItemReference,
  WorkItemReferenceType,
} from '../shared/contracts';
import type { z } from 'zod';
import type { createMemorySchema, updateMemorySchema, supersedeMemorySchema } from '../shared/contracts';

/** Mirrors the server's QueuePlan (queue-intelligence.ts), which is not part of the shared contract. */
export interface QueuePlan {
  orderedItemIds: string[];
  explanations: QueueItemExplanation[];
  rationale: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

export const api = {
  getDiscoveryInbox: (view: 'pending' | 'reviewed' = 'pending') => request<DiscoveryInbox>(`/api/discovery?view=${view}`),
  scanDiscovery: () => request<{ started: boolean }>('/api/discovery/scan', { method: 'POST' }),
  resolveDiscovery: (id: string, action: 'convert' | 'dismiss' | 'snooze' | 'merge', workItemId?: string) =>
    request(`/api/discovery/${id}/${action}`, { method: 'POST', body: JSON.stringify({ workItemId }) }),
  updateDiscovery: (id: string, input: { title?: string; description?: string }) => request(`/api/discovery/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  bulkResolveDiscovery: (ids: string[], action: 'convert' | 'dismiss' | 'snooze') => request('/api/discovery/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) }),
  restoreDiscovery: (id: string) => request(`/api/discovery/${id}/restore`, { method: 'POST' }),
  publishArtifact: (input: { path: string; title?: string; conversationId?: string; workItemId?: string }) =>
    request<{ artifact: PublishedArtifact }>('/api/artifacts/publish', { method: 'POST', body: JSON.stringify(input) }),
  revokeArtifact: (id: string) => request<{ artifact: ArtifactSummary }>(`/api/artifacts/${id}`, { method: 'DELETE' }),
  listArtifacts: (view: 'published' | 'revoked' | 'all' = 'published') =>
    request<{ artifacts: ArtifactSummary[]; counts: { published: number; revoked: number; openComments: number } }>(`/api/artifacts?view=${view}`),
  getArtifact: (id: string) => request<ArtifactDetail>(`/api/artifacts/${id}`),
  republishArtifact: (id: string) => request<{ artifact: ArtifactSummary; published: boolean; kind: string }>(`/api/artifacts/${id}/republish`, { method: 'POST' }),
  updateArtifact: (id: string, input: { title?: string; workItemId?: string | null; conversationId?: string | null }) =>
    request<{ artifact: ArtifactSummary }>(`/api/artifacts/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  addArtifactComment: (id: string, input: { author: string; body: string }) =>
    request<{ comment: ArtifactComment }>(`/api/artifacts/${id}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  resolveArtifactComment: (id: string, commentId: string, resolved: boolean) =>
    request<{ comment: ArtifactComment }>(`/api/artifacts/${id}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ resolved }) }),
  listWorkItems: (view: 'active' | 'workbench' | 'archive', query: string, cursor?: string) => {
    const params = new URLSearchParams({ view, limit: '50' });
    if (query) params.set('query', query);
    if (cursor) params.set('cursor', cursor);
    return request<WorkItemPage>(`/api/work-items?${params}`);
  },
  getWorkItem: (id: string) => request<WorkItemDetail>(`/api/work-items/${id}`),
  classifyWorkItem: (id: string, kind: AgentRun['kind']) => request<{ classification: WorkItemDetail['classification'] }>(`/api/work-items/${id}/classify`, { method: 'POST', body: JSON.stringify({ kind }) }),
  createWorkItem: (input: {
    title: string;
    description: string;
    status: WorkItem['status'];
    projectName: string | null;
    dueDate: string | null;
    sourceUrl?: string | null;
    workspacePath?: string | null;
  }) => request<{ item: WorkItem }>('/api/work-items', { method: 'POST', body: JSON.stringify(input) }),
  createFollowUp: (id: string, title: string, description: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/follow-ups`, { method: 'POST', body: JSON.stringify({ title, description }) }),
  addWorkItemReference: (id: string, input: { type: WorkItemReferenceType; url: string; title?: string }) =>
    request<{ reference: WorkItemReference }>(`/api/work-items/${id}/references`, { method: 'POST', body: JSON.stringify(input) }),
  removeWorkItemReference: (id: string, referenceId: string) =>
    request<void>(`/api/work-items/${id}/references/${referenceId}`, { method: 'DELETE' }),
  generateTaskDraft: (prompt: string) => request<{ draft: GeneratedTaskDraft }>('/api/work-items/generate-draft', { method: 'POST', body: JSON.stringify({ prompt }) }),
  resolveSourceUrl: (url: string) => request<{ draft: ResolvedSourceDraft }>('/api/sources/resolve', { method: 'POST', body: JSON.stringify({ url }) }),
  searchSources: (query: string, sources: BrokerSourceId[], signal?: AbortSignal) => request<BrokerSearchResponse>('/api/sources/search', { method: 'POST', body: JSON.stringify({ query, sources }), signal }),
  updateWorkItem: (id: string, input: Partial<WorkItem>) =>
    request<{ item: WorkItem }>(`/api/work-items/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  archiveWorkItem: (id: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/archive`, { method: 'POST' }),
  restoreWorkItem: (id: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/restore`, { method: 'POST' }),
  completeWorkItem: (id: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/complete`, { method: 'POST' }),
  deleteWorkItem: (id: string) => request<void>(`/api/work-items/${id}`, { method: 'DELETE' }),
  addActivity: (id: string, input: Pick<Activity, 'actor' | 'kind' | 'body'>) =>
    request<{ activity: Activity }>(`/api/work-items/${id}/activity`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createAgentRun: (id: string, input: Pick<AgentRun, 'kind' | 'requestedTarget' | 'instructions'>) =>
    request<{ runs: AgentRun[] }>(`/api/work-items/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ kind: input.kind, target: input.requestedTarget, instructions: input.instructions }),
    }),
  cancelAgentRun: (id: string) => request<{ run: AgentRun }>(`/api/agent-runs/${id}/cancel`, { method: 'POST' }),
  executeWorkItem: (id: string, executionProfile: AgentRun['executionProfile']) =>
    request<{ run: AgentRun; runs: AgentRun[]; classification: WorkItemDetail['classification']; conversation: SharedConversation; activity: Activity }>(`/api/work-items/${id}/execute`, { method: 'POST', body: JSON.stringify({ executionProfile }) }),
  resolveExecutionPlan: (id: string, resolution: 'accepted' | 'rejected', selectedTaskIndexes?: number[]) =>
    request(`/api/execution-plans/${id}/${resolution}`, { method: 'POST', body: JSON.stringify({ selectedTaskIndexes }) }),
  reorderQueue: (input: { itemId: string; beforeId?: string; afterId?: string }) =>
    request<{ items: WorkItem[] }>('/api/queue/order', { method: 'PUT', body: JSON.stringify(input) }),
  resolveQueueProposal: (id: string, resolution: 'accepted' | 'rejected') =>
    request<{ proposal: QueueProposal; items: WorkItem[] }>(`/api/queue/proposals/${id}/${resolution}`, { method: 'POST' }),
  planQueue: () => request<{ proposal: QueueProposal; items: WorkItem[] }>('/api/queue/plan', { method: 'POST' }),
  explainQueue: () =>
    request<{ plan: QueuePlan; history: QueueOrderChange[] }>('/api/queue/explain'),
  undoQueue: (stack: 'attention' | 'workbench' = 'attention') =>
    request<{ change: QueueOrderChange; items: WorkItem[] }>('/api/queue/undo', { method: 'POST', body: JSON.stringify({ stack }) }),
  syncLinear: () => request<LinearSyncResult>('/api/providers/linear/sync', { method: 'POST' }),
  searchLinear: (query: string) =>
    request<{ items: WorkItem[] }>(`/api/providers/linear/search?q=${encodeURIComponent(query)}`),
  queueLinearItem: (id: string) =>
    request<{ item: WorkItem }>(`/api/providers/linear/queue/${id}`, { method: 'POST' }),
  getLinearTeams: () =>
    request<{ teams: LinearTeam[]; config: LinearProviderConfig }>('/api/providers/linear/teams'),
  getLinearTeamProjects: (teamId: string) =>
    request<{ projects: LinearTeam['projects'] }>(`/api/providers/linear/teams/${teamId}/projects`),
  updateLinearConfig: (config: LinearProviderConfig) =>
    request<{ config: LinearProviderConfig }>('/api/providers/linear/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  listSourceConnections: () => request<{ connections: BrokerConnection[] }>('/api/source-connections'),
  startMcpOAuth: (provider: 'confluence' | 'slack' | 'gmail', serverUrl?: string) => request<{ url: string }>(`/api/source-connections/${provider}/mcp/oauth/start`, { method: 'POST', body: JSON.stringify({ serverUrl }) }),
  disconnectSource: (provider: 'confluence' | 'slack' | 'gmail' | 'github') => request<void>(`/api/source-connections/${provider}`, { method: 'DELETE' }),
  listSharedConversations: (view: 'active' | 'archive', cursor?: string) => {
    const params = new URLSearchParams({ limit: '30', view });
    if (cursor) params.set('cursor', cursor);
    return request<ConversationPage>(`/api/shared/conversations?${params}`);
  },
  getWorkItemCounts: () => request<{ active: number; workbench: number; archive: number }>('/api/work-item-counts'),
  searchShared: (query: string, limit?: number) => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set('limit', String(limit));
    return request<SharedSearchResponse>(`/api/shared/search?${params}`);
  },
  createSharedConversation: (title = 'New conversation') => request<{ conversation: SharedConversation }>('/api/shared/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  archiveSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/archive`, { method: 'POST' }),
  restoreSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/restore`, { method: 'POST' }),
  forkSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/fork`, { method: 'POST' }),
  deleteSharedConversation: (id: string) => request<void>(`/api/shared/conversations/${id}`, { method: 'DELETE' }),
  listSharedMessages: (conversationId?: string) => request<{ messages: SharedMessage[] }>(conversationId ? `/api/shared/messages?conversationId=${encodeURIComponent(conversationId)}` : '/api/shared/messages'),
  createSharedMessage: (conversationId: string, body: string, dispatchTo: 'auto' | 'both' | 'codex' | 'claude' | 'none', attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }>, executionProfile: AgentRun['executionProfile'] = null) =>
    request<{ message: SharedMessage; replies: SharedMessage[] }>('/api/shared/messages', {
      method: 'POST', body: JSON.stringify({ conversationId, body, dispatchTo, attachments, executionProfile }),
    }),
  updateSharedMessage: (id: string, pinned: boolean) =>
    request<{ message: SharedMessage }>(`/api/shared/messages/${id}`, {
      method: 'PATCH', body: JSON.stringify({ pinned }),
    }),
  cancelSharedReply: (id: string) => request<{ message: SharedMessage }>(`/api/shared/messages/${id}/cancel`, { method: 'POST' }),
  interjectSharedMessage: (id: string) => request<{ replies: SharedMessage[] }>(`/api/shared/messages/${id}/interject`, { method: 'POST' }),
  createTasksFromReport: (id: string) => request<{ plan?: ExecutionPlan; jobMessage?: SharedMessage }>(`/api/shared/messages/${id}/create-tasks`, { method: 'POST' }),
  listMemories: (filter?: { scope?: Memory['scope']; projectName?: string; status?: Memory['status']; kind?: Memory['kind'] }) => {
    const params = new URLSearchParams();
    if (filter?.scope) params.set('scope', filter.scope);
    if (filter?.projectName) params.set('projectName', filter.projectName);
    if (filter?.status) params.set('status', filter.status);
    if (filter?.kind) params.set('kind', filter.kind);
    const query = params.toString();
    return request<{ memories: Memory[] }>(`/api/memories${query ? `?${query}` : ''}`);
  },
  createMemory: (input: z.input<typeof createMemorySchema>) =>
    request<{ memory: Memory }>('/api/memories', { method: 'POST', body: JSON.stringify(input) }),
  updateMemory: (id: string, changes: z.input<typeof updateMemorySchema>) =>
    request<{ memory: Memory }>(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  supersedeMemory: (id: string, replacement: z.input<typeof supersedeMemorySchema>) =>
    request<{ memory: Memory }>(`/api/memories/${id}/supersede`, { method: 'POST', body: JSON.stringify(replacement) }),
  rejectMemory: (id: string) => request<{ memory: Memory }>(`/api/memories/${id}`, { method: 'DELETE' }),
};
