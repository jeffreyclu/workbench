import type { WorkItemRepository } from './repository.js';
import { promoteRuntime } from './runtime-promotion.js';
import { runSharedBackgroundJob } from './shared-room.js';
import { waitForPromotionSlot } from './orchestrator.js';
import { OWNER_ID } from './scheduler.js';

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
