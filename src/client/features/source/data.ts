import type { BrokerSourceId } from '../../../shared/contracts';
import { api } from '../../api';

export const sourceQueryKeys = {
  connections: ['source-connections'] as const,
  figmaScope: ['figma-scope'] as const,
  search: (source: BrokerSourceId, query: string) => ['source-search', source, query] as const,
};

export const sourceData = {
  listConnections: api.listSourceConnections,
  disconnect: api.disconnectSource,
  startManagedMcpOAuth: api.startManagedMcpOAuth,
  getFigmaScope: api.getFigmaScope,
  updateFigmaScope: api.updateFigmaScope,
  search: api.searchSources,
  resolveUrl: api.resolveSourceUrl,
};
