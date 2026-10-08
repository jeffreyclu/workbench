import { Router } from 'express';
import { z } from 'zod';
import { createConsolidationProposal, resolveConsolidationProposal } from '../consolidation-apply.js';
import type { RouteContext } from '../route-context.js';

export function createConsolidationRouter({ repository }: RouteContext) {
  const router = Router();
  router.post('/api/consolidation/proposals', async (_request, response, next) => {
    try {
      const result = await createConsolidationProposal(repository);
      if (result.outcome === 'pending') return response.status(409).json({ error: 'A consolidation proposal is already pending. Accept or reject it first.', proposal: result.proposal });
      if (result.outcome === 'building') return response.status(409).json({ error: 'A consolidation proposal is already being built.' });
      response.status(result.outcome === 'created' ? 201 : 200).json({ proposal: result.proposal });
    } catch (error) { next(error); }
  });
  router.post('/api/consolidation/proposals/:id/:resolution', (request, response, next) => {
    try {
      const resolution = z.enum(['accepted', 'rejected']).parse(request.params.resolution);
      const proposal = resolveConsolidationProposal(repository, request.params.id, resolution);
      if (!proposal) return response.status(404).json({ error: 'Pending consolidation proposal not found.' });
      response.json({ proposal });
    } catch (error) { next(error); }
  });
  return router;
}
