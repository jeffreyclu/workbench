import { Router } from 'express';
import { z } from 'zod';
import { createAgentRunSchema, accountProfileSchema } from '../../shared/contracts.js';
import type { RouteContext } from '../route-context.js';

export function createExecutionRouter({ admin }: RouteContext) {
  const router = Router();
  router.post('/api/work-items/:id/runs', async (request, response) => {
    const input = createAgentRunSchema.parse(request.body);
    admin.sendAction(response, await admin.startAgentRun(request.params.id, input, { actor: 'jeffrey', force: false }));
  });
  router.post('/api/agent-runs/:id/cancel', (request, response) => {
    admin.sendAction(response, admin.cancelRun(request.params.id), 200);
  });
  router.post('/api/agent-runs/:id/retry', async (request, response) => {
    admin.sendAction(response, await admin.retryRun(request.params.id, { force: false }));
  });
  router.post('/api/work-items/:id/execute', async (request, response) => {
    const { executionProfile, accountProfile } = z.object({ executionProfile: z.enum(['economy', 'standard', 'deep']).nullable().default(null), accountProfile: accountProfileSchema.optional() }).parse(request.body ?? {});
    admin.sendAction(response, await admin.startWorkItemExecution(request.params.id, { executionProfile, accountProfile, force: false }));
  });
  router.post('/api/execution-plans/:id/:resolution', (request, response) => {
    const resolution = z.enum(['accepted', 'rejected']).parse(request.params.resolution);
    const { selectedTaskIndexes, archiveParent } = z.object({
      selectedTaskIndexes: z.array(z.number().int().nonnegative()).optional(),
      archiveParent: z.boolean().default(false),
    }).parse(request.body ?? {});
    admin.sendAction(response, admin.resolvePlan(request.params.id, resolution, selectedTaskIndexes, archiveParent), 200);
  });
  return router;
}
