import { useQuery } from '@tanstack/react-query';
import { api } from '../../data/api';

export const navigationQueryKeys = {
  workItemCounts: ['work-item-counts'] as const,
  conversationCount: ['conversation-count'] as const,
};

export function useNavigationCounts() {
  const workItems = useQuery({ queryKey: navigationQueryKeys.workItemCounts, queryFn: api.getWorkItemCounts });
  const conversations = useQuery({ queryKey: navigationQueryKeys.conversationCount, queryFn: api.getConversationCount });
  return { workItems, conversations };
}
