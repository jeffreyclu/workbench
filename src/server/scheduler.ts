import { randomUUID } from 'node:crypto';
import { executeAgentRun } from './agent-runner.js';
import type { WorkItemRepository } from './repository.js';

/**
 * A durable retry/recovery loop for agent runs.
 *
 * Problem it solves: `executeAgentRun` used to be fire-and-forget from the request
 * handler. If the API process restarted mid-run, the run stayed stuck at `running`
 * forever (nothing was watching it), and any transient failure was terminal even
 * though the caller might succeed a minute later. The scheduler adds two things on
 * top of the existing claim/retry primitives in `repository.ts`:
 *   - a heartbeat that renews the lease on runs this process is actively working,
 *     so a live run's lease doesn't expire out from under it; and
 *   - a tick that reclaims runs whose lease *did* expire (crash, kill -9, restart)
 *     and dispatches anything queued and due (fresh work or a scheduled retry).
 *
 * OWNER_ID identifies this process instance so leases are per-process, not per-run:
 * a process only ever renews leases on work it itself claimed.
 */
export const OWNER_ID = randomUUID();
export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const TICK_MS = 5_000;

export function startScheduler(repository: WorkItemRepository): { stop: () => void } {
  const heartbeat = setInterval(() => {
    try { repository.renewLeases(OWNER_ID, LEASE_MS); }
    catch (error) { console.error('Scheduler heartbeat failed:', error); }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const tick = setInterval(() => {
    try {
      const { recoveredRunIds, failedRunIds } = repository.reclaimExpired();
      if (recoveredRunIds.length || failedRunIds.length) {
        console.log(`Scheduler reclaimed ${recoveredRunIds.length} run(s) for retry and marked ${failedRunIds.length} failed after interruption.`);
      }
      const { runIds } = repository.dueWork();
      for (const runId of runIds) {
        const run = repository.getRun(runId);
        if (!run) continue;
        void executeAgentRun(repository, run, OWNER_ID, LEASE_MS).catch((error) => console.error(`Scheduler dispatch failed for run ${runId}:`, error));
      }
    } catch (error) {
      console.error('Scheduler tick failed:', error);
    }
  }, TICK_MS);
  tick.unref();

  return {
    stop: () => { clearInterval(heartbeat); clearInterval(tick); },
  };
}
