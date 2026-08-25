import type { QueueItemExplanation, QueueOrderChange, QueueProposal, WorkItem } from '../../shared/contracts';
import { request } from './request';

/** Mirrors the server's QueuePlan, which is not part of the shared contract. */
export interface QueuePlan {
  orderedItemIds: string[];
  explanations: QueueItemExplanation[];
  rationale: string;
}

export const queueClient = {
  reorderQueue: (input: { itemId: string; beforeId?: string; afterId?: string; stack: 'attention' | 'workbench' }) => request<{ items: WorkItem[] }>('/api/queue/order', { method: 'PUT', body: JSON.stringify(input) }),
  resolveQueueProposal: (id: string, resolution: 'accepted' | 'rejected') => request<{ proposal: QueueProposal; items: WorkItem[] }>(`/api/queue/proposals/${id}/${resolution}`, { method: 'POST' }),
  planQueue: (stack: 'attention' | 'workbench' = 'attention') => request<{ proposal: QueueProposal; items: WorkItem[] }>('/api/queue/plan', { method: 'POST', body: JSON.stringify({ stack }) }),
  explainQueue: () => request<{ plan: QueuePlan; history: QueueOrderChange[] }>('/api/queue/explain'),
  undoQueue: (stack: 'attention' | 'workbench' = 'attention') => request<{ change: QueueOrderChange; items: WorkItem[] }>('/api/queue/undo', { method: 'POST', body: JSON.stringify({ stack }) }),
};
