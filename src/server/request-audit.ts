import type { RequestHandler } from 'express';
import type { WorkItemRepository } from './repository.js';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    });
    next();
  };
}
