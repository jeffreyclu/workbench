import { describe, expect, it } from 'vitest';
import type { SharedMessage } from '../shared/contracts.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { accountProfileForSharedReply, buildSharedReplyPrompt, classificationForLinkedItem, compactConversationHistory, compactKeyPoints, compactSharedBrief, hasUntrackedContinuationClaim, memoryQueryForSharedReply, resolveSharedReplyWorkingDirectory } from './shared-room.js';

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
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    fallbackFrom: null,
    fallbackReason: null,
    attempt: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    retrievedMemoryCount: null,
    completedAt: '2026-08-21T00:00:00.000Z',
    createdAt: `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
  };
}

describe('compactConversationHistory', () => {
  it('rejects a reply that promises to report after untracked background work', () => {
    expect(hasUntrackedContinuationClaim("q09 is running in the background; I'll report when it finishes.")).toBe(true);
    expect(hasUntrackedContinuationClaim("The rewritten q09 fixture is now running; I'll report the pass/fail the moment it lands.")).toBe(true);
    expect(hasUntrackedContinuationClaim('Waiting for the background probe to complete before continuing analysis.')).toBe(true);
    expect(hasUntrackedContinuationClaim('My subagent is still running; I will report when it finishes.')).toBe(true);
    expect(hasUntrackedContinuationClaim('The command completed with 18 passing checks.')).toBe(false);
  });

  it('keeps the newest turns, compacts older turns, and respects its prompt budget', () => {
    const messages = Array.from({ length: 14 }, (_, index) => message(index, `turn-${index} ${'x'.repeat(2_000)}`));
    const history = compactConversationHistory(messages, 3_000);

    expect(history.length).toBeLessThanOrEqual(3_000);
    expect(history).toContain('Earlier conversation');
    expect(history).toContain('turn-13');
    expect(history).not.toContain(`turn-0 ${'x'.repeat(500)}`);
  });

  it('caps the scoped brief and relies on retrieved memory for older detail', () => {
    const brief = `start ${'x'.repeat(2_800)} end`;
    const compacted = compactSharedBrief(brief);

    expect(compacted.length).toBeLessThanOrEqual(800);
    expect(compacted).toContain('characters compacted; use retrieved memory');
    expect(compacted).toContain('start');
    expect(compacted).toContain('end');
  });

  it('preserves a buried decision when compacting a shared brief', () => {
    const compacted = compactKeyPoints(`Opening detail\n${'x'.repeat(2_000)}\nDecision: retrieve only relevant memories, up to 40.\n${'y'.repeat(2_000)}`, 250);

    expect(compacted).toContain('Decision: retrieve only relevant memories, up to 40.');
  });

  it('grounds a short follow-up retrieval query in the preceding user decision', () => {
    const messages = [
      message(0, 'Cut prompt tokens, but do not lose durable decisions.'),
      message(1, 'I found the shared-room history budget is 3,000 characters.'),
      message(2, 'Yes, do it.'),
    ];

    expect(memoryQueryForSharedReply(messages)).toBe('Cut prompt tokens, but do not lose durable decisions.\nYes, do it.');
  });

  it('does not contaminate a standalone question with an unrelated prior control turn', () => {
    const messages = [
      message(0, 'Approve the Workbench preview.'),
      message(1, 'That preview is now live.'),
      message(2, 'What are my hobbies?'),
    ];

    expect(memoryQueryForSharedReply(messages)).toBe('What are my hobbies?');
  });

  it('injects only memory matches that clear the query-relative relevance threshold', () => {
    const retrieved = Array.from({ length: 9 }, (_, index) => ({
      source: 'message', title: `Memory ${index + 1}`, body: `Detail ${index + 1}`, createdAt: '2026-08-25T00:00:00.000Z', score: index < 3 ? 0.03 - index * 0.001 : 0.01,
    }));

    const prompt = buildSharedReplyPrompt('codex', 'Shared context.', '', [], undefined, retrieved);

    expect(prompt).toContain('Retrieved memory (3 relevant matches');
    expect(prompt).toContain('Memory 3');
    expect(prompt).not.toContain('Memory 4');
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

  it('uses an explicit room profile, then falls back to the task-scoped default', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const externalTask = repository.create({ title: 'Fix connector query regression', description: '', priority: 1, status: 'ready', projectName: 'Connectors', workspacePath: '/Users/jeffrey.lu/dev/writer-monorepo', dueDate: null });
    const workbenchTask = repository.create({ title: 'Fix room routing', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });

    expect(accountProfileForSharedReply(null, 'default')).toBe('default');
    expect(accountProfileForSharedReply(null)).toBe('default');
    expect(accountProfileForSharedReply(externalTask)).toBe('default');
    expect(accountProfileForSharedReply(workbenchTask)).toBe('personal');
    database.close();
  });
});
