import type { WorkbenchDatabase } from './database.js';
import type { WorkItemRepository } from './repository.js';
import { promoteRuntime } from './runtime-promotion.js';
import { runSharedBackgroundJob } from './shared-room.js';

const POLL_MS = 1_000;

/**
 * Reclaims approved preview promotions after an API restart. The approval and
 * progress message live in SQLite; the in-memory worker is disposable.
 */
export function startRuntimePromotionWorker(
  database: WorkbenchDatabase,
  repository: WorkItemRepository,
): { stop: () => void } {
  const dispatch = () => {
    const rows = database.prepare(`SELECT id FROM shared_messages
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status = 'running'
      ORDER BY created_at ASC`).all() as Array<{ id: string }>;
    for (const { id } of rows) {
      void runSharedBackgroundJob(
        repository,
        id,
        (signal, onProgress) => promoteRuntime(database, signal, onProgress, () => repository.hasLiveWork()),
      );
    }
  };

  dispatch();
  const timer = setInterval(dispatch, POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
