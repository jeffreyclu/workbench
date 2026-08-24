import { Router } from 'express';
import type { RouteContext } from '../route-context.js';
import { createWorkbenchMcpHandler, rejectUnsupportedMcpMethod } from '../workbench-mcp.js';

export function createMcpRouter({ repository, admin }: RouteContext) {
  const router = Router();
  router.post('/mcp', createWorkbenchMcpHandler(repository, admin.mcpActions()));
  router.get('/mcp', rejectUnsupportedMcpMethod);
  router.delete('/mcp', rejectUnsupportedMcpMethod);
  return router;
}
