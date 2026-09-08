import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { dispatchNextSharedTurn } from './shared-room.js';

const runAgentCommandWithFallback = vi.hoisted(() => vi.fn());
const editFinalResponse = vi.hoisted(() => vi.fn());

vi.mock('./agent-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-runner.js')>()),
  runAgentCommandWithFallback,
}));
vi.mock('./final-response-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./final-response-policy.js')>()),
  editFinalResponse,
}));

describe('shared-room final response supervision', () => {
  beforeEach(() => {
    process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY = '1';
    runAgentCommandWithFallback.mockResolvedValue({
      output: 'The API process stopped.\n\nI restarted it and checked the health route.',
      agent: 'claude',
      usage: { inputTokens: 10, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: 5 },
      fallbackFrom: null,
      fallbackReason: null,
      sessionId: 'session',
      peakContextTokens: 10,
    });
    editFinalResponse.mockResolvedValue('## Problem\nThe API process stopped.\n\n## Solution\nI restarted it.\n\n## Context\nThe health route passed.');
  });

  afterEach(() => {
    delete process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY;
    vi.clearAllMocks();
  });

  it('replaces a multi-paragraph draft before completing the visible message', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Restart API');
    repository.createSharedMessage('jeffrey', 'Restart the API.', 'queued', conversation.id, [], 'claude', 'standard');

    const [reply] = dispatchNextSharedTurn(repository, conversation.id);
    await vi.waitFor(() => expect(repository.getSharedMessageById(reply.id)).toMatchObject({
      status: 'completed',
      body: '## Problem\nThe API process stopped.\n\n## Solution\nI restarted it.\n\n## Context\nThe health route passed.',
    }));

    expect(editFinalResponse).toHaveBeenCalledWith(expect.stringContaining('\n\n'), 'Restart the API.', { verbose: false });
    database.close();
  });

  it('formats inline labels without showing a rejection or calling the editor', async () => {
    runAgentCommandWithFallback.mockResolvedValue({
      output: 'Problem: The API stopped. Solution: Restart it. Context: Health passed.',
      agent: 'claude',
      usage: { inputTokens: 10, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: 5 },
      fallbackFrom: null,
      fallbackReason: null,
      sessionId: 'session',
      peakContextTokens: 10,
    });
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Restart API');
    repository.createSharedMessage('jeffrey', 'Restart the API.', 'queued', conversation.id, [], 'claude', 'standard');

    const [reply] = dispatchNextSharedTurn(repository, conversation.id);
    await vi.waitFor(() => expect(repository.getSharedMessageById(reply.id)).toMatchObject({
      status: 'completed',
      body: '## Problem\nThe API stopped.\n\n## Solution\nRestart it.\n\n## Context\nHealth passed.',
    }));

    expect(editFinalResponse).not.toHaveBeenCalled();
    expect(repository.getSharedMessageById(reply.id)?.body).not.toContain('Draft rejected');
    database.close();
  });

  it('preserves the complete agent result when local formatting adds sections', async () => {
    const draft = `${Array.from({ length: 160 }, (_, index) => `result-${index}`).join(' ')} FINAL-RESULT`;
    const actualPolicy = await vi.importActual<typeof import('./final-response-policy.js')>('./final-response-policy.js');
    editFinalResponse.mockImplementation(actualPolicy.editFinalResponse);
    runAgentCommandWithFallback.mockResolvedValue({
      output: draft,
      agent: 'claude',
      usage: { inputTokens: 10, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: 161 },
      fallbackFrom: null,
      fallbackReason: null,
      sessionId: 'session',
      peakContextTokens: 10,
    });
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Report all results');
    repository.createSharedMessage('jeffrey', 'Report every result.', 'queued', conversation.id, [], 'claude', 'standard');

    const [reply] = dispatchNextSharedTurn(repository, conversation.id);
    await vi.waitFor(() => expect(repository.getSharedMessageById(reply.id)).toMatchObject({ status: 'completed' }));
    const body = repository.getSharedMessageById(reply.id)?.body ?? '';

    expect(body).toContain('## Problem\nReport every result.');
    expect(body).toContain('result-0');
    expect(body).toContain('result-159 FINAL-RESULT');
    expect(body).not.toContain('…');
    database.close();
  });
});
