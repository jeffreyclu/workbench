import type { InsightsTimeframe, McpQualityHistory, MemoryDiagnostics, RunInsights } from '../../shared/contracts';
import { request } from './request';

export const insightsClient = {
  getInsights: (timeframe: InsightsTimeframe = 'all') => request<RunInsights>(`/api/insights?timeframe=${timeframe}`),
  getMemoryDiagnostics: () => request<MemoryDiagnostics>('/api/insights/memory'),
  getMcpQualityHistory: () => request<McpQualityHistory>('/api/insights/mcp-quality'),
};
