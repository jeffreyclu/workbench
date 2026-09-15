import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { cancelSharedReply, dispatchNextSharedTurn, isSharedReplyActive } from './shared-room.js';
import { fakeAgentDirectory } from './test-fake-agent.js';

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
      fallbackFrom: null, fallbackReason: null, sessionId: null, costUsd: 0,
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
      expect(current.estimatedCostUsd).toBe(0);
      expect(current.costSource).toBe('provider');
    });
    expect(repository.getConversationPalmyraContext(conversation.id)).toContain('database index');
    database.close();
  });

  it('runs Palmyra beside a visible Codex conversation turn by default', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Background Palmyra', null);
    repository.createSharedMessage('jeffrey', 'Explain this function.', 'queued', conversation.id, [], 'codex');
    const previousPath = process.env.PATH;
    process.env.WORKBENCH_TEST_PALMYRA_COMPANION = 'true';
    const { directory } = fakeAgentDirectory("printf '%s\\n' '{\"type\":\"result\",\"result\":\"Codex answer\"}'", "printf '%s\\n' '{\"type\":\"result\",\"result\":\"Claude answer\"}'");
    try {
      const replies = dispatchNextSharedTurn(repository, conversation.id);
      expect(replies.map((reply) => reply.author)).toEqual(['codex', 'palmyra']);
      for (const reply of replies) cancelSharedReply(repository, reply.id);
      await vi.waitFor(() => expect(replies.some((reply) => isSharedReplyActive(reply.id))).toBe(false), { timeout: 5_000 });
    } finally {
      delete process.env.WORKBENCH_TEST_PALMYRA_COMPANION;
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
      database.close();
    }
  });

  it('runs all three agents for Both and creates one grouped synthesis', async () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Three-agent synthesis', null);
    const request = repository.createSharedMessage('jeffrey', 'Compare the approaches.', 'queued', conversation.id, [], 'both');
    const previousPath = process.env.PATH;
    process.env.WORKBENCH_TEST_PALMYRA_COMPANION = 'true';
    palmyraOutputs.queued.push('## Problem\nCompare approaches.\n\n## Solution\nUse the safer option.\n\n## Context\nPalmyra checked independently.');
    const answer = "printf '%s\\n' '{\"type\":\"result\",\"result\":\"## Problem\\nCompare approaches.\\n\\n## Solution\\nUse the safer option.\\n\\n## Context\\nVerified independently.\"}'";
    const { directory } = fakeAgentDirectory(answer, answer);
    try {
      const replies = dispatchNextSharedTurn(repository, conversation.id);
      expect(replies.map((reply) => reply.author)).toEqual(['codex', 'claude', 'palmyra']);
      await vi.waitFor(() => {
        const synthesis = repository.listAllSharedMessages(conversation.id).find((message) => message.author === 'system' && message.body.startsWith('Synthesis:'));
        expect(synthesis).toMatchObject({ status: 'completed', dispatchGroupId: request.id });
      }, { timeout: 8_000 });
      expect(repository.listAllSharedMessages(conversation.id).filter((message) => message.author === 'system' && message.body.startsWith('Synthesis:'))).toHaveLength(1);
    } finally {
      delete process.env.WORKBENCH_TEST_PALMYRA_COMPANION;
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
      database.close();
    }
  }, 10_000);

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

  it('normalizes a legacy X6 conversation to the supported X5 model', async () => {
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
        model: 'palmyra-x5',
        executionProfile: 'palmyra-x5',
      });
    });
    database.close();
  });
});
