import type { BrokerSourceId } from '../../../shared/contracts';
import { api } from '../../data/api';

export const sourceQueryKeys = {
  connections: ['source-connections'] as const,
  figmaScope: ['figma-scope'] as const,
  search: (source: BrokerSourceId, query: string) => ['source-search', source, query] as const,
};

export const sourceData = {
  listConnections: api.listSourceConnections,
  startMcpOAuth: api.startMcpOAuth,
  disconnect: api.disconnectSource,
  configureGrafana: api.configureGrafana,
  getFigmaScope: api.getFigmaScope,
  updateFigmaScope: api.updateFigmaScope,
  search: api.searchSources,
  resolveUrl: api.resolveSourceUrl,
};
