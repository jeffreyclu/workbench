import type { AgentRun, AgentStreamEvent, ConversationPage, ExecutionPlan, RetrievedMemoryDetail, SessionFeedback, SessionFeedbackRating, SharedConversation, SharedMessage, SharedSearchResponse } from '../../shared/contracts';
import { request } from './request';

export const conversationClient = {
  listSharedConversations: (view: 'active' | 'archive', cursor?: string) => {
    const params = new URLSearchParams({ limit: '30', view });
    if (cursor) params.set('cursor', cursor);
    return request<ConversationPage>(`/api/shared/conversations?${params}`);
  },
  searchSharedConversations: (query: string, limit = 40) => request<SharedSearchResponse>(`/api/shared/search?${new URLSearchParams({ q: query, limit: String(limit) })}`),
  getUnreadConversationCount: () => request<{ count: number }>('/api/shared/conversations-unread-count'),
  getAttentionConversationCount: () => request<{ count: number }>('/api/shared/conversations-attention-count'),
  getConversationCount: async () => {
    const page = await request<ConversationPage>('/api/shared/conversations?view=active&limit=1');
    return { count: page.totalCount };
  },
  getSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}`),
  listAgentStreamEvents: (id: string) => request<{ events: AgentStreamEvent[] }>(`/api/shared/conversations/${id}/agent-events`),
  getConversationFeedback: (id: string) => request<{ feedback: SessionFeedback | null }>(`/api/shared/conversations/${id}/feedback`),
  createSessionFeedback: (input: { conversationId?: string | null; workItemId?: string | null; rating: SessionFeedbackRating }) => request<{ feedback: SessionFeedback }>('/api/shared/session-feedback', { method: 'POST', body: JSON.stringify(input) }),
  createSharedConversation: (title = 'New conversation') => request<{ conversation: SharedConversation }>('/api/shared/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  archiveSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/archive`, { method: 'POST' }),
  restoreSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/restore`, { method: 'POST' }),
  updateSharedConversationPreferences: (id: string, preferences: { executionProfile: AgentRun['executionProfile']; accountProfile: string | null; dispatchTarget: 'both' | 'codex' | 'claude' | null }) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/preferences`, { method: 'PATCH', body: JSON.stringify(preferences) }),
  updateSharedConversationBrief: (id: string, brief: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/brief`, { method: 'PATCH', body: JSON.stringify({ brief }) }),
  updateSharedConversationDraft: (id: string, body: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/draft`, { method: 'PATCH', body: JSON.stringify({ body }) }),
  setSharedConversationTask: (id: string, workItemId: string | null) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/task`, { method: 'PATCH', body: JSON.stringify({ workItemId }) }),
  markSharedConversationRead: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/read`, { method: 'POST' }),
  forkSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/fork`, { method: 'POST' }),
  deleteSharedConversation: (id: string) => request<void>(`/api/shared/conversations/${id}`, { method: 'DELETE' }),
  undeleteSharedConversation: (id: string) => request<{ conversation: SharedConversation }>(`/api/shared/conversations/${id}/undelete`, { method: 'POST' }),
  listSharedMessages: (conversationId?: string) => request<{ messages: SharedMessage[] }>(conversationId ? `/api/shared/messages?conversationId=${encodeURIComponent(conversationId)}&limit=200` : '/api/shared/messages?limit=200'),
  createSharedMessage: (conversationId: string, body: string, dispatchTo: 'auto' | 'both' | 'codex' | 'claude' | 'none', attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }>, executionProfile: AgentRun['executionProfile'] = null, accountProfile?: string) => request<{ message: SharedMessage; replies: SharedMessage[] }>('/api/shared/messages', { method: 'POST', body: JSON.stringify({ conversationId, body, dispatchTo, attachments, executionProfile, accountProfile }) }),
  cancelSharedReply: (id: string) => request<{ message: SharedMessage }>(`/api/shared/messages/${id}/cancel`, { method: 'POST' }),
  interjectSharedMessage: (id: string) => request<{ replies: SharedMessage[]; pending: boolean }>(`/api/shared/messages/${id}/interject`, { method: 'POST' }),
  createTasksFromReport: (id: string) => request<{ plan?: ExecutionPlan; jobMessage?: SharedMessage }>(`/api/shared/messages/${id}/create-tasks`, { method: 'POST' }),
  retrySharedMessage: (id: string) => request<{ reply: SharedMessage }>(`/api/shared/messages/${id}/retry`, { method: 'POST' }),
  getRetrievedMemory: (id: string) => request<{ detail: RetrievedMemoryDetail | null }>(`/api/shared/messages/${id}/retrieved-memory`),
};
