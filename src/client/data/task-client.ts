import type { Activity, AgentRun, BulkWorkItemAction, BulkWorkItemResult, ExecutionPlan, GeneratedTaskDraft, LinearProviderConfig, LinearSyncResult, LinearTeam, ProviderSyncConflictResolution, ProviderSyncField, SavedWorkItemFilter, SavedWorkItemFilterView, UpdateWorkItemInput, WorkItem, WorkItemDetail, WorkItemFilter, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../../shared/contracts';
import { request } from './request';

export const taskClient = {
  listWorkItems: (view: 'active' | 'workbench' | 'archive' | 'workbench-archive', query: string, cursor?: string, filter?: WorkItemFilter) => {
    const params = new URLSearchParams({ view, limit: '50' });
    if (filter) params.set('filter', JSON.stringify(filter));
    else if (query) params.set('query', query);
    if (cursor) params.set('cursor', cursor);
    return request<WorkItemPage>(`/api/work-items?${params}`);
  },
  listSavedWorkItemFilters: (view?: SavedWorkItemFilterView) => request<{ filters: SavedWorkItemFilter[] }>(`/api/work-item-filters${view ? `?view=${view}` : ''}`),
  createSavedWorkItemFilter: (input: { name: string; view: SavedWorkItemFilterView; filter: WorkItemFilter }) => request<{ filter: SavedWorkItemFilter }>('/api/work-item-filters', { method: 'POST', body: JSON.stringify(input) }),
  updateSavedWorkItemFilter: (id: string, input: Partial<Pick<SavedWorkItemFilter, 'name' | 'filter' | 'sortOrder'>>) => request<{ filter: SavedWorkItemFilter }>(`/api/work-item-filters/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteSavedWorkItemFilter: (id: string) => request<void>(`/api/work-item-filters/${id}`, { method: 'DELETE' }),
  bulkUpdateWorkItems: (input: BulkWorkItemAction) => request<BulkWorkItemResult>('/api/work-items/bulk', { method: 'POST', body: JSON.stringify(input) }),
  getWorkItem: (id: string) => request<WorkItemDetail>(`/api/work-items/${id}`),
  listDependencyCandidates: (id: string, query = '') => request<{ items: WorkItem[] }>(`/api/work-items/${id}/dependency-candidates?q=${encodeURIComponent(query)}`),
  classifyWorkItem: (id: string, kind: AgentRun['kind']) => request<{ classification: WorkItemDetail['classification'] }>(`/api/work-items/${id}/classify`, { method: 'POST', body: JSON.stringify({ kind }) }),
  createWorkItem: (input: { title: string; description: string; status: WorkItem['status']; projectName: string | null; dueDate: string | null; sourceUrl?: string | null; workspacePath?: string | null; classificationKind?: AgentRun['kind']; attachments?: Array<{ name: string; mimeType: string; size: number; dataBase64: string }> }) => request<{ item: WorkItem }>('/api/work-items', { method: 'POST', body: JSON.stringify(input) }),
  addWorkItemAttachments: (id: string, attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }>) => request<{ item: WorkItem }>(`/api/work-items/${id}/attachments`, { method: 'POST', body: JSON.stringify({ attachments }) }),
  removeWorkItemAttachment: (id: string, path: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/attachments/${encodeURIComponent(path)}`, { method: 'DELETE' }),
  createFollowUp: (id: string, title: string, description: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/follow-ups`, { method: 'POST', body: JSON.stringify({ title, description }) }),
  addTaskLink: (id: string, linkedWorkItemId: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/linked-tasks`, { method: 'POST', body: JSON.stringify({ linkedWorkItemId }) }),
  removeTaskLink: (id: string, linkedWorkItemId: string) => request<void>(`/api/work-items/${id}/linked-tasks/${linkedWorkItemId}`, { method: 'DELETE' }),
  addWorkItemReference: (id: string, input: { type: WorkItemReferenceType; url: string; title?: string }) => request<{ reference: WorkItemReference }>(`/api/work-items/${id}/references`, { method: 'POST', body: JSON.stringify(input) }),
  removeWorkItemReference: (id: string, referenceId: string) => request<void>(`/api/work-items/${id}/references/${referenceId}`, { method: 'DELETE' }),
  generateTaskDraft: (prompt: string) => request<{ draft: GeneratedTaskDraft }>('/api/work-items/generate-draft', { method: 'POST', body: JSON.stringify({ prompt }) }),
  updateWorkItem: (id: string, input: UpdateWorkItemInput) => request<{ item: WorkItem }>(`/api/work-items/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  resolveProviderConflict: (id: string, field: ProviderSyncField, resolution: ProviderSyncConflictResolution) => request<{ item: WorkItem; providerConflicts: WorkItemDetail['providerConflicts'] }>(`/api/work-items/${id}/provider-conflicts/${field}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) }),
  unblockWorkItem: (id: string, reason: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/unblock`, { method: 'POST', body: JSON.stringify({ reason }) }),
  archiveWorkItem: (id: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/archive`, { method: 'POST' }),
  restoreWorkItem: (id: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/restore`, { method: 'POST' }),
  completeWorkItem: (id: string) => request<{ item: WorkItem }>(`/api/work-items/${id}/complete`, { method: 'POST' }),
  deleteWorkItem: (id: string) => request<void>(`/api/work-items/${id}`, { method: 'DELETE' }),
  addActivity: (id: string, input: Pick<Activity, 'actor' | 'kind' | 'body'>) => request<{ activity: Activity }>(`/api/work-items/${id}/activity`, { method: 'POST', body: JSON.stringify(input) }),
  createAgentRun: (id: string, input: Pick<AgentRun, 'kind' | 'requestedTarget' | 'instructions'>) => request<{ runs: AgentRun[] }>(`/api/work-items/${id}/runs`, { method: 'POST', body: JSON.stringify({ kind: input.kind, target: input.requestedTarget, instructions: input.instructions }) }),
  cancelAgentRun: (id: string) => request<{ run: AgentRun }>(`/api/agent-runs/${id}/cancel`, { method: 'POST' }),
  retryAgentRun: (id: string) => request<{ run: AgentRun; conversation: import('../../shared/contracts').SharedConversation; activity: Activity }>(`/api/agent-runs/${id}/retry`, { method: 'POST' }),
  executeWorkItem: (id: string, executionProfile: AgentRun['executionProfile'], accountProfile = 'default') => request<{ run: AgentRun; runs: AgentRun[]; classification: WorkItemDetail['classification']; conversation: import('../../shared/contracts').SharedConversation; activity: Activity }>(`/api/work-items/${id}/execute`, { method: 'POST', body: JSON.stringify({ executionProfile, accountProfile }) }),
  resolveExecutionPlan: (id: string, resolution: 'accepted' | 'rejected', selectedTaskIndexes?: number[], archiveParent = false) => request<{ plan: ExecutionPlan; items: WorkItem[]; parentArchived: boolean }>(`/api/execution-plans/${id}/${resolution}`, { method: 'POST', body: JSON.stringify({ selectedTaskIndexes, archiveParent }) }),
  syncLinear: () => request<LinearSyncResult>('/api/providers/linear/sync', { method: 'POST' }),
  searchLinear: (query: string) => request<{ items: WorkItem[] }>(`/api/providers/linear/search?q=${encodeURIComponent(query)}`),
  queueLinearItem: (id: string) => request<{ item: WorkItem }>(`/api/providers/linear/queue/${id}`, { method: 'POST' }),
  getLinearTeams: () => request<{ teams: LinearTeam[]; config: LinearProviderConfig }>('/api/providers/linear/teams'),
  getLinearTeamProjects: (teamId: string) => request<{ projects: LinearTeam['projects'] }>(`/api/providers/linear/teams/${teamId}/projects`),
  updateLinearConfig: (config: LinearProviderConfig) => request<{ config: LinearProviderConfig }>('/api/providers/linear/config', { method: 'PUT', body: JSON.stringify(config) }),
};
