import type { Request, RequestHandler } from 'express';
import type { WorkItemRepository } from './repository.js';

/**
 * Most mutating work-item routes already log a rich, dynamic activity entry
 * from inside `WorkItemRepository` itself (archive/restore/complete,
 * addReference, addTaskLink, createFollowUp, resolveProviderConflict, the
 * execution routes, etc.) — that coverage is correct and this middleware must
 * not duplicate it.
 *
 * This table exists for the routes that had no coverage anywhere: the two
 * "remove" endpoints for task links and references, and the top-level work
 * item delete. It is declarative on purpose — adding a new mutating route
 * that should log an activity means adding one line here, not remembering to
 * sprinkle an `addActivity` call inside the handler (that per-handler pattern
 * is exactly how these routes went unlogged in the first place).
 */
interface ActivityDescriptor {
  kind: string;
  actor: 'jeffrey' | 'system';
  body: (request: Request, repository: WorkItemRepository) => string;
}

/** Express permits repeated params, but these routes are all single-id paths. */
function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

const ROUTES: Record<string, ActivityDescriptor> = {
  'DELETE /api/work-items/:id/linked-tasks/:linkedTaskId': {
    kind: 'task_unlinked',
    actor: 'jeffrey',
    // The link row is gone by the time this runs, but the linked task itself
    // is not — only the association was removed — so its title is still
    // available for a readable body, matching the `task_linked` wording used
    // when the link was created.
    body: (request, repository) => {
      const linkedTaskId = routeParam(request, 'linkedTaskId');
      const linked = repository.get(linkedTaskId);
      return linked ? `Unlinked task: ${linked.title}` : `Unlinked task ${linkedTaskId}`;
    },
  },
  'DELETE /api/work-items/:id/references/:referenceId': {
    kind: 'reference_removed',
    actor: 'jeffrey',
    // The reference row is already deleted by the time this middleware runs,
    // so its title/url are not recoverable here. This mirrors the existing
    // id-only style used elsewhere for post-delete audit entries (e.g. the
    // "Deleted work item {id}" audit entry below).
    body: (request) => `Removed reference ${routeParam(request, 'referenceId')}`,
  },
  'DELETE /api/work-items/:id': {
    kind: 'deleted',
    actor: 'jeffrey',
    // The work item is soft-deleted (deleted_at set, row still present), so
    // this activity row is written against the same id as the existing
    // `destructive_action` audit entry — it is not reachable through
    // GET /api/work-items/:id afterwards (that route excludes deleted rows),
    // but it keeps the activities table complete for any tooling that reads
    // it directly, and costs nothing to write.
    body: (request) => `Deleted work item ${routeParam(request, 'id')}`,
  },
};

/**
 * Writes one `activities` row for the declared work-item routes above,
 * whenever the response completes with a 2xx. Runs after the route handler
 * (via the `finish` event) so `request.route.path` is populated by Express's
 * router by the time it fires — the same technique `createRequestAuditMiddleware`
 * uses for the audit-log table.
 */
export function createWorkItemActivityMiddleware(repository: WorkItemRepository): RequestHandler {
  return (request, response, next) => {
    response.once('finish', () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return;
      const routePath = request.route?.path;
      if (typeof routePath !== 'string') return;
      const descriptor = ROUTES[`${request.method} ${routePath}`];
      const workItemId = routeParam(request, 'id');
      if (!descriptor || !workItemId) return;
      try {
        repository.addActivity(workItemId, descriptor.actor, descriptor.kind, descriptor.body(request, repository));
      } catch (error) {
        // A completed request must not become an uncaught exception if a second
        // SQLite writer briefly holds the lock. The failure remains observable.
        console.error('Could not record work-item activity:', error);
      }
    });
    next();
  };
}
