import type { WorkItemRepository } from './repository.js';
import { promoteRuntime } from './runtime-promotion.js';
import { runSharedBackgroundJob } from './shared-room.js';
import { waitForPromotionSlot } from './orchestrator.js';
import { OWNER_ID } from './scheduler.js';
import { cleanupIntegratedRunWorktrees } from './run-worktree.js';
import { isTransientSqliteContention } from './sqlite-contention.js';

const POLL_MS = 1_000;

/**
 * Reclaims approved preview promotions after an API restart. The approval and
 * progress message live in SQLite; the in-memory worker is disposable.
 */
export function startRuntimePromotionWorker(
  repository: WorkItemRepository,
): { stop: () => void } {
  let dispatching = false;
  let stopped = false;
  const dispatch = async () => {
    // Claim the whole poll, including recovery queries. The previous ordering
    // executed an UPDATE every second while a promotion build was already in
    // flight, creating avoidable writer contention with live agent streams.
    if (dispatching || stopped) return;
    dispatching = true;
    try {
      repository.requeueExpiredPromotionMessages();
      const id = repository.listQueuedPromotionMessageIds()[0];
      if (!id) return;
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
    } catch (error) {
      // Timer callbacks are a process boundary: no database or provider error
      // may become an unhandled rejection that takes every live agent down.
      const detail = error instanceof Error ? error.message : String(error);
      if (isTransientSqliteContention(error)) console.warn(`[runtime-promotion] SQLite busy; retrying next poll: ${detail}`);
      else console.error(`[runtime-promotion] Dispatch failed: ${detail}`);
    } finally {
      dispatching = false;
    }
  };

  void dispatch();
  const timer = setInterval(() => void dispatch(), POLL_MS);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
