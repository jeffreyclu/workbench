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
// The lease itself is the recovery grace period. A 45-second lease with a
// 10-second heartbeat detects a crashed runtime promptly without mistaking a
// normal slow tool call for an abandoned run.
export const LEASE_MS = 45_000;
export const HEARTBEAT_MS = 10_000;
export const TICK_MS = 5_000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Global ceiling on concurrently `running` agent runs. Each run spawns a real
 * Codex/Claude CLI subprocess, so an unbounded backlog (e.g. after a restart
 * requeues many leases, or a batch execute) would otherwise spawn unbounded
 * concurrent subprocesses on the host machine. Conservative default because this
 * runs on a laptop, not a fleet. Override with WORKBENCH_MAX_CONCURRENT_RUNS.
 */
export const MAX_CONCURRENT_RUNS = (() => {
  const raw = process.env.WORKBENCH_MAX_CONCURRENT_RUNS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
})();

export function startScheduler(repository: WorkItemRepository): { stop: () => void } {
  // Tracks whether we've already logged a "queue stalled at capacity" diagnostic for
  // the current stall, so repeated ticks don't spam the log every 5s. Resets to false
  // once capacity frees up, so the next stall can log again.
  let stallLogged = false;
  const heartbeat = setInterval(() => {
    try { repository.renewLeases(OWNER_ID, LEASE_MS); }
    catch (error) {
      repository.logDiagnostic('scheduler_error', 'scheduler', 'failure', `Heartbeat failed: ${String(error)}`, undefined, 'heartbeat_error');
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const runTick = () => {
    const start = Date.now();
    try {
      const { recoveredRunIds, failedRunIds } = repository.reclaimExpired();
      if (recoveredRunIds.length || failedRunIds.length) {
        repository.logDiagnostic(
          'scheduler_tick',
          'scheduler',
          'success',
          `Reclaimed ${recoveredRunIds.length} run(s) for retry and marked ${failedRunIds.length} failed after interruption.`,
          Date.now() - start,
        );
      }
      repository.surfaceStrandedRuns();
      const { canceledMessageIds } = repository.reclaimOrphanedQueuedMessages();
      if (canceledMessageIds.length) {
        repository.logDiagnostic(
          'scheduler_tick',
          'scheduler',
          'success',
          `Canceled ${canceledMessageIds.length} orphaned queued shared message(s) that were never claimed.`,
          Date.now() - start,
        );
      }
      const allDue = repository.dueWork();
      const { runIds } = repository.dueWork(MAX_CONCURRENT_RUNS);
      const stalled = runIds.length === 0 && allDue.runIds.length > 0;
      if (stalled) {
        if (!stallLogged) {
          repository.logDiagnostic(
            'scheduler_tick',
            'scheduler',
            'success',
            `Dispatch queue stalled at capacity: ${repository.runningRunCount()}/${MAX_CONCURRENT_RUNS} runs already running; ${allDue.runIds.length} queued run(s) waiting for capacity.`,
          );
          stallLogged = true;
        }
      } else {
        stallLogged = false;
      }
      for (const runId of runIds) {
        const run = repository.getRun(runId);
        if (!run) continue;
        void executeAgentRun(repository, run, OWNER_ID, LEASE_MS).catch((error) => {
          repository.logDiagnostic('scheduler_error', 'scheduler', 'failure', `Dispatch failed for run ${runId}: ${String(error)}`, undefined, 'dispatch_error');
        });
      }
    } catch (error) {
      repository.logDiagnostic('scheduler_error', 'scheduler', 'failure', `Tick failed: ${String(error)}`, Date.now() - start, 'tick_error');
    }
  };
  const tick = setInterval(runTick, TICK_MS);
  tick.unref();

  const retention = setInterval(() => {
    repository.runRetentionCleanup();
  }, RETENTION_MS);
  retention.unref();

  return {
    stop: () => { clearInterval(heartbeat); clearInterval(tick); clearInterval(retention); },
  };
}
