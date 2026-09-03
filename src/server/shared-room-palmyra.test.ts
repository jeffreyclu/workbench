import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { dispatchNextSharedTurn } from './shared-room.js';

const palmyraOutputs = vi.hoisted(() => ({ queued: [] as string[] }));

// Palmyra answers through Writer's hosted API, so only the provider runner is
// stubbed. Dispatch, lease claim, persisted context, and lifecycle stay real.
vi.mock('./palmyra-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./palmyra-agent.js')>()),
  runPalmyraAgent: vi.fn(async (options: { onProgress?: (output: string) => void }) => {
    if (!process.env.WRITER_API_KEY?.trim()) throw new Error('Palmyra is not configured: set WRITER_API_KEY.');
    options.onProgress?.('Decision: Inspect the request.\n● Palmyra used a tool');
    const output = palmyraOutputs.queued.shift() ?? 'A database index speeds up lookups.';
    return {
      output, agent: 'palmyra',
      usage: { inputTokens: 12, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: 7 },
      fallbackFrom: null, fallbackReason: null, sessionId: null, costUsd: null,
      messages: [{ role: 'user', content: 'What is a database index?' }, { role: 'assistant', content: output }],
      peakContextTokens: 12,
    };
  }),
}));

describe('Palmyra as a conversation provider', () => {
  const previousKey = process.env.WRITER_API_KEY;

  beforeEach(() => {
    process.env.WRITER_API_KEY = 'test-writer-key';
    palmyraOutputs.queued.length = 0;
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.WRITER_API_KEY;
    else process.env.WRITER_API_KEY = previousKey;
  });

  it('answers a turn dispatched to palmyra without creating an agent run', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Palmyra provider', null);
    repository.createSharedMessage('jeffrey', 'What is a database index?', 'queued', conversation.id, [], 'palmyra');

    const replies = dispatchNextSharedTurn(repository, conversation.id);
    expect(replies.map((reply) => reply.author)).toEqual(['palmyra']);

    // The reply resolves asynchronously; the lease claim is the step that used
    // to reject a non-Codex, non-Claude author and strand the turn as queued.
    await vi.waitFor(() => {
      const current = repository.getSharedMessageById(replies[0].id)!;
      expect(current.status).toBe('completed');
      expect(current.body).toBe('A database index speeds up lookups.');
      expect(current.body).not.toContain('Decision:');
      expect(current.body).not.toContain('Palmyra used');
      expect(current.model).toBe('palmyra-x5');
    });
    expect(repository.getConversationPalmyraContext(conversation.id)).toContain('database index');
    database.close();
  });

  it('fails the turn with the reason when no Writer key is configured', async () => {
    delete process.env.WRITER_API_KEY;
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Palmyra unavailable', null);
    repository.createSharedMessage('jeffrey', 'Anything?', 'queued', conversation.id, [], 'palmyra');

    const replies = dispatchNextSharedTurn(repository, conversation.id);
    await vi.waitFor(() => {
      const current = repository.getSharedMessageById(replies[0].id)!;
      expect(current.status).toBe('failed');
      expect(current.error).toContain('WRITER_API_KEY');
    });
    database.close();
  });

  it('retains the selected X6 model label when the harness recovers a response', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Palmyra X6 recovery', null);
    repository.setConversationExecutionProfile(conversation.id, 'palmyra-x6');
    palmyraOutputs.queued.push('Tell me the specific failure and I will fix it.', 'Recovered after inspecting the available evidence.');
    repository.createSharedMessage('jeffrey', 'Diagnose it from the available evidence.', 'queued', conversation.id, [], 'palmyra', 'palmyra-x6');

    const [reply] = dispatchNextSharedTurn(repository, conversation.id);
    await vi.waitFor(() => {
      expect(repository.getSharedMessageById(reply.id)).toMatchObject({
        status: 'completed',
        body: 'Recovered after inspecting the available evidence.',
        model: 'palmyra-x6',
      });
    });
    database.close();
  });
});
