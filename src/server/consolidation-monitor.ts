import type { ConsolidationProposal } from '../shared/contracts.js';
import { createConsolidationProposal, type CreateConsolidationOutcome } from './consolidation-apply.js';
import { getLatestConsolidationProposal } from './consolidation-store.js';
import type { WorkItemRepository } from './repository.js';

export const CONSOLIDATION_CADENCE_MS = 7 * 24 * 60 * 60 * 1_000;
export const CONSOLIDATION_RETRY_MS = 60 * 60 * 1_000;
const POLL_MS = 60 * 1_000;

export function nextConsolidationRunAt(latest: ConsolidationProposal | null, now = Date.now()) {
  if (!latest) return now;
  const createdAt = Date.parse(latest.createdAt);
  return Number.isFinite(createdAt) ? createdAt + CONSOLIDATION_CADENCE_MS : now;
}

export function startConsolidationMonitor(repository: WorkItemRepository, options: {
  now?: () => number;
  createProposal?: () => Promise<CreateConsolidationOutcome>;
  pollMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const createProposal = options.createProposal ?? (() => createConsolidationProposal(repository));
  let stopped = false;
  let running = false;
  let nextAt = nextConsolidationRunAt(getLatestConsolidationProposal(repository.database), now());

  const checkNow = async () => {
    if (stopped || running || now() < nextAt) return;
    running = true;
    try {
      const result = await createProposal();
      // A pending or in-flight proposal blocks a new one; look again on the next poll.
      if (result.outcome === 'created' || result.outcome === 'empty') nextAt = now() + CONSOLIDATION_CADENCE_MS;
    } catch (error) {
      nextAt = now() + CONSOLIDATION_RETRY_MS;
      console.warn('Knowledge consolidation pass failed; Workbench will retry without blocking other work.', error);
    } finally {
      running = false;
    }
  };

  void checkNow();
  const timer = setInterval(() => void checkNow(), options.pollMs ?? POLL_MS);
  timer.unref();
  return { checkNow, stop: () => { stopped = true; clearInterval(timer); } };
}
