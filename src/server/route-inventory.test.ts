import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from './app.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { e2eRuntimeCapabilities } from './runtime-capabilities.js';
import { closeTestServer, listenTestServer } from './test-http-harness.js';

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
}

const baselineInventory = [
  'GET /api/health',
  'GET /api/agent-accounts',
  'GET /api/runtime/preview-status',
  'GET /api/runtime/promotion-status',
  'GET /api/discovery',
  'GET /api/github/pull-request-diff',
  'GET /api/github/pull-request-image',
  'POST /api/diff-confidence',
  'GET /api/insights',
  'GET /api/process-mining/report',
  'GET /api/process-mining/report.html',
  'GET /api/audit-log',
  'POST /api/discovery/scan',
  'POST /api/agent-accounts/login',
  'POST /api/discovery/:id/restore',
  'POST /api/discovery/:id/:action',
  'PATCH /api/discovery/:id',
  'POST /api/discovery/bulk',
  'GET /api/artifacts/open',
  'GET /api/artifacts/raw',
  'POST /api/artifacts/publish',
  'POST /api/artifacts/repair-snapshots',
  'POST /api/artifacts/refresh-feedback',
  'GET /api/artifacts/status',
  'GET /api/artifacts',
  'GET /api/artifacts/:id',
  'POST /api/artifacts/:id/republish',
  'PATCH /api/artifacts/:id',
  'DELETE /api/artifacts/:id',
  'OPTIONS /api/artifacts/:id/comments',
  'POST /api/artifacts/:id/comments',
  'GET /api/artifacts/:id/comments',
  'PATCH /api/artifacts/:id/comments/:commentId',
  'GET /api/shared/conversations',
  'GET /api/shared/conversations/:id',
  'GET /api/shared/conversations/:id/workspace-diff',
  'GET /api/shared/conversations/:id/workspace-diff/snapshots',
  'GET /api/shared/conversations/:id/workspace-diff/status',
  'GET /api/shared/conversations/:id/workspaces',
  'POST /api/shared/conversations/:id/workspace-diff/commit-and-push',
  'GET /api/shared/conversations/:id/workspace-diff/hunk-reviews',
  'PUT /api/shared/conversations/:id/workspace-diff/hunk-reviews',
  'GET /api/shared/conversations/:id/agent-events',
  'GET /api/shared/conversations/:id/feedback',
  'GET /api/shared/conversations-unread-count',
  'GET /api/shared/conversations-attention-count',
  'GET /api/shared/conversations-count',
  'POST /api/shared/conversations',
  'DELETE /api/shared/conversations/:id',
  'POST /api/shared/conversations/:id/archive',
  'POST /api/shared/conversations/:id/restore',
  'POST /api/shared/conversations/:id/undelete',
  'PATCH /api/shared/conversations/:id/preferences',
  'PATCH /api/shared/conversations/:id/brief',
  'PATCH /api/shared/conversations/:id/draft',
  'PATCH /api/shared/conversations/:id/pin',
  'PATCH /api/shared/conversations/:id/task',
  'POST /api/shared/conversations/:id/read',
  'POST /api/shared/conversations/:id/fork',
  'GET /api/shared/search',
  'GET /api/activity-memory',
  'GET /api/memory/search',
  'GET /api/shared/messages',
  'POST /api/shared/messages',
  'PATCH /api/shared/messages/:id',
  'GET /api/shared/messages/:id/retrieved-memory',
  'POST /api/shared/messages/:id/cancel',
  'POST /api/shared/messages/:id/retry',
  'POST /api/shared/messages/:id/interject',
  'POST /api/shared/messages/:id/create-tasks',
  'POST /api/shared/session-feedback',
  'GET /api/work-items',
  'GET /api/work-item-filters',
  'POST /api/work-item-filters',
  'PATCH /api/work-item-filters/:id',
  'DELETE /api/work-item-filters/:id',
  'GET /api/work-item-counts',
  'GET /api/projects',
  'GET /api/work-items-archive',
  'GET /api/usage/weekly',
  'POST /api/usage/calibration',
  'GET /api/usage/calibration',
  'POST /api/autonomy/dispatch',
  'PUT /api/queue/order',
  'POST /api/queue/proposals',
  'GET /api/queue/explain',
  'POST /api/queue/undo',
  'POST /api/queue/plan',
  'GET /api/integrations/slack',
  'POST /api/integrations/slack/test',
  'GET /api/source-connections',
  'GET /api/source-connections/figma/scope',
  'PUT /api/source-connections/figma/scope',
  'PUT /api/source-connections/grafana',
  'PUT /api/shared/conversations/:id/workspaces/selection',
  'POST /api/source-connections/:provider/mcp/oauth/start',
  'POST /api/source-connections/:provider/managed/oauth/start',
  'GET /api/source-connections/:provider/mcp/oauth/callback',
  'DELETE /api/source-connections/:provider',
  'POST /api/queue/proposals/:id/:resolution',
  'GET /api/work-items/:id',
  'GET /api/work-items/:id/workspace-diff',
  'GET /api/work-items/:id/workspaces',
  'GET /api/work-items/:id/workspace-diff/snapshots',
  'GET /api/work-items/:id/workspace-diff/status',
  'POST /api/work-items/:id/workspace-diff/commit-and-push',
  'GET /api/work-items/:id/workspace-diff/hunk-reviews',
  'PUT /api/work-items/:id/workspace-diff/hunk-reviews',
  'PUT /api/work-items/:id/workspaces/selection',
  'GET /api/work-items/:id/dependency-candidates',
  'POST /api/work-items/:id/references',
  'POST /api/work-items/:id/linked-tasks',
  'DELETE /api/work-items/:id/linked-tasks/:linkedTaskId',
  'DELETE /api/work-items/:id/references/:referenceId',
  'POST /api/work-items/:id/classify',
  'POST /api/work-items/:id/attachments',
  'DELETE /api/work-items/:id/attachments/:attachmentPath',
  'GET /api/work-items/:id/attachments/:attachmentPath',
  'POST /api/work-items',
  'POST /api/work-items/:id/follow-ups',
  'POST /api/work-items/bulk',
  'POST /api/work-items/generate-draft',
  'POST /api/sources/resolve',
  'POST /api/sources/search',
  'PATCH /api/work-items/:id',
  'POST /api/work-items/:id/unblock',
  'POST /api/work-items/:id/provider-conflicts/:field/resolve',
  'POST /api/work-items/:id/archive',
  'POST /api/work-items/:id/restore',
  'POST /api/work-items/:id/complete',
  'DELETE /api/work-items/:id',
  'POST /api/work-items/:id/activity',
  'POST /mcp',
  'GET /mcp',
  'DELETE /mcp',
  'POST /api/work-items/:id/runs',
  'POST /api/agent-runs/:id/cancel',
  'POST /api/agent-runs/:id/retry',
  'POST /api/work-items/:id/execute',
  'POST /api/execution-plans/:id/:resolution',
  'POST /api/providers/linear/sync',
  'GET /api/providers/linear/search',
  'POST /api/providers/linear/queue/:id',
  'GET /api/providers/linear/teams',
  'GET /api/providers/linear/teams/:id/projects',
  'PUT /api/providers/linear/config',
].sort();

function routeInventory(app: Express): string[] {
  const visit = (layers: ExpressLayer[]): string[] => layers.flatMap((layer) => {
    if (layer.route) {
      return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`);
    }
    return layer.handle?.stack ? visit(layer.handle.stack) : [];
  });
  return visit((app as Express & { router: { stack: ExpressLayer[] } }).router.stack).sort();
}

describe('HTTP route inventory', () => {
  let database: WorkbenchDatabase | undefined;

  afterEach(() => database?.close());

  it('preserves every explicit pre-extraction method/path registration', () => {
    database = openDatabase(':memory:');
    const app = createApp(database, e2eRuntimeCapabilities);
    expect(routeInventory(app)).toEqual(baselineInventory);
    expect(baselineInventory).toHaveLength(146);
  });

  it('preserves Express implicit HEAD handling without a separate registration', async () => {
    database = openDatabase(':memory:');
    const app = createApp(database, e2eRuntimeCapabilities);
    const { server, baseUrl } = await listenTestServer(app);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
      expect(routeInventory(app)).not.toContain('HEAD /api/health');
    } finally {
      await closeTestServer(server);
    }
  });
});
