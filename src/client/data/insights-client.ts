import type { LifecycleReportStatus, RunInsights, UsageCalibration, UsageCalibrationHistoryEntry, WeeklyUsageReport } from '../../shared/contracts';
import { request } from './request';

export const insightsClient = {
  getInsights: (days: 7 | 30 = 30) => request<RunInsights>(`/api/insights?days=${days}`),
  getWeeklyUsage: () => request<WeeklyUsageReport>('/api/usage/weekly'),
  getLifecycleReport: () => request<LifecycleReportStatus>('/api/process-mining/report'),
  getUsageCalibrationHistory: (provider: UsageCalibration['provider'] = 'claude') =>
    request<{ calibrations: UsageCalibrationHistoryEntry[] }>(`/api/usage/calibration?provider=${provider}`),
  submitUsageCalibration: (input: { provider: UsageCalibration['provider']; observedAt: string; observedPercentage: number; resetsAt: string | null }) =>
    request<{ calibration: UsageCalibration }>('/api/usage/calibration', { method: 'POST', body: JSON.stringify(input) }),
};
