import type { WorkItemRepository } from './repository.js';
import { promoteRuntime } from './runtime-promotion.js';
import { runSharedBackgroundJob } from './shared-room.js';
import { waitForPromotionSlot } from './orchestrator.js';
import { OWNER_ID } from './scheduler.js';
import { cleanupIntegratedRunWorktrees } from './run-worktree.js';

const POLL_MS = 1_000;

/**
 * Reclaims approved preview promotions after an API restart. The approval and
 * progress message live in SQLite; the in-memory worker is disposable.
 */
export function startRuntimePromotionWorker(
  repository: WorkItemRepository,
): { stop: () => void } {
  let dispatching = false;
  const dispatch = async () => {
    repository.requeueExpiredPromotionMessages();
    if (dispatching) return;
    const id = repository.listQueuedPromotionMessageIds()[0];
    if (!id) return;
    dispatching = true;
    await runSharedBackgroundJob(
      repository,
      id,
      async (signal, onProgress) => {
        await waitForPromotionSlot(repository, OWNER_ID, signal, onProgress);
        const result = await promoteRuntime(signal, onProgress);
        repository.completeQueuedPromotionMessages(id, 'Preview approval was combined into the release that just promoted.');
        // Promotion state must flip as soon as the new runtime is verified.
        // Cleanup is deliberately post-release so filesystem housekeeping can
        // never leave the UI claiming a successful release is still running.
        void cleanupIntegratedRunWorktrees().catch(() => { /* The next promotion/GC retries safe cleanup. */ });
        return result;
      },
      { claimQueuedPromotion: true },
    );
    dispatching = false;
  };

  void dispatch();
  const timer = setInterval(() => void dispatch(), POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
