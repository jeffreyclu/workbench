import type { RunInsights } from '../../shared/contracts';
import { request } from './request';

export const insightsClient = {
  getInsights: (days: 7 | 30 = 30) => request<RunInsights>(`/api/insights?days=${days}`),
};
