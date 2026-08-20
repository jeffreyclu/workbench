import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';

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

    const { recoveredRunIds } = repository.reclaimExpired();
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

    const { failedRunIds, recoveredRunIds } = repository.reclaimExpired();
    expect(failedRunIds).toContain(run.id);
    expect(recoveredRunIds).not.toContain(run.id);
    expect(repository.getRun(run.id)?.status).toBe('failed');
    expect(repository.getRun(run.id)?.error).toMatch(/Interrupted by API restart/);
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

    const { recoveredRunIds, failedRunIds } = repository.reclaimExpired();
    expect(recoveredRunIds).not.toContain(run.id);
    expect(failedRunIds).not.toContain(run.id);
    expect(repository.getRun(run.id)?.status).toBe('canceled');
  });
});
