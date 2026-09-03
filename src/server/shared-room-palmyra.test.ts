import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { dispatchNextSharedTurn } from './shared-room.js';

// Palmyra answers through Writer's hosted API, so the network call is stubbed.
// Everything else — dispatch, lease claim, message lifecycle — is the real path.
vi.mock('./providers/palmyra.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/palmyra.js')>()),
  completeWithPalmyra: vi.fn(async () => {
    if (!process.env.WRITER_API_KEY?.trim()) throw new Error('Palmyra is not configured: set WRITER_API_KEY.');
    return 'A database index speeds up lookups.';
  }),
}));

describe('Palmyra as a conversation provider', () => {
  const previousKey = process.env.WRITER_API_KEY;

  beforeEach(() => { process.env.WRITER_API_KEY = 'test-writer-key'; });
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
      expect(current.body).toContain('database index');
      expect(current.model).toBe('palmyra-x5');
    });
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
});
