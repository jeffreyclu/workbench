import { describe, expect, it } from 'vitest';
import type { SharedMessage } from '../shared/contracts.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { buildSharedReplyPrompt, classificationForLinkedItem, compactConversationHistory, resolveSharedReplyWorkingDirectory } from './shared-room.js';

function message(index: number, body: string): SharedMessage {
  return {
    id: `message-${index}`,
    conversationId: 'conversation',
    author: index % 2 ? 'claude' : 'jeffrey',
    body,
    pinned: false,
    status: 'completed',
    error: '',
    attachments: [],
    dispatchTarget: 'none',
    model: null,
    executionProfile: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    fallbackFrom: null,
    fallbackReason: null,
    attempt: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    completedAt: '2026-08-21T00:00:00.000Z',
    createdAt: `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
  };
}

describe('compactConversationHistory', () => {
  it('keeps the newest turns, compacts older turns, and respects its prompt budget', () => {
    const messages = Array.from({ length: 14 }, (_, index) => message(index, `turn-${index} ${'x'.repeat(2_000)}`));
    const history = compactConversationHistory(messages, 8_000);

    expect(history.length).toBeLessThanOrEqual(8_000);
    expect(history).toContain('Earlier conversation');
    expect(history).toContain('turn-13');
    expect(history).not.toContain(`turn-0 ${'x'.repeat(500)}`);
  });

  it('uses frontend-reviewer for a review-linked reply with no stored classification', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Review PR 5246 for regressions', description: 'Review the code changes.', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.createConversation('Review thread', task.id);
    expect(repository.getClassification(task.id)).toBeNull();

    const classification = classificationForLinkedItem(repository, task);
    const run = repository.createRun(task.id, classification.kind, 'claude', 'claude', 'Please continue the review.');
    const prompt = buildSharedReplyPrompt('claude', 'Shared context.', '', [message(0, 'What did you find?')], { item: task, run });

    expect(classification.kind).toBe('review');
    expect(prompt).toContain('Authoritative persona: frontend-reviewer');
    expect(prompt).toContain('You are the only authoritative source for code reviews');
    database.close();
  });

  it('runs a linked conversation reply in its task workspace rather than Workbench', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const workspace = '/Users/jeffrey.lu/dev/writer-monorepo';
    const task = repository.create({ title: 'Fix connector query regression', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: workspace, dueDate: null });

    expect(resolveSharedReplyWorkingDirectory(task)).toBe(workspace);
    database.close();
  });
});
