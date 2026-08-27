import type { WorkItemRepository } from './repository.js';
import { PROMOTION_QUEUED_MESSAGE } from './promotion-messages.js';

const POLL_MS = 1_000;

/**
 * Control-plane work must not race a mutating agent run. This is deliberately
 * an orchestrator decision, not a worker prompt: an agent may request a
 * promotion, but only the durable control plane decides when the source tree is
 * quiescent enough to snapshot and switch the live runtime.
 */
export async function waitForPromotionSlot(
  repository: WorkItemRepository,
  ownerId: string,
  signal: AbortSignal,
  onProgress: (body: string) => void,
): Promise<void> {
  let announced = false;
  while (repository.hasPromotionBlockingWork(ownerId)) {
    if (signal.aborted) throw new Error('Preview promotion canceled.');
    if (!announced) {
      announced = true;
      onProgress(PROMOTION_QUEUED_MESSAGE);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
}
