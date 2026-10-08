import type { WorkbenchDatabase } from './database.js';
import { runKnowledgeDriftCheck, type KnowledgeDriftReport } from './knowledge-drift.js';
import { readKnowledgeDriftReport, storeKnowledgeDriftReport } from './knowledge-drift-store.js';

export const KNOWLEDGE_DRIFT_CADENCE_MS = 24 * 60 * 60 * 1_000;
export const KNOWLEDGE_DRIFT_RETRY_MS = 60 * 60 * 1_000;
const POLL_MS = 60 * 1_000;

export function nextKnowledgeDriftRunAt(latest: KnowledgeDriftReport | null, now = Date.now()) {
  if (!latest) return now;
  const checkedAt = Date.parse(latest.checkedAt);
  return Number.isFinite(checkedAt) ? checkedAt + KNOWLEDGE_DRIFT_CADENCE_MS : now;
}

export function startKnowledgeDriftMonitor(database: WorkbenchDatabase, options: {
  now?: () => number;
  runCheck?: () => Promise<KnowledgeDriftReport>;
  pollMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const runCheck = options.runCheck ?? runKnowledgeDriftCheck;
  let stopped = false;
  let running = false;
  let nextAt = nextKnowledgeDriftRunAt(readKnowledgeDriftReport(database), now());

  const checkNow = async () => {
    if (stopped || running || now() < nextAt) return;
    running = true;
    try {
      storeKnowledgeDriftReport(database, await runCheck());
      nextAt = now() + KNOWLEDGE_DRIFT_CADENCE_MS;
    } catch (error) {
      nextAt = now() + KNOWLEDGE_DRIFT_RETRY_MS;
      console.warn('Knowledge drift check failed; Workbench will retry without blocking other work.', error);
    } finally {
      running = false;
    }
  };

  void checkNow();
  const timer = setInterval(() => void checkNow(), options.pollMs ?? POLL_MS);
  timer.unref();
  return { checkNow, stop: () => { stopped = true; clearInterval(timer); } };
}
