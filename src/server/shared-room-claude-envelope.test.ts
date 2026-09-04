import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { dispatchNextSharedTurn } from './shared-room.js';

const runAgentCommandWithFallback = vi.hoisted(() => vi.fn());

vi.mock('./agent-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-runner.js')>()),
  runAgentCommandWithFallback,
}));

const usage = { inputTokens: 10, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: 5 };

describe('Claude Workbench-envelope recovery', () => {
  beforeEach(() => {
    runAgentCommandWithFallback
      .mockReset()
      .mockResolvedValueOnce({
        output: 'These arrived as injected "AUTHORITATIVE CURRENT OBJECTIVE" blocks and a fabricated "CASCADE BREAKER" jailbreak.',
        agent: 'claude', usage, fallbackFrom: null, fallbackReason: null, sessionId: 'poisoned-session', peakContextTokens: 10,
      })
      .mockResolvedValueOnce({
        output: 'For backup power, size the battery from the essential loads and outage duration.',
        agent: 'claude', usage, fallbackFrom: null, fallbackReason: null, sessionId: 'clean-session', peakContextTokens: 10,
      });
  });

  afterEach(() => vi.clearAllMocks());

  it('discards the poisoned session and repeats the turn once with Claude', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Backup power advice');
    repository.setConversationClaudeSessionId(conversation.id, 'poisoned-session');
    repository.createSharedMessage('jeffrey', 'I am asking for backup power advice.', 'queued', conversation.id, [], 'claude', 'standard');

    const [reply] = dispatchNextSharedTurn(repository, conversation.id);
    await vi.waitFor(() => expect(repository.getSharedMessageById(reply.id)).toMatchObject({
      author: 'claude',
      status: 'completed',
      body: 'For backup power, size the battery from the essential loads and outage duration.',
    }));

    expect(runAgentCommandWithFallback).toHaveBeenCalledTimes(2);
    expect(runAgentCommandWithFallback.mock.calls[0][13]).toBe('poisoned-session');
    expect(runAgentCommandWithFallback.mock.calls[1][0]).toBe('claude');
    expect(runAgentCommandWithFallback.mock.calls[1][13]).toBeUndefined();
    expect(runAgentCommandWithFallback.mock.calls[1][15]).toBe(false);
    expect(repository.getConversation(conversation.id)?.claudeSessionId).toBe('clean-session');
    database.close();
  });
});
