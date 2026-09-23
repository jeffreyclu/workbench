import { useQuery } from '@tanstack/react-query';
import { api } from '../../data/api';

export const navigationQueryKeys = {
  workItemCounts: ['work-item-counts'] as const,
  conversationCount: ['conversation-count'] as const,
  archivedConversationCount: ['archived-conversation-count'] as const,
};

export function useNavigationCounts() {
  const workItems = useQuery({ queryKey: navigationQueryKeys.workItemCounts, queryFn: api.getWorkItemCounts });
  const conversations = useQuery({ queryKey: navigationQueryKeys.conversationCount, queryFn: api.getConversationCount });
  const archivedConversations = useQuery({ queryKey: navigationQueryKeys.archivedConversationCount, queryFn: api.getArchivedConversationCount });
  return { workItems, conversations, archivedConversations };
}
