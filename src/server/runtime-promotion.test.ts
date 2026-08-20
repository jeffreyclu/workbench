import { describe, expect, it } from 'vitest';
import { activeAgentCount, isRuntimeApproval } from './runtime-promotion.js';
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

describe('activeAgentCount', () => {
  it('detects running agent messages and ignores system promotion progress', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.ensureDefaultConversation();
    repository.createSharedMessage('system', 'Promoting…', 'running', conversation.id);
    expect(activeAgentCount(database)).toBe(0);
    repository.createSharedMessage('codex', 'Working…', 'running', conversation.id);
    expect(activeAgentCount(database)).toBe(1);
    database.close();
  });
});
