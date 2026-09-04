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
    editFinalResponse.mockResolvedValue('Problem: The API process stopped. Solution: I restarted it. Context: The health route passed.');
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
      body: 'Problem: The API process stopped. Solution: I restarted it. Context: The health route passed.',
    }));

    expect(editFinalResponse).toHaveBeenCalledWith(expect.stringContaining('\n\n'), 'Restart the API.');
    database.close();
  });
});
