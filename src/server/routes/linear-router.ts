import { Router } from 'express';
import { z } from 'zod';
import type { RouteContext } from '../route-context.js';
import { LinearProvider } from '../providers/linear.js';

export function createLinearRouter({ repository, admin }: RouteContext) {
  const router = Router();
  router.post('/api/providers/linear/sync', async (_request, response, next) => {
    try { response.json(await admin.syncLinearProvider()); }
    catch (error) { next(error); }
  });
  router.get('/api/providers/linear/search', async (request, response, next) => {
    try {
      const query = z.string().trim().min(1).max(500).parse(request.query.q);
      let items = repository.searchLinear(query);
      const identifier = query.match(/(?:\/issue\/)?([A-Za-z]+-\d+)/i)?.[1]?.toUpperCase();
      if (items.length === 0 && identifier) {
        const provider = new LinearProvider(process.env.LINEAR_API_KEY ?? '');
        repository.upsertLinearItem(await provider.fetchIssue(identifier));
        items = repository.searchLinear(identifier);
      }
      response.json({ items });
    } catch (error) { next(error); }
  });
  router.post('/api/providers/linear/queue/:id', (request, response) => {
    admin.sendAction(response, admin.queueLinearWorkItem(request.params.id), 200);
  });
  router.get('/api/providers/linear/teams', async (_request, response, next) => {
    try { response.json(await admin.getLinearProvider()); }
    catch (error) { next(error); }
  });
  router.get('/api/providers/linear/teams/:id/projects', async (request, response, next) => {
    try { response.json(await admin.getLinearProvider(request.params.id)); }
    catch (error) { next(error); }
  });
  router.put('/api/providers/linear/config', (request, response) => {
    const config = z.object({ teamIds: z.array(z.string()).max(100), projectIds: z.array(z.string()).max(250) }).parse(request.body);
    response.json(admin.configureLinearProvider(config.teamIds, config.projectIds));
  });
  return router;
}
