import type { DiscoveryCandidate, DiscoveryInbox } from '../../shared/contracts';
import { request } from './request';

export const discoveryClient = {
  getDiscoveryInbox: (view: 'pending' | 'reviewed' = 'pending') => request<DiscoveryInbox>(`/api/discovery?view=${view}`),
  scanDiscovery: () => request<{ started: boolean }>('/api/discovery/scan', { method: 'POST' }),
  resolveDiscovery: (id: string, action: 'convert' | 'dismiss' | 'snooze' | 'merge', workItemId?: string) => request(`/api/discovery/${id}/${action}`, { method: 'POST', body: JSON.stringify({ workItemId }) }),
  updateDiscovery: (id: string, input: { title?: string; description?: string }) => request(`/api/discovery/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  bulkResolveDiscovery: (ids: string[], action: 'convert' | 'dismiss' | 'snooze') => request<{ candidates: DiscoveryCandidate[] }>('/api/discovery/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) }),
  restoreDiscovery: (id: string) => request(`/api/discovery/${id}/restore`, { method: 'POST' }),
};
