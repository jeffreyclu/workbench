import type { WorkItemRepository } from './repository.js';
import { promoteRuntime } from './runtime-promotion.js';
import { runSharedBackgroundJob } from './shared-room.js';

const POLL_MS = 1_000;

/**
 * Reclaims approved preview promotions after an API restart. The approval and
 * progress message live in SQLite; the in-memory worker is disposable.
 */
export function startRuntimePromotionWorker(
  repository: WorkItemRepository,
): { stop: () => void } {
  const dispatch = () => {
    for (const id of repository.listRunningPromotionMessageIds()) {
      void runSharedBackgroundJob(
        repository,
        id,
        (signal, onProgress) => promoteRuntime(signal, onProgress),
      );
    }
  };

  dispatch();
  const timer = setInterval(dispatch, POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
