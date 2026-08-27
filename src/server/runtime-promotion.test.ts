import { describe, expect, it } from 'vitest';
import { isRuntimeApproval } from './runtime-promotion.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';

describe('isRuntimeApproval', () => {
  it.each([
    'approve the Workbench preview',
    'promote preview',
    'Deploy the preview.',
    'ship workbench preview',
  ])('accepts explicit preview approval: %s', (message) => {
    expect(isRuntimeApproval(message)).toBe(true);
  });

  it.each([
    'looks good',
    'approve it',
    'what does approve preview do?',
    'do not deploy the preview',
    'approve the task',
  ])('rejects ambiguous or unrelated text: %s', (message) => {
    expect(isRuntimeApproval(message)).toBe(false);
  });
});

describe('runtime drain state', () => {
  it('keeps the old runtime alive for both agent work and system promotion progress', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.ensureDefaultConversation();
    const ownerId = 'old-runtime';
    expect(repository.hasRuntimeWork(ownerId)).toBe(false);
    const promotion = repository.createSharedMessage('system', 'Promoting…', 'running', conversation.id);
    expect(repository.claimSharedMessage(promotion.id, ownerId, 60_000)).toBe(true);
    expect(repository.hasRuntimeWork(ownerId)).toBe(true);
    const agent = repository.createSharedMessage('codex', 'Working…', 'running', conversation.id);
    expect(repository.claimSharedMessage(agent.id, 'new-runtime', 60_000)).toBe(true);
    expect(repository.hasRuntimeWork(ownerId)).toBe(true);
    repository.updateSharedMessage(promotion.id, { status: 'completed' });
    expect(repository.hasRuntimeWork(ownerId)).toBe(false);
    database.close();
  });

  it('does not make a linked external-repository agent stream block a Workbench promotion', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const ownerId = 'old-runtime';
    const item = repository.create({ title: 'Writer-only work', description: '', priority: 1, status: 'ready', projectName: 'Writer', workspacePath: '/Users/jeffrey.lu/dev/writer-monorepo', dueDate: null });
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Implement the Writer change.');

    expect(repository.claimRun(run.id, ownerId, 60_000)).toBe(true);
    expect(repository.hasRuntimeWork(ownerId)).toBe(false);
    database.close();
  });
});
