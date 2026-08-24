import { Router } from 'express';
import { z } from 'zod';
import { listAuditLogQuerySchema, submitUsageCalibrationSchema } from '../../shared/contracts.js';
import type { RouteContext } from '../route-context.js';
import { runtimePreviewStatus } from '../runtime-preview.js';
import { OWNER_ID } from '../scheduler.js';
import { computeWeeklyUsageReport, recordUsageCalibration } from '../usage-meter.js';
import { readCodexRateLimit } from '../codex-rate-limits.js';
import { describeSlackConfig, escapeSlackText, resolveSlackConfig, sendSlackMessage } from '../slack-notify.js';

export function createHealthRouter({ repository, capabilities, buildId }: RouteContext) {
  const router = Router();
  router.get('/api/health', (_request, response) => {
    response.json({ ok: true, mode: capabilities.mode, runtimeWorkActive: repository.hasRuntimeWork(OWNER_ID), buildId });
  });
  return router;
}

export function createSystemRouter({ repository, admin }: RouteContext) {
  const router = Router();
  router.get('/api/runtime/preview-status', (_request, response) => {
    response.json(runtimePreviewStatus());
    response.json(runtimePreviewStatus());
  });
  router.get('/api/insights', (request, response) => {
    const days = z.enum(['7', '30']).catch('30').parse(request.query.days);
    response.json(repository.getRunInsights(days === '7' ? 7 : 30));
  });
  router.get('/api/audit-log', (request, response) => {
    const input = listAuditLogQuerySchema.parse(request.query);
    try { response.json(repository.listAuditLog(input.limit, input.cursor ?? null, input.category, input.workItemId)); }
    catch { response.status(400).json({ error: 'Invalid audit log cursor.' }); }
  });
  router.get('/api/usage/weekly', async (_request, response) => {
    response.json(computeWeeklyUsageReport(repository, new Date(), await readCodexRateLimit()));
  });
  router.post('/api/usage/calibration', (request, response) => {
    const input = submitUsageCalibrationSchema.parse(request.body);
    response.status(201).json({ calibration: recordUsageCalibration(repository, input.provider, input.observedAt, input.observedPercentage) });
  });
  router.get('/api/usage/calibration', (request, response) => {
    const provider = z.enum(['claude', 'codex']).default('claude').parse(request.query.provider);
    const limit = z.coerce.number().int().min(1).max(200).default(20).parse(request.query.limit);
    response.json({ calibrations: repository.listUsageCalibrations(provider, limit) });
  });
  router.post('/api/autonomy/dispatch', async (_request, response) => {
    admin.sendAction(response, await admin.dispatchAutonomousWork());
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
