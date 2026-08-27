import { useQuery } from '@tanstack/react-query';
import { api } from '../../data/api';

export const navigationQueryKeys = {
  workItemCounts: ['work-item-counts'] as const,
  conversationCount: ['conversation-count'] as const,
};

export function useNavigationCounts() {
  const workItems = useQuery({ queryKey: navigationQueryKeys.workItemCounts, queryFn: api.getWorkItemCounts, refetchInterval: 5_000 });
  const conversations = useQuery({ queryKey: navigationQueryKeys.conversationCount, queryFn: api.getConversationCount, refetchInterval: 5_000 });
  return { workItems, conversations };
}
