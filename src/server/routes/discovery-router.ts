import { Router } from 'express';
import { z } from 'zod';
import { bulkDiscoveryActionSchema, resolveDiscoveryCandidateSchema, updateDiscoveryCandidateSchema } from '../../shared/contracts.js';
import type { RouteContext } from '../route-context.js';
import { runDiscovery } from '../discovery.js';

export function createDiscoveryRouter({ repository }: RouteContext) {
  const router = Router();
  router.get('/api/discovery', (request, response) => {
    const view = z.enum(['pending', 'reviewed']).catch('pending').parse(request.query.view);
    response.json(repository.getDiscoveryInbox(view));
  });
  router.post('/api/discovery/scan', (_request, response) => {
    const inbox = repository.getDiscoveryInbox();
    if (!inbox.running) void runDiscovery(repository).catch((error) => console.error('Discovery scan failed:', error));
    response.status(202).json({ started: !inbox.running });
  });
  router.post('/api/discovery/:id/restore', (request, response) => {
    const candidate = repository.restoreDiscoveryCandidate(request.params.id);
    if (!candidate) return response.status(409).json({ error: 'Only dismissed or snoozed discoveries can be restored.' });
    response.json({ candidate });
  });
  router.post('/api/discovery/:id/:action', (request, response) => {
    const action = z.enum(['convert', 'dismiss', 'snooze', 'merge']).parse(request.params.action);
    const body = resolveDiscoveryCandidateSchema.parse(request.body ?? {});
    const candidate = repository.resolveDiscoveryCandidate(request.params.id, action, body.workItemId);
    if (!candidate) return response.status(404).json({ error: 'Discovery candidate not found.' });
    response.json({ candidate, item: candidate.workItemId ? repository.get(candidate.workItemId) : null });
  });
  router.patch('/api/discovery/:id', (request, response) => {
    const candidate = repository.updateDiscoveryCandidate(request.params.id, updateDiscoveryCandidateSchema.parse(request.body));
    if (!candidate) return response.status(404).json({ error: 'Pending discovery candidate not found.' });
    response.json({ candidate });
  });
  router.post('/api/discovery/bulk', (request, response) => {
    const input = bulkDiscoveryActionSchema.parse(request.body);
    response.json({ candidates: repository.resolveDiscoveryCandidates(input.ids, input.action) });
  });
  return router;
}
