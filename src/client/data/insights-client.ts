import type { InsightsTimeframe, RunInsights } from '../../shared/contracts';
import { request } from './request';

export const insightsClient = {
  getInsights: (timeframe: InsightsTimeframe = 'all') => request<RunInsights>(`/api/insights?timeframe=${timeframe}`),
};
