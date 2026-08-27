import { Router } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { listAuditLogQuerySchema } from '../../shared/contracts.js';
import type { RouteContext } from '../route-context.js';
import { runtimePreviewStatus } from '../runtime-preview.js';
import { lastCompletedRuntimePromotion } from '../runtime-release.js';
import { LIFECYCLE_REPORT_MS, lifecycleReportMinimumCases, OWNER_ID } from '../scheduler.js';
import { DEFAULT_LIFECYCLE_REPORT_DIRECTORY, lifecycleReportStatus } from '../lifecycle-report.js';
import { describeSlackConfig, escapeSlackText, resolveSlackConfig, sendSlackMessage } from '../slack-notify.js';
import { beginRuntimeRetirement } from '../runtime-retirement.js';

export function createHealthRouter({ repository, capabilities, buildId }: RouteContext) {
  const router = Router();
  router.get('/api/health', (_request, response) => {
    response.json({ ok: true, mode: capabilities.mode, runtimeWorkActive: repository.hasRuntimeWork(OWNER_ID), ownedAgentWorkActive: repository.hasOwnedAgentWork(OWNER_ID), buildId });
  });
  return router;
}

export function createSystemRouter({ repository, admin }: RouteContext) {
  const router = Router();
  router.post('/api/runtime/retire', (_request, response) => {
    beginRuntimeRetirement();
    response.json({ retiring: true });
  });
  router.get('/api/runtime/preview-status', (_request, response) => {
    response.json(runtimePreviewStatus());
  });
  router.get('/api/runtime/promotion-status', (_request, response) => {
    const status = repository.getPromotionQueueStatus();
    const verified = lastCompletedRuntimePromotion();
    const lastBuildAt = status.lastBuild ? Date.parse(status.lastBuild.at) : Number.NEGATIVE_INFINITY;
    if (verified && Date.parse(verified.at) > lastBuildAt) {
      return response.json({ ...status, lastBuild: {
        status: 'succeeded' as const,
        at: verified.at,
        summary: 'Verified runtime promotion completed and is live.',
      } });
    }
    response.json(status);
  });
  router.get('/api/insights', (request, response) => {
    const days = z.enum(['7', '30']).catch('30').parse(request.query.days);
    response.json(repository.getRunInsights(days === '7' ? 7 : 30));
  });
  router.get('/api/process-mining/report', (_request, response) => {
    response.json(lifecycleReportStatus(repository.database, { minimumCompletedCases: lifecycleReportMinimumCases(), nextRunIntervalMs: LIFECYCLE_REPORT_MS }));
  });
  router.get('/api/process-mining/report.html', (_request, response) => {
    const reportPath = resolve(DEFAULT_LIFECYCLE_REPORT_DIRECTORY, 'report.html');
    if (!existsSync(reportPath)) return response.status(404).json({ error: 'No lifecycle report has been generated yet.' });
    response.sendFile(reportPath);
  });
  router.get('/api/audit-log', (request, response) => {
    const input = listAuditLogQuerySchema.parse(request.query);
    try { response.json(repository.listAuditLog(input.limit, input.cursor ?? null, input.category, input.workItemId)); }
    catch { response.status(400).json({ error: 'Invalid audit log cursor.' }); }
  });
  router.get('/api/integrations/slack', (_request, response) => {
    response.json({ notifications: describeSlackConfig() });
  });
  router.post('/api/integrations/slack/test', async (request, response, next) => {
    try {
      const input = z.object({ message: z.string().trim().max(2_000).default('') }).parse(request.body ?? {});
      const status = describeSlackConfig();
      if (!status.configured) return response.status(400).json({ error: status.problem });
      const body = input.message || 'Workbench outbound Slack notifications are configured and working.';
      const text = resolveSlackConfig()?.mode === 'workflow'
        ? `:satellite_antenna: Workbench test message\n${body}`
        : `:satellite_antenna: *Workbench test message*\n${escapeSlackText(body)}`;
      const result = await sendSlackMessage(text);
      if (!result.ok) return response.status(502).json({ error: result.error, mode: result.mode, attempts: result.attempts });
      response.json({ delivered: true, mode: result.mode, channel: result.channel, attempts: result.attempts });
    } catch (error) { next(error); }
  });
  return router;
}
