import { Router } from 'express';
import { z } from 'zod';
import { createQueueProposalSchema, reorderQueueSchema } from '../../shared/contracts.js';
import type { RouteContext } from '../route-context.js';

export function createQueueRouter({ repository }: RouteContext) {
  const router = Router();
  router.put('/api/queue/order', (request, response) => {
    const input = reorderQueueSchema.parse(request.body);
    response.json({ items: repository.move(input.itemId, input, input.stack) });
  });
  router.post('/api/queue/proposals', (request, response) => {
    const input = createQueueProposalSchema.parse(request.body);
    response.status(201).json({ proposal: repository.createProposal(input.orderedItemIds, input.rationale) });
  });
  router.get('/api/queue/explain', (_request, response, next) => {
    try { response.json({ plan: repository.explainQueue(), history: repository.listQueueHistory('attention') }); }
    catch (error) { next(error); }
  });
  router.post('/api/queue/undo', (request, response, next) => {
    try {
      const stack = z.enum(['attention', 'workbench']).default('attention').parse(request.body?.stack ?? 'attention');
      const undone = repository.undoLastQueueChange(stack);
      if (!undone) return response.status(404).json({ error: 'No ordering change left to undo for this stack.' });
      response.json({ change: undone.change, items: undone.items });
    } catch (error) { next(error); }
  });
  router.post('/api/queue/plan', (request, response, next) => {
    try { response.status(201).json({ proposal: repository.buildDailyProposal(Date.now()), items: repository.list() }); }
    catch (error) { next(error); }
  });
  router.post('/api/queue/proposals/:id/:resolution', (request, response) => {
    const resolution = z.enum(['accepted', 'rejected']).parse(request.params.resolution);
    const proposal = repository.resolveProposal(request.params.id, resolution);
    if (!proposal) return response.status(404).json({ error: 'Pending proposal not found.' });
    response.json({ proposal, items: proposal.stack === 'workbench' ? repository.listWorkbench() : repository.list() });
  });
  return router;
}
