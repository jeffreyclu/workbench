import type { RequestHandler } from 'express';
import type { WorkItemRepository } from './repository.js';
import { publishRealtimeEvent, publishRealtimeWorkItemEvent, type RealtimeTopic } from './realtime.js';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function realtimeTopicsForMutation(path: string): RealtimeTopic[] {
  // Reading a conversation only changes its unread/rail metadata. Treating it
  // as a broad shared mutation invalidates the message body Jeffrey just
  // opened, so navigation immediately re-downloads the same idle thread.
  if (/^\/api\/shared\/conversations\/[^/]+\/read(?:\/|$)/.test(path)) return ['shared-metadata'];
  if (path.startsWith('/api/shared')) return ['shared', 'work-items', 'insights'];
  if (path.startsWith('/api/discovery')) return ['discovery', 'work-items'];
  if (path.startsWith('/api/artifacts')) return ['artifacts', 'work-items'];
  if (path.startsWith('/api/source-connections')) return ['runtime'];
  if (path.startsWith('/api/agent-accounts')) return ['runtime'];
  if (path.startsWith('/api/work-items') || path.startsWith('/api/agent-runs') || path.startsWith('/api/queue')) return ['work-items', 'shared', 'insights'];
  if (path.startsWith('/api/runtime')) return ['runtime', 'shared'];
  return ['work-items'];
}

/**
 * Records one durable, body-free event for every completed mutating API request.
 * Route templates are used where Express provides them, so secrets in request
 * bodies and query strings never enter the activity record.
 */
export function createRequestAuditMiddleware(repository: WorkItemRepository): RequestHandler {
  return (request, response, next) => {
    if (READ_ONLY_METHODS.has(request.method)) return next();

    response.once('finish', () => {
      const route = request.route?.path;
      const path = typeof route === 'string' ? `${request.baseUrl}${route}` : request.path;
      const workItemId = /^\/api\/work-items\/([0-9a-f-]{36})(?:\/|$)/i.exec(request.path)?.[1] ?? null;
      try {
        repository.addAuditEntry('api_mutation', 'workbench_api', `${request.method} ${path} → ${response.statusCode}`, workItemId);
      } catch (error) {
        // A completed request must not become an uncaught exception if a second
        // SQLite writer briefly holds the lock. The failure remains observable.
        console.error('Could not record API mutation:', error);
      }
      if (response.statusCode < 400) {
        const topics = realtimeTopicsForMutation(request.path);
        if (workItemId && topics.includes('work-items')) publishRealtimeWorkItemEvent(workItemId, ...topics.filter((topic) => topic !== 'work-items'));
        else publishRealtimeEvent(...topics);
      }
    });
    next();
  };
}
