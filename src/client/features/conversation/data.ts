import { api } from '../../api';

export const conversationQueryKeys = {
  detail: (conversationId: string | null) => ['shared-conversation', conversationId] as const,
  memorySearch: (query: string) => ['memory-search', query] as const,
  messages: (conversationId: string | null) => ['shared-messages', conversationId] as const,
  rail: (view: 'active' | 'archive') => ['shared-conversations', view] as const,
};

export const conversationData = {
  get: (conversationId: string) => api.getSharedConversation(conversationId),
  list: (view: 'active' | 'archive', cursor?: string) => api.listSharedConversations(view, cursor),
  listMessages: (conversationId: string) => api.listSharedMessages(conversationId),
  searchMemory: (query: string) => api.searchMemory(query, 40),
};
