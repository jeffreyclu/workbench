import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const seams = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  getWorkspaceFileSource: vi.fn(),
  commitAndPushWorkspace: vi.fn(),
  getWorkspaceDiff: vi.fn(),
  getWorkspaceHeadCommit: vi.fn(),
  getWorkspaceDiffRevision: vi.fn(),
  getWorkspaceCommitDiff: vi.fn(),
  getWorkspaceRefDiff: vi.fn(),
  listWorkspaceCommits: vi.fn(),
  listWorkspaceRefCommits: vi.fn(),
  listWorkspaceRefs: vi.fn(),
  snapshotsForRepository: vi.fn(),
  captureRecordedWorkspaceDiffSnapshots: vi.fn(),
  listCandidateWorkspaces: vi.fn(),
  dispatchNextSharedTurn: vi.fn(),
  cancelSharedReply: vi.fn(),
  interjectQueuedSharedMessage: vi.fn(),
  replyInSharedRoom: vi.fn(),
  retrySharedSynthesis: vi.fn(),
  runSharedBackgroundJob: vi.fn(),
  resolveWorkingDirectory: vi.fn(),
  runAgentCommandWithFallback: vi.fn(),
  searchMemory: vi.fn(),
  collectMemoryDocuments: vi.fn(),
  indexPendingMemory: vi.fn(),
  parseFollowUpPlan: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: seams.mkdirSync,
  writeFileSync: seams.writeFileSync,
}));

vi.mock('../workspace-diff.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../workspace-diff.js')>(),
  getWorkspaceFileSource: seams.getWorkspaceFileSource,
  commitAndPushWorkspace: seams.commitAndPushWorkspace,
  getWorkspaceDiff: seams.getWorkspaceDiff,
  getWorkspaceHeadCommit: seams.getWorkspaceHeadCommit,
  getWorkspaceDiffRevision: seams.getWorkspaceDiffRevision,
  getWorkspaceCommitDiff: seams.getWorkspaceCommitDiff,
  getWorkspaceRefDiff: seams.getWorkspaceRefDiff,
  listWorkspaceCommits: seams.listWorkspaceCommits,
  listWorkspaceRefCommits: seams.listWorkspaceRefCommits,
  listWorkspaceRefs: seams.listWorkspaceRefs,
  snapshotsForRepository: seams.snapshotsForRepository,
}));

vi.mock('../workspace-diff-history.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../workspace-diff-history.js')>(),
  captureRecordedWorkspaceDiffSnapshots: seams.captureRecordedWorkspaceDiffSnapshots,
}));

vi.mock('../workspace-candidates.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../workspace-candidates.js')>(),
  listCandidateWorkspaces: seams.listCandidateWorkspaces,
}));

vi.mock('../shared-room.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared-room.js')>(),
  dispatchNextSharedTurn: seams.dispatchNextSharedTurn,
  cancelSharedReply: seams.cancelSharedReply,
  interjectQueuedSharedMessage: seams.interjectQueuedSharedMessage,
  replyInSharedRoom: seams.replyInSharedRoom,
  retrySharedSynthesis: seams.retrySharedSynthesis,
  runSharedBackgroundJob: seams.runSharedBackgroundJob,
}));

vi.mock('../agent-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent-runner.js')>(),
  resolveWorkingDirectory: seams.resolveWorkingDirectory,
  runAgentCommandWithFallback: seams.runAgentCommandWithFallback,
}));

vi.mock('../memory-index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../memory-index.js')>(),
  searchMemory: seams.searchMemory,
  collectMemoryDocuments: seams.collectMemoryDocuments,
  indexPendingMemory: seams.indexPendingMemory,
}));

vi.mock('../app-exports.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../app-exports.js')>(),
  parseFollowUpPlan: seams.parseFollowUpPlan,
}));

import { createApp } from '../app.js';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { closeTestServer } from '../test-http-harness.js';
import { e2eRuntimeCapabilities, liveRuntimeCapabilities } from '../runtime-capabilities.js';

