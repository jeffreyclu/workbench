import { Router } from 'express';
import { z } from 'zod';
import { listAgentAccounts, startAgentAccountLogin } from '../agent-accounts.js';

export function createAgentAccountRouter() {
  const router = Router();
  router.get('/api/agent-accounts', (_request, response) => response.json({ accounts: listAgentAccounts() }));
  router.post('/api/agent-accounts/login', (request, response, next) => {
    try {
      const input = z.object({ provider: z.enum(['codex', 'claude']), name: z.string() }).parse(request.body ?? {});
      response.status(202).json({ accounts: startAgentAccountLogin(input.provider, input.name) });
    } catch (error) { next(error); }
  });
  return router;
}
