import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { dispatchNextSharedTurn } from './shared-room.js';

const chatWithPalmyra = vi.hoisted(() => vi.fn());

// Writer's HTTP responses are stubbed. Dispatch, tool execution, workspace
// selection, lease claims, stream events, and message lifecycle stay real.
vi.mock('./providers/palmyra.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/palmyra.js')>()),
  chatWithPalmyra,
}));

describe('Palmyra as a conversation provider', () => {
  const previousKey = process.env.WRITER_API_KEY;
  let workspace = '';

  beforeEach(() => {
    process.env.WRITER_API_KEY = 'test-writer-key';
    workspace = mkdtempSync(join(tmpdir(), 'palmyra-workspace-'));
    chatWithPalmyra.mockReset();
    chatWithPalmyra.mockImplementation(async () => {
      if (!process.env.WRITER_API_KEY) throw new Error('Palmyra is not configured: set WRITER_API_KEY.');
      return { content: 'A database index speeds up lookups.', toolCalls: [], usage: { inputTokens: 12, outputTokens: 7 } };
    });
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
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
      expect({ status: current.status, error: current.error }).toEqual({ status: 'completed', error: '' });
      expect(current.body).toContain('database index');
      expect(current.model).toBe('palmyra-x5');
    });
    database.close();
  });

  it('edits and verifies a file in the conversation-selected workspace', async () => {
    chatWithPalmyra
      .mockResolvedValueOnce({ content: null, toolCalls: [{ id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'palmyra.txt', content: 'Palmyra edited this\n' }) } }], usage: { inputTokens: 20, outputTokens: 8 } })
      .mockResolvedValueOnce({ content: null, toolCalls: [{ id: 'verify-1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'test "$(cat palmyra.txt)" = "Palmyra edited this"' }) } }], usage: { inputTokens: 24, outputTokens: 6 } })
      .mockResolvedValueOnce({ content: 'Implemented and verified the file edit.', toolCalls: [], usage: { inputTokens: 26, outputTokens: 9 } });
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Palmyra edits', null);
    repository.database.prepare('INSERT INTO shared_conversation_workspace_selection (conversation_id, workspace_path, updated_at) VALUES (?, ?, ?)')
      .run(conversation.id, workspace, new Date().toISOString());
    repository.createSharedMessage('jeffrey', 'Create palmyra.txt and verify it.', 'queued', conversation.id, [], 'palmyra', null, undefined, undefined, 'execute');

    const [reply] = dispatchNextSharedTurn(repository, conversation.id);
    await vi.waitFor(() => {
      const current = repository.getSharedMessageById(reply.id)!;
      expect({ status: current.status, error: current.error }).toEqual({ status: 'completed', error: '' });
    });

    expect(readFileSync(join(workspace, 'palmyra.txt'), 'utf8')).toBe('Palmyra edited this\n');
    expect(repository.listAgentStreamEvents(conversation.id).filter((event) => event.messageId === reply.id).map((event) => event.kind)).toEqual(['file_write', 'tool']);
    expect(repository.getSharedMessageById(reply.id)).toMatchObject({ author: 'palmyra', model: 'palmyra-x5', inputTokens: 70, outputTokens: 23 });
    database.close();
  });

  it('uses a durable linked run and the existing selected-workspace policy', async () => {
    writeFileSync(join(workspace, 'README.md'), 'seed\n');
    execFileSync('git', ['init'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'palmyra-test@example.com'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Palmyra Test'], { cwd: workspace });
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: workspace });
    chatWithPalmyra
      .mockResolvedValueOnce({ content: null, toolCalls: [{ id: 'write-linked', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'linked.txt', content: 'linked edit\n' }) } }], usage: { inputTokens: 20, outputTokens: 8 } })
      .mockResolvedValueOnce({ content: 'Implemented the linked edit.', toolCalls: [], usage: { inputTokens: 22, outputTokens: 7 } });
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Create linked file', description: '', priority: 1, status: 'ready', projectName: 'Test', workspacePath: workspace, dueDate: null });
    const conversation = repository.createConversation('Palmyra linked edit', task.id);
    repository.createSharedMessage('jeffrey', 'Create linked.txt.', 'queued', conversation.id, [], 'palmyra', null, undefined, undefined, 'execute');

    const [reply] = dispatchNextSharedTurn(repository, conversation.id);
    const run = repository.getRunByMessage(reply.id);
    expect(run).toMatchObject({ agent: 'palmyra', requestedAgent: 'palmyra', requestedTarget: 'palmyra', kind: 'execute' });
    await vi.waitFor(() => expect(repository.getSharedMessageById(reply.id)?.status).toBe('completed'));

    const completedRun = repository.getRunByMessage(reply.id)!;
    expect(completedRun.status).toBe('completed');
    expect(completedRun.resolvedWorkspace).toBe(workspace);
    expect(readFileSync(join(workspace, 'linked.txt'), 'utf8')).toBe('linked edit\n');
    expect(repository.getSharedContext(conversation.id, { conversationId: conversation.id })).toContain('Implemented the linked edit.');
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
