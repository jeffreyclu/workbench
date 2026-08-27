import { api } from '../../data/api';

export const conversationQueryKeys = {
  detail: (conversationId: string | null) => ['shared-conversation', conversationId] as const,
  search: (query: string) => ['shared-conversation-search', query] as const,
  messages: (conversationId: string | null) => ['shared-messages', conversationId] as const,
  agentEvents: (conversationId: string | null) => ['shared-agent-events', conversationId] as const,
  rail: (view: 'active' | 'archive') => ['shared-conversations', view] as const,
};

export const conversationData = {
  get: (conversationId: string) => api.getSharedConversation(conversationId),
  list: (view: 'active' | 'archive', cursor?: string) => api.listSharedConversations(view, cursor),
  listMessages: (conversationId: string) => api.listSharedMessages(conversationId),
  listAgentEvents: (conversationId: string) => api.listAgentStreamEvents(conversationId),
  search: (query: string) => api.searchSharedConversations(query, 40),
};
