import type { LifecycleReportStatus, RunInsights } from '../../shared/contracts';
import { request } from './request';

export const insightsClient = {
  getInsights: (days: 7 | 30 = 30) => request<RunInsights>(`/api/insights?days=${days}`),
  getLifecycleReport: () => request<LifecycleReportStatus>('/api/process-mining/report'),
};