describe('conversation router', () => {
  let database: WorkbenchDatabase;
  let server: Server;
  let baseUrl: string;
  let workspace: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    seams.listCandidateWorkspaces.mockReturnValue([]);
    seams.getWorkspaceDiff.mockResolvedValue({ workspacePath: '', branch: 'main', revision: 'rev-1', files: [], changedFiles: 0, additions: 0, deletions: 0, publish: { state: 'none' } });
    seams.getWorkspaceHeadCommit.mockResolvedValue('abc1234');
    seams.snapshotsForRepository.mockImplementation(async (snapshots: unknown) => snapshots);
    seams.collectMemoryDocuments.mockReturnValue({ upserted: 0 });
    seams.indexPendingMemory.mockResolvedValue({ documents: 0, chunks: 0 });
    seams.searchMemory.mockResolvedValue([]);
    database = openDatabase(':memory:');
    workspace = mkdtempSync(join(tmpdir(), 'conversation-router-'));
    server = createApp(database, e2eRuntimeCapabilities).listen(0);
    await new Promise<void>((listening) => server.once('listening', listening));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeTestServer(server);
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const createConversation = async (title = 'Ship the release') => {
    const response = await request('/api/shared/conversations', 'POST', { title });
    expect(response.status).toBe(201);
    return (await response.json() as { conversation: { id: string } }).conversation;
  };

  const createWorkItem = async (body: Record<string, unknown> = {}) => {
    const response = await request('/api/work-items', 'POST', { title: 'Linked item', ...body });
    expect(response.status).toBe(201);
    return (await response.json() as { item: { id: string } }).item;
  };

  describe('conversation CRUD and lifecycle', () => {
    it('creates, lists, fetches, and deletes a conversation', async () => {
      const conversation = await createConversation();
      expect((await request('/api/shared/conversations')).status).toBe(200);
      expect((await request(`/api/shared/conversations/${conversation.id}`)).status).toBe(200);
      expect((await request('/api/shared/conversations/missing')).status).toBe(404);

      const deleted = await request(`/api/shared/conversations/${conversation.id}`, 'DELETE');
      expect(deleted.status).toBe(204);
      expect((await request(`/api/shared/conversations/${conversation.id}`, 'DELETE')).status).toBe(404);
    });

    it('refuses to delete a task-linked conversation directly', async () => {
      const conversation = await createConversation();
      const item = await createWorkItem();
      await request(`/api/shared/conversations/${conversation.id}/task`, 'PATCH', { workItemId: item.id });

      const response = await request(`/api/shared/conversations/${conversation.id}`, 'DELETE');
      expect(response.status).toBe(409);
    });

    it('undeletes, archives, and restores a conversation', async () => {
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}`, 'DELETE');
      expect((await request('/api/shared/conversations/missing/undelete', 'POST')).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/undelete`, 'POST')).status).toBe(200);

      expect((await request('/api/shared/conversations/missing/archive', 'POST')).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/archive`, 'POST')).status).toBe(200);

      expect((await request('/api/shared/conversations/missing/restore', 'POST')).status).toBe(404);
      const restored = await request(`/api/shared/conversations/${conversation.id}/restore`, 'POST');
      expect(restored.status).toBe(200);
    });

    it('updates preferences, brief, draft, task link, pin, and read state', async () => {
      const conversation = await createConversation();
      expect((await request(`/api/shared/conversations/${conversation.id}/preferences`, 'PATCH', {})).status).toBe(400);
      expect((await request(`/api/shared/conversations/${conversation.id}/preferences`, 'PATCH', { executionProfile: 'deep' })).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/preferences', 'PATCH', { executionProfile: 'deep' })).status).toBe(404);

      expect((await request(`/api/shared/conversations/${conversation.id}/brief`, 'PATCH', { brief: 'Notes' })).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/brief', 'PATCH', { brief: 'Notes' })).status).toBe(404);

      expect((await request(`/api/shared/conversations/${conversation.id}/draft`, 'PATCH', { body: 'draft text' })).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/draft', 'PATCH', { body: 'draft text' })).status).toBe(404);

      expect((await request(`/api/shared/conversations/${conversation.id}/task`, 'PATCH', { workItemId: null })).status).toBe(200);
      expect((await request(`/api/shared/conversations/${conversation.id}/task`, 'PATCH', { workItemId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);

      expect((await request(`/api/shared/conversations/${conversation.id}/pin`, 'PATCH', { pinned: true })).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/pin', 'PATCH', { pinned: true })).status).toBe(404);

      expect((await request(`/api/shared/conversations/${conversation.id}/read`, 'POST')).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/read', 'POST')).status).toBe(404);
    });

    it('forks a conversation and rejects an unknown id', async () => {
      const conversation = await createConversation();
      database.prepare("INSERT INTO shared_messages (id, conversation_id, author, body, status, error, dispatch_target, created_at) VALUES (lower(hex(randomblob(16))), ?, 'jeffrey', 'Question', 'completed', '', 'none', datetime('now'))").run(conversation.id);
      database.prepare("INSERT INTO shared_messages (id, conversation_id, author, body, status, error, dispatch_target, created_at) VALUES (lower(hex(randomblob(16))), ?, 'claude', 'Answer', 'completed', '', 'none', datetime('now'))").run(conversation.id);

      const response = await request(`/api/shared/conversations/${conversation.id}/fork`, 'POST');
      expect(response.status).toBe(201);
      expect((await request('/api/shared/conversations/missing/fork', 'POST')).status).toBe(404);
    });

    it('reports agent events and feedback, 404ing for unknown conversations', async () => {
      const conversation = await createConversation();
      expect((await request(`/api/shared/conversations/${conversation.id}/agent-events`)).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/agent-events')).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/feedback`)).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/feedback')).status).toBe(404);
    });
  });

  describe('workspace selection', () => {
    it('lists workspaces and selects the linked repository', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([workspace]);
      const conversation = await createConversation();
      const explorer = await request(`/api/shared/conversations/${conversation.id}/workspaces`);
      expect(explorer.status).toBe(200);
      expect((await request('/api/shared/conversations/missing/workspaces')).status).toBe(404);

      const selected = await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });
      expect(selected.status).toBe(200);

      const rejected = await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: '/not/a/candidate' });
      expect(rejected.status).toBe(400);
      expect((await request('/api/shared/conversations/missing/workspaces/selection', 'PUT', { workspacePath: workspace })).status).toBe(404);

      const idempotent = await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });
      expect(idempotent.status).toBe(200);
    });
  });

  describe('workspace diff surfaces', () => {
    it('requires a selected workspace before returning a diff', async () => {
      const item = await createWorkItem({ projectName: 'Other project' });
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/task`, 'PATCH', { workItemId: item.id });
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff`)).status).toBe(409);
    });

    it('returns the diff and captures a snapshot when a workspace is selected', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([workspace]);
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });
      seams.getWorkspaceDiff.mockResolvedValue({ workspacePath: workspace, branch: 'main', revision: 'rev-2', files: [], changedFiles: 1, additions: 1, deletions: 0, publish: { state: 'none' } });

      const response = await request(`/api/shared/conversations/${conversation.id}/workspace-diff`);
      expect(response.status).toBe(200);
      expect(seams.getWorkspaceDiff).toHaveBeenCalledWith(workspace);
    });

    it('resolves file source, refs, ref diff, commits, and status', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([workspace]);
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });

      seams.getWorkspaceFileSource.mockResolvedValue({ path: 'a.ts', content: 'x', error: null });
      const file = await request(`/api/shared/conversations/${conversation.id}/workspace-diff/file?path=a.ts&revision=rev`);
      expect(file.status).toBe(200);
      expect(seams.getWorkspaceFileSource).toHaveBeenCalledWith(workspace, 'a.ts', 'rev');

      seams.listWorkspaceRefs.mockResolvedValue([{ name: 'main', kind: 'branch' }]);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/refs`)).status).toBe(200);

      seams.getWorkspaceRefDiff.mockResolvedValue({ workspacePath: workspace, branch: 'feature', revision: 'r', files: [], changedFiles: 0, additions: 0, deletions: 0, publish: { state: 'none' } });
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/ref?ref=feature`)).status).toBe(200);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/ref`)).status).toBe(400);

      seams.listWorkspaceRefCommits.mockResolvedValue([]);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/ref/commits?ref=feature`)).status).toBe(200);
      // No ref is the repo browser's own question: this checkout's own commits.
      seams.listWorkspaceCommits.mockResolvedValue([]);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/ref/commits`)).status).toBe(200);
      expect(seams.listWorkspaceCommits).toHaveBeenCalledWith(workspace);

      seams.getWorkspaceCommitDiff.mockResolvedValue({ workspacePath: workspace, branch: 'main', revision: 'r', files: [], changedFiles: 0, additions: 0, deletions: 0, publish: { state: 'none' } });
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/commit?commit=abc`)).status).toBe(200);

      seams.getWorkspaceDiffRevision.mockResolvedValue('rev-3');
      const status = await request(`/api/shared/conversations/${conversation.id}/workspace-diff/status?revision=rev-3`);
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toEqual({ changed: false });
    });

    it('404s workspace-diff sub-routes when no workspace is selected', async () => {
      const item = await createWorkItem({ projectName: 'Other project' });
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/task`, 'PATCH', { workItemId: item.id });
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/snapshots`)).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/refs`)).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/ref?ref=main`)).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/ref/commits?ref=main`)).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/commit?commit=abc`)).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/status`)).status).toBe(404);
      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/file?path=a.ts`)).status).toBe(404);
    });

    it('captures recorded snapshots for the selected workspace', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([workspace]);
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });
      seams.snapshotsForRepository.mockResolvedValue([]);

      const response = await request(`/api/shared/conversations/${conversation.id}/workspace-diff/snapshots`);
      expect(response.status).toBe(200);
      expect(seams.captureRecordedWorkspaceDiffSnapshots).toHaveBeenCalled();
    });

    it('commits and pushes, 400ing a malformed request and 404ing an unknown conversation', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([workspace]);
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });
      seams.commitAndPushWorkspace.mockResolvedValue({ committed: true, pushed: true, commit: 'abc1234' });

      const response = await request(`/api/shared/conversations/${conversation.id}/workspace-diff/commit-and-push`, 'POST', { revision: 'rev-1' });
      expect(response.status).toBe(200);
      expect(seams.commitAndPushWorkspace).toHaveBeenCalledWith(workspace, expect.stringContaining('chore:'), 'rev-1');

      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/commit-and-push`, 'POST', {})).status).toBe(400);
      expect((await request('/api/shared/conversations/missing/workspace-diff/commit-and-push', 'POST', { revision: 'rev-1' })).status).toBe(404);
    });
  });

  describe('hunk and block reviews', () => {
    it('lists and upserts hunk reviews, individually and in batch', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([workspace]);
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });

      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/hunk-reviews?revision=rev-1`)).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/workspace-diff/hunk-reviews?revision=rev-1')).status).toBe(404);

      const upserted = await request(`/api/shared/conversations/${conversation.id}/workspace-diff/hunk-reviews`, 'PUT', {
        revision: 'rev-1', filePath: 'a.ts', hunkRange: '1-2', contentHash: 'hash', state: 'reviewed',
      });
      expect(upserted.status).toBe(200);

      const batch = await request(`/api/shared/conversations/${conversation.id}/workspace-diff/hunk-reviews/batch`, 'PUT', {
        revision: 'rev-1', hunks: [{ filePath: 'a.ts', hunkRange: '1-2', contentHash: 'hash' }], state: 'reviewed',
      });
      expect(batch.status).toBe(200);
    });

    it('lists and upserts block reviews', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([workspace]);
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/workspaces/selection`, 'PUT', { workspacePath: workspace });

      expect((await request(`/api/shared/conversations/${conversation.id}/workspace-diff/block-reviews?revision=rev-1`)).status).toBe(200);
      expect((await request('/api/shared/conversations/missing/workspace-diff/block-reviews?revision=rev-1')).status).toBe(404);

      const upserted = await request(`/api/shared/conversations/${conversation.id}/workspace-diff/block-reviews`, 'PUT', {
        revision: 'rev-1', filePath: 'a.ts', blockRange: '1-2', contentHash: 'hash', state: 'reviewed',
      });
      expect(upserted.status).toBe(200);
    });
  });

  describe('session feedback and counters', () => {
    it('creates session feedback and 404s for an unlinked payload', async () => {
      const conversation = await createConversation();
      const created = await request('/api/shared/session-feedback', 'POST', { conversationId: conversation.id, rating: 'positive' });
      expect(created.status).toBe(201);
      expect((await request('/api/shared/session-feedback', 'POST', { conversationId: '00000000-0000-0000-0000-000000000000', rating: 'positive' })).status).toBe(404);
    });

    it('reports unread, attention, and active conversation counts', async () => {
      expect((await request('/api/shared/conversations-unread-count')).status).toBe(200);
      expect((await request('/api/shared/conversations-attention-count')).status).toBe(200);
      expect((await request('/api/shared/conversations-count')).status).toBe(200);
    });
  });

  describe('search and memory', () => {
    it('requires a query for shared search', async () => {
      expect((await request('/api/shared/search')).status).toBe(400);
      expect((await request('/api/shared/search?q=hello')).status).toBe(200);
    });

    it('searches activity memory and the raw memory index', async () => {
      const response = await request('/api/activity-memory?q=hello');
      expect(response.status).toBe(200);

      seams.searchMemory.mockResolvedValue([]);
      const memory = await request('/api/memory/search?q=hello&source=activity,discovery');
      expect(memory.status).toBe(200);
      expect(seams.searchMemory).toHaveBeenCalledWith(database, 'hello', { limit: 21, sources: ['activity', 'discovery'] });
    });
  });

  describe('shared messages', () => {
    it('writes sanitized attachments when posting a message', async () => {
      const conversation = await createConversation();
      const attachment = { name: '../notes?.txt', mimeType: 'text/plain', size: 5, dataBase64: Buffer.from('hello').toString('base64') };

      const response = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Look at this', dispatchTo: 'none', attachments: [attachment] });
      expect(response.status).toBe(202);
      expect(seams.mkdirSync).toHaveBeenCalledWith(resolve('data/attachments'), { recursive: true });
      expect(seams.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/data\/attachments\/.+-notes_.txt$/), Buffer.from('hello'));
    });

    it('returns a stable server error when attachment storage rejects the write', async () => {
      seams.writeFileSync.mockImplementationOnce(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
      const conversation = await createConversation();

      const response = await request('/api/shared/messages', 'POST', {
        conversationId: conversation.id, dispatchTo: 'none',
        attachments: [{ name: 'secret.txt', mimeType: 'text/plain', size: 1, dataBase64: 'eA==' }],
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'permission denied' });
    });

    it('dispatches queued agents and unpins the conversation', async () => {
      const conversation = await createConversation();
      seams.dispatchNextSharedTurn.mockReturnValue([]);

      const response = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Go', dispatchTo: 'claude' });
      expect(response.status).toBe(202);
      expect(seams.dispatchNextSharedTurn).toHaveBeenCalledWith(expect.anything(), conversation.id);
    });

    it('queues a promotion reply for a runtime-approval message without dispatching', async () => {
      const conversation = await createConversation();
      const response = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'approve preview', dispatchTo: 'none' });
      expect(response.status).toBe(202);
      const body = await response.json() as { message: { status: string }; replies: Array<{ body: string }> };
      expect(body.message.status).toBe('completed');
      expect(body.replies[0].body).toMatch(/Promotion queued/);
      expect(seams.dispatchNextSharedTurn).not.toHaveBeenCalled();
    });

    it('lists messages, dispatching queued turns for the requested conversation', async () => {
      seams.dispatchNextSharedTurn.mockReturnValue([]);
      const conversation = await createConversation();
      const withConversation = await request(`/api/shared/messages?conversationId=${conversation.id}`);
      expect(withConversation.status).toBe(200);

      expect((await request('/api/shared/messages?activity=1')).status).toBe(200);
      expect((await request('/api/shared/messages?cursor=not-a-real-cursor')).status).toBe(400);
    });

    it('dispatches every queued conversation on an unscoped poll when agents may run', async () => {
      seams.listCandidateWorkspaces.mockReturnValue([]);
      seams.dispatchNextSharedTurn.mockReturnValue([]);
      const withAgents = createApp(database, liveRuntimeCapabilities).listen(0);
      await new Promise<void>((listening) => withAgents.once('listening', listening));
      const port = (withAgents.address() as AddressInfo).port;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/shared/messages`);
        expect(response.status).toBe(200);
      } finally {
        await closeTestServer(withAgents);
      }
    });

    it('skips dispatch for a preview-mirror request', async () => {
      const conversation = await createConversation();
      const response = await fetch(`${baseUrl}/api/shared/messages?conversationId=${conversation.id}`, { headers: { 'X-Workbench-Preview-Mirror': '1' } });
      expect(response.status).toBe(200);
      expect(seams.dispatchNextSharedTurn).not.toHaveBeenCalled();
    });

    it('updates a message and 404s an unknown id', async () => {
      const conversation = await createConversation();
      const posted = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Pin me', dispatchTo: 'none' });
      const { message } = await posted.json() as { message: { id: string } };

      const updated = await request(`/api/shared/messages/${message.id}`, 'PATCH', { pinned: true });
      expect(updated.status).toBe(200);
      expect((await request('/api/shared/messages/missing', 'PATCH', { pinned: true })).status).toBe(404);
    });

    it('fetches retrieved memory detail for a message', async () => {
      const conversation = await createConversation();
      const posted = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Explain', dispatchTo: 'none' });
      const { message } = await posted.json() as { message: { id: string } };

      expect((await request(`/api/shared/messages/${message.id}/retrieved-memory`)).status).toBe(200);
      expect((await request('/api/shared/messages/missing/retrieved-memory')).status).toBe(404);
    });

    it('cancels a running or queued reply', async () => {
      seams.cancelSharedReply.mockReturnValue({ id: 'reply-1' });
      const response = await request('/api/shared/messages/reply-1/cancel', 'POST');
      expect(response.status).toBe(200);

      seams.cancelSharedReply.mockReturnValue(null);
      expect((await request('/api/shared/messages/reply-1/cancel', 'POST')).status).toBe(404);
    });

    it('retries a failed agent reply that has no linked run', async () => {
      const conversation = await createConversation();
      const posted = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Go', dispatchTo: 'claude' });
      const { message } = await posted.json() as { message: { id: string } };
      database.prepare("UPDATE shared_messages SET author = 'claude', status = 'failed' WHERE id = ?").run(message.id);

      seams.replyInSharedRoom.mockResolvedValue(undefined);
      const retried = await request(`/api/shared/messages/${message.id}/retry`, 'POST');
      expect(retried.status).toBe(202);
      expect(seams.replyInSharedRoom).toHaveBeenCalledWith(expect.anything(), 'claude', message.id);

      expect((await request('/api/shared/messages/missing/retry', 'POST')).status).toBe(404);
    });

    it('refuses to retry a message that is not a terminal agent reply', async () => {
      const conversation = await createConversation();
      const posted = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Hi', dispatchTo: 'none' });
      const { message } = await posted.json() as { message: { id: string } };

      expect((await request(`/api/shared/messages/${message.id}/retry`, 'POST')).status).toBe(409);
    });

    it('retries synthesis and reports when it cannot be retried', async () => {
      seams.retrySharedSynthesis.mockResolvedValue({ id: 'msg-1' });
      expect((await request('/api/shared/messages/msg-1/retry-synthesis', 'POST')).status).toBe(202);

      seams.retrySharedSynthesis.mockResolvedValue(null);
      expect((await request('/api/shared/messages/msg-1/retry-synthesis', 'POST')).status).toBe(409);
    });

    it('interjects a queued message, reporting pending when the reply is not ready', async () => {
      seams.interjectQueuedSharedMessage.mockResolvedValue([{ id: 'reply-1' }]);
      const delivered = await request('/api/shared/messages/msg-1/interject', 'POST');
      expect(delivered.status).toBe(200);

      seams.interjectQueuedSharedMessage.mockResolvedValue([]);
      const pending = await request('/api/shared/messages/msg-1/interject', 'POST');
      expect(pending.status).toBe(202);
      await expect(pending.json()).resolves.toEqual({ replies: [], pending: true });

      seams.interjectQueuedSharedMessage.mockResolvedValue(null);
      expect((await request('/api/shared/messages/msg-1/interject', 'POST')).status).toBe(404);
    });
  });

  describe('create-tasks', () => {
    it('rejects an unknown message', async () => {
      expect((await request('/api/shared/messages/missing/create-tasks', 'POST')).status).toBe(400);
    });

    it('turns a report into follow-up tasks for an ad-hoc conversation', async () => {
      const conversation = await createConversation();
      const posted = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Findings report', dispatchTo: 'none' });
      const { message } = await posted.json() as { message: { id: string } };

      seams.runSharedBackgroundJob.mockImplementation(async (_repository: unknown, _messageId: string, job: (signal: AbortSignal) => Promise<string>) => {
        await job(new AbortController().signal);
      });
      seams.runAgentCommandWithFallback.mockResolvedValue({ output: 'plan output' });
      seams.parseFollowUpPlan.mockReturnValue({ summary: 'Two follow-ups', tasks: [{ title: 'Task A', description: 'Do A', workspacePath: null }] });

      const response = await request(`/api/shared/messages/${message.id}/create-tasks`, 'POST');
      expect(response.status).toBe(202);
      await new Promise((r) => setTimeout(r, 0));
      expect(seams.runAgentCommandWithFallback).toHaveBeenCalled();
    });

    it('reuses an in-flight follow-up job for the same conversation', async () => {
      const conversation = await createConversation();
      const posted = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Findings', dispatchTo: 'none' });
      const { message } = await posted.json() as { message: { id: string } };
      seams.runSharedBackgroundJob.mockImplementation(() => new Promise(() => {}));

      const first = await request(`/api/shared/messages/${message.id}/create-tasks`, 'POST');
      expect(first.status).toBe(202);
      const second = await request(`/api/shared/messages/${message.id}/create-tasks`, 'POST');
      expect(second.status).toBe(202);
      const body = await second.json() as { jobMessage: { body: string } };
      expect(body.jobMessage.body).toMatch(/Turning findings into tasks/);
    });

    it('creates an execution plan when a linked task exists', async () => {
      const item = await createWorkItem();
      const conversation = await createConversation();
      await request(`/api/shared/conversations/${conversation.id}/task`, 'PATCH', { workItemId: item.id });
      const posted = await request('/api/shared/messages', 'POST', { conversationId: conversation.id, body: 'Findings report', dispatchTo: 'none' });
      const { message } = await posted.json() as { message: { id: string } };

      seams.runSharedBackgroundJob.mockImplementation(async (_repository: unknown, _messageId: string, job: (signal: AbortSignal) => Promise<string>) => {
        await job(new AbortController().signal);
      });
      seams.runAgentCommandWithFallback.mockResolvedValue({ output: 'plan output' });
      seams.parseFollowUpPlan.mockReturnValue({ summary: 'One follow-up', tasks: [{ title: 'Task A', description: 'Do A', workspacePath: null }] });

      const first = await request(`/api/shared/messages/${message.id}/create-tasks`, 'POST');
      expect(first.status).toBe(202);
      await new Promise((r) => setTimeout(r, 0));

      const second = await request(`/api/shared/messages/${message.id}/create-tasks`, 'POST');
      expect(second.status).toBe(200);
      const body = await second.json() as { plan: { summary: string } };
      expect(body.plan.summary).toBe('One follow-up');
    });
  });
});
