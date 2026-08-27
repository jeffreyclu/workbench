import type { DiscoveryCandidate } from '../../../shared/contracts';
import { api } from '../../data/api';

export const discoveryQueryKeys = {
  inbox: (view: 'pending' | 'reviewed') => ['discovery', view] as const,
  mergeTargets: ['discovery-merge-targets'] as const,
  root: ['discovery'] as const,
};

export const discoveryData = {
  getInbox: (view: 'pending' | 'reviewed') => api.getDiscoveryInbox(view),
  getMergeTargets: () => api.listWorkItems('active', ''),
  scan: api.scanDiscovery,
  resolve: (candidate: DiscoveryCandidate, action: 'convert' | 'dismiss' | 'snooze') => api.resolveDiscovery(candidate.id, action),
  resolveMerge: (id: string, workItemId: string) => api.resolveDiscovery(id, 'merge', workItemId),
  bulkResolve: (ids: string[], action: 'convert' | 'dismiss' | 'snooze') => api.bulkResolveDiscovery(ids, action),
  restore: api.restoreDiscovery,
  update: api.updateDiscovery,
};
