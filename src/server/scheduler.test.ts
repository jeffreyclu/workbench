import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import type { AgentRun } from '../shared/contracts.js';

type ExecuteAgentRun = (repository: WorkItemRepository, run: AgentRun, ownerId?: string, leaseMs?: number, externalContext?: string) => Promise<void>;

// executeAgentRun spawns a real Codex/Claude CLI subprocess; stub it so scheduler
// dispatch tests exercise the claim/capacity logic without touching a real process.
const executeAgentRunMock = vi.fn<ExecuteAgentRun>(async () => {});
vi.mock('./agent-runner.js', () => ({
  executeAgentRun: (...args: Parameters<ExecuteAgentRun>) => executeAgentRunMock(...args),
}));

const dispatchAutonomousWorkMock = vi.fn((_repository: WorkItemRepository) => ({ dispatched: false as const, reason: 'No eligible backlog task is queued.' }));
vi.mock('./autonomous-dispatcher.js', () => ({
  dispatchAutonomousWork: (...args: [WorkItemRepository]) => dispatchAutonomousWorkMock(...args),
}));

const { startScheduler, MAX_CONCURRENT_RUNS, TICK_MS } = await import('./scheduler.js');

describe('scheduler recovery semantics (integration-level, exercised via repository primitives)', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

  function createItem() {
    return repository.create({ title: 'Scheduler task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
  }

  it('restart recovery: a run left running by a dead process (expired lease) is not silently dropped', () => {
    const item = createItem();
    const run = repository.createRun(item.id, 'research', 'codex', 'codex', '');
    // Simulate "old process claimed it, then the process died before finishing" by
    // claiming with an already-expired lease.
    repository.claimRun(run.id, 'crashed-process', -1);
    expect(repository.getRun(run.id)?.status).toBe('running');

    const { recoveredRunIds } = repository.reclaimExpired(0);
    expect(recoveredRunIds).toContain(run.id);
    const recovered = repository.getRun(run.id)!;
    expect(recovered.status).toBe('queued');
    expect(recovered.attempt).toBe(1);
    // A fresh process can now claim and finish the work the dead one couldn't.
    expect(repository.claimRun(run.id, 'new-process', 60_000)).toBe(true);
  });

  it('restart recovery: an execute run (non-idempotent filesystem edits) is failed, not silently retried', () => {
    const item = createItem();
    const run = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
    repository.claimRun(run.id, 'crashed-process', -1);

    const { failedRunIds, recoveredRunIds } = repository.reclaimExpired(0);
    expect(failedRunIds).toContain(run.id);
    expect(recoveredRunIds).not.toContain(run.id);
    expect(repository.getRun(run.id)?.status).toBe('failed');
    expect(repository.getRun(run.id)?.error).toMatch(/stopped reporting progress/);
  });

  it('dedup: a second concurrent claim on the same run is refused so it cannot run twice', () => {
    const item = createItem();
    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    expect(repository.claimRun(run.id, 'process-a', 60_000)).toBe(true);
    expect(repository.claimRun(run.id, 'process-b', 60_000)).toBe(false);
  });

  it('active dispatch: dueWork only surfaces queued runs, not ones already running or completed', () => {
    const item = createItem();
    const queuedRun = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    const runningRun = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    repository.claimRun(runningRun.id, 'process-a', 60_000);
    const completedRun = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    repository.updateRun(completedRun.id, { status: 'completed' });

    const due = repository.dueWork().runIds;
    expect(due).toContain(queuedRun.id);
    expect(due).not.toContain(runningRun.id);
    expect(due).not.toContain(completedRun.id);
  });

  it('cancel beats retry: a canceled run must not be reclaimed for retry even if its lease later expires', () => {
    const item = createItem();
    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    repository.claimRun(run.id, 'process-a', -1); // lease already "expired"
    // Jeffrey cancels while the lease looks stale.
    repository.updateRun(run.id, { status: 'canceled', completedAt: new Date().toISOString() });

    const { recoveredRunIds, failedRunIds } = repository.reclaimExpired(0);
    expect(recoveredRunIds).not.toContain(run.id);
    expect(failedRunIds).not.toContain(run.id);
    expect(repository.getRun(run.id)?.status).toBe('canceled');
  });

  it('leaves an interrupted runtime promotion reclaimable instead of failing it', () => {
    const conversation = repository.ensureDefaultConversation();
    const promotion = repository.createSharedMessage('system', 'Approval received.', 'running', conversation.id, [], 'promotion');
    expect(repository.claimSharedMessage(promotion.id, 'crashed-process', -1)).toBe(true);

    repository.reclaimExpired(0);

    expect(repository.getSharedMessageById(promotion.id)?.status).toBe('running');
    expect(repository.claimSharedMessage(promotion.id, 'new-process', 60_000)).toBe(true);
  });

  it('fails a running run with no owner lease so it cannot block a manual retry forever', () => {
    const item = createItem();
    const run = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
    repository.updateRun(run.id, { status: 'running' });

    expect(repository.surfaceStrandedRuns(0)).toContain(run.id);

    expect(repository.getRun(run.id)?.status).toBe('failed');
    expect(repository.activeRunsForItem(item.id)).toHaveLength(0);
  });
});

describe('scheduler capacity-limited dispatch', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let stop: () => void;

  function readDiagnostics() {
    return database.prepare(`SELECT event, detail FROM diagnostics ORDER BY created_at ASC`).all() as Array<{ event: string; detail: string }>;
  }

  function createQueuedRun() {
    const item = repository.create({ title: 'Capacity task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    return repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
  }

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    executeAgentRunMock.mockClear();
    dispatchAutonomousWorkMock.mockClear();
    // Simulate dispatch: claim the run (as real executeAgentRun does, occupying a
    // capacity slot) then immediately mark it completed, without touching a real
    // Codex/Claude subprocess.
    executeAgentRunMock.mockImplementation(async (repo: WorkItemRepository, run: AgentRun) => {
      repo.claimRun(run.id, 'test-owner', 60_000);
      repo.updateRun(run.id, { status: 'completed' });
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    database.close();
  });

  it('dispatches at most MAX_CONCURRENT_RUNS runs from a larger backlog, then more as capacity frees up', async () => {
    const runs = Array.from({ length: MAX_CONCURRENT_RUNS + 3 }, () => createQueuedRun());

    ({ stop } = startScheduler(repository));

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(executeAgentRunMock).toHaveBeenCalledTimes(MAX_CONCURRENT_RUNS);
    const dispatchedIds = executeAgentRunMock.mock.calls.map((call) => (call[1] as AgentRun).id);
    expect(dispatchedIds).toEqual(runs.slice(0, MAX_CONCURRENT_RUNS).map((r) => r.id));

    // The mock immediately marks dispatched runs completed, freeing capacity for
    // subsequent ticks to pick up the remaining backlog, each still capped at the ceiling.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(executeAgentRunMock).toHaveBeenCalledTimes(Math.min(runs.length, 2 * MAX_CONCURRENT_RUNS));
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(executeAgentRunMock).toHaveBeenCalledTimes(runs.length);
    const allDispatchedIds = executeAgentRunMock.mock.calls.map((call) => (call[1] as AgentRun).id);
    expect(allDispatchedIds).toEqual(runs.map((r) => r.id));
  });

  it('asks the autonomous dispatcher for one queued run on each scheduler tick', async () => {
    ({ stop } = startScheduler(repository));

    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(dispatchAutonomousWorkMock).toHaveBeenCalledTimes(1);
    expect(dispatchAutonomousWorkMock).toHaveBeenCalledWith(repository);
  });

  it('logs the queue-stalled diagnostic once per stall, not on every tick', async () => {
    // Fill capacity with runs that never complete (mock does nothing for these ids).
    const blockers = Array.from({ length: MAX_CONCURRENT_RUNS }, () => createQueuedRun());
    executeAgentRunMock.mockImplementation(async (repo: WorkItemRepository, run: AgentRun) => {
      repo.claimRun(run.id, 'test-owner', 60_000); // claims but never completes
    });
    const overflow = createQueuedRun();

    ({ stop } = startScheduler(repository));

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(executeAgentRunMock).toHaveBeenCalledTimes(blockers.length);

    // Multiple further ticks, all still stalled at capacity.
    await vi.advanceTimersByTimeAsync(TICK_MS * 3);

    const stallLogs = readDiagnostics().filter((d) => d.detail.includes('stalled at capacity'));
    expect(stallLogs).toHaveLength(1);
    expect(overflow.id).toBeTruthy(); // overflow run stays queued, never dropped

    // Free up capacity: the stall clears and the overflow run dispatches.
    for (const blocker of blockers) repository.updateRun(blocker.id, { status: 'completed' });
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(executeAgentRunMock.mock.calls.map((call) => (call[1] as AgentRun).id)).toContain(overflow.id);

    // Recreate a stall from scratch: fresh runs occupy capacity indefinitely, plus one
    // more queued behind them. This must be able to log again, since it's a new stall.
    executeAgentRunMock.mockClear();
    executeAgentRunMock.mockImplementation(async (repo: WorkItemRepository, run: AgentRun) => {
      repo.claimRun(run.id, 'test-owner', 60_000);
    });
    Array.from({ length: MAX_CONCURRENT_RUNS }, () => createQueuedRun());
    createQueuedRun();
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);

    const stallLogsAfter = readDiagnostics().filter((d) => d.detail.includes('stalled at capacity'));
    expect(stallLogsAfter.length).toBe(2);
  });
});
