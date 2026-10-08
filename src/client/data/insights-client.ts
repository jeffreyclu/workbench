import type { InsightsTimeframe, McpQualityHistory, MemoryDiagnostics, RunInsights } from '../../shared/contracts';
import type { KnowledgeDriftSummary } from '../../shared/knowledge-drift';
import { request } from './request';

export const insightsClient = {
  getInsights: (timeframe: InsightsTimeframe = 'all') => request<RunInsights>(`/api/insights?timeframe=${timeframe}`),
  getMemoryDiagnostics: () => request<MemoryDiagnostics>('/api/insights/memory'),
  getMcpQualityHistory: () => request<McpQualityHistory>('/api/insights/mcp-quality'),
  getKnowledgeDrift: () => request<KnowledgeDriftSummary | null>('/api/system/knowledge-drift'),
  recheckKnowledgeDrift: () => request<KnowledgeDriftSummary>('/api/system/knowledge-drift/check', { method: 'POST' }),
};
