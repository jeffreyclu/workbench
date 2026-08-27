import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { waitForPromotionSlot } from './orchestrator.js';
import { PROMOTION_QUEUED_MESSAGE } from './promotion-messages.js';

describe('waitForPromotionSlot', () => {
  it('blocks while agent work is live and resolves once the tree goes quiet', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const item = repository.create({ title: 'Blocking work', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: process.cwd(), dueDate: null });
    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    const ownerId = 'promotion-runtime';
    expect(repository.claimRun(run.id, ownerId, 60_000)).toBe(true);
    expect(repository.hasPromotionBlockingWork(ownerId)).toBe(true);

    const progress: string[] = [];
    const controller = new AbortController();
    const waiting = waitForPromotionSlot(repository, ownerId, controller.signal, (body) => progress.push(body));

    // The first loop iteration announces the wait synchronously, before the poll delay.
    // Do not add a wall-clock wait here: under the parallel suite it races other
    // workers for timer scheduling even though the behavior under test is sync.
    expect(progress).toEqual([PROMOTION_QUEUED_MESSAGE]);

    repository.updateRun(run.id, { status: 'completed' });
    await waiting;
    expect(repository.hasPromotionBlockingWork(ownerId)).toBe(false);
    database.close();
  });

  it('resolves immediately when there is no live work', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const controller = new AbortController();
    await expect(waitForPromotionSlot(repository, 'promotion-runtime', controller.signal, () => {})).resolves.toBeUndefined();
    database.close();
  });

  it('rejects once the signal is aborted while still waiting for a slot', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const item = repository.create({ title: 'Blocking work', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: process.cwd(), dueDate: null });
    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    expect(repository.claimRun(run.id, 'promotion-runtime', 60_000)).toBe(true);
    const controller = new AbortController();

    const waiting = waitForPromotionSlot(repository, 'promotion-runtime', controller.signal, () => {});
    controller.abort();

    await expect(waiting).rejects.toThrow('Preview promotion canceled.');
    database.close();
  });
});
