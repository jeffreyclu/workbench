import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { waitForPromotionSlot } from './orchestrator.js';

describe('waitForPromotionSlot', () => {
  it('blocks while agent work is live and resolves once the tree goes quiet', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const item = repository.create({ title: 'Blocking work', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    expect(repository.hasLiveWork()).toBe(true);

    const progress: string[] = [];
    const controller = new AbortController();
    const waiting = waitForPromotionSlot(repository, controller.signal, (body) => progress.push(body));

    // The first loop iteration announces the wait synchronously, before the poll delay.
    // Do not add a wall-clock wait here: under the parallel suite it races other
    // workers for timer scheduling even though the behavior under test is sync.
    expect(progress).toEqual(['Promotion is queued by the orchestrator until active agent work reaches a durable terminal state.']);

    repository.updateRun(run.id, { status: 'completed' });
    await waiting;
    expect(repository.hasLiveWork()).toBe(false);
    database.close();
  });

  it('resolves immediately when there is no live work', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const controller = new AbortController();
    await expect(waitForPromotionSlot(repository, controller.signal, () => {})).resolves.toBeUndefined();
    database.close();
  });

  it('rejects once the signal is aborted while still waiting for a slot', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const item = repository.create({ title: 'Blocking work', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    const controller = new AbortController();

    const waiting = waitForPromotionSlot(repository, controller.signal, () => {});
    controller.abort();

    await expect(waiting).rejects.toThrow('Preview promotion canceled.');
    database.close();
  });
});
