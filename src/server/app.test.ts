import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, oauthCallbackBase, parseFollowUpPlan } from './app.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { cancelAgentRun, isAgentRunActive } from './agent-runner.js';
import { OWNER_ID } from './scheduler.js';
import { previewRuntimeCapabilities } from './runtime-capabilities.js';
import type { ProjectSummary, WorkItem, WorkspaceDiff } from '../shared/contracts.js';
import { setEmbedder } from './memory-index.js';
import { deterministicTestEmbedder } from './memory-index.test-helpers.js';
import { closeTestServer as closeServer } from './test-http-harness.js';
import { fakeAgentDirectory } from './test-fake-agent.js';

describe('POST /api/work-items/:id/execute and /runs dedup guard', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const app = createApp(database);
    server = app.listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await closeServer(server);
    database.close();
  });

  it('serves the canonical project vocabulary and resolves a mistyped project on create', async () => {
    repository.create({ title: 'Anchor', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });

    const created = await fetch(`${baseUrl}/api/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Typed badly', projectName: 'wkbnch' }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { item: WorkItem }).item.projectName).toBe('Workbench');

    const listed = await fetch(`${baseUrl}/api/projects`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { projects: ProjectSummary[] }).projects).toEqual([
      expect.objectContaining({ name: 'Workbench', key: 'workbench', taskCount: 2 }),
    ]);
  });

  it('requires a connected GitHub source before serving pull-request diffs', async () => {
    const response = await fetch(`${baseUrl}/api/github/pull-request-diff?url=https%3A%2F%2Fgithub.com%2Fwriter%2Fworkbench%2Fpull%2F24`);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'GitHub is not connected. Connect it in Sources to view pull-request diffs.',
    });
  });

  it('serves immutable workspace diff records after the current workspace changes are gone', async () => {
    const item = repository.create({ title: 'Timeline record', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const diff: WorkspaceDiff = {
      workspacePath: '/tmp/workbench', branch: 'main', revision: 'preserved-revision', changedFiles: 1, additions: 1, deletions: 0,
      publish: { branch: 'main', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
      files: [{ path: 'src/preserved.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+preserved', isBinary: false }],
    };
    repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff);

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/workspace-diff/snapshots`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ snapshots: [expect.objectContaining({ revision: 'preserved-revision', diff })] });
  });

  it('recovers task Changes from a garbage-collected run worktree and repairs the saved choice', async () => {
    const item = repository.create({ title: 'Collected worktree', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const stalePath = '/tmp/workbench-collected-run-worktree';
    const run = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
    repository.updateRun(run.id, { status: 'completed', resolvedWorkspace: stalePath, completedAt: new Date().toISOString() });
    database.prepare('INSERT INTO work_item_workspace_selection (work_item_id, workspace_path, updated_at) VALUES (?, ?, ?)').run(item.id, stalePath, new Date().toISOString());

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/workspace-diff`);

    expect(response.status).toBe(200);
    expect((await response.json() as { diff: WorkspaceDiff }).diff.workspacePath).toBe(process.cwd());
    expect(database.prepare('SELECT workspace_path FROM work_item_workspace_selection WHERE work_item_id = ?').get(item.id)).toEqual({ workspace_path: process.cwd() });
  });

  it('recovers conversation Changes from a garbage-collected run worktree and repairs the saved choice', async () => {
    const item = repository.create({ title: 'Collected conversation worktree', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Collected worktree conversation', item.id);
    const stalePath = '/tmp/workbench-collected-conversation-worktree';
    const run = repository.createRun(item.id, 'execute', 'codex', 'codex', '', conversation.id);
    repository.updateRun(run.id, { status: 'completed', resolvedWorkspace: stalePath, completedAt: new Date().toISOString() });
    database.prepare('INSERT INTO shared_conversation_workspace_selection (conversation_id, workspace_path, updated_at) VALUES (?, ?, ?)').run(conversation.id, stalePath, new Date().toISOString());

    const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/workspace-diff`);

    expect(response.status).toBe(200);
    expect((await response.json() as { diff: WorkspaceDiff }).diff.workspacePath).toBe(process.cwd());
    expect(database.prepare('SELECT workspace_path FROM shared_conversation_workspace_selection WHERE conversation_id = ?').get(conversation.id)).toEqual({ workspace_path: process.cwd() });
  });

  it('selects an inferred repository for a linked conversation with no saved workspace', async () => {
    const item = repository.create({ title: 'Build a connector projection', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Missing linked workspace', item.id);

    const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/workspaces`);

    expect(response.status).toBe(200);
    const body = await response.json() as { selectedPath: string | null; workspaces: Array<{ path: string; selected: boolean }> };
    expect(body.selectedPath).not.toBeNull();
    expect(body.workspaces.some((workspace) => workspace.path === body.selectedPath && workspace.selected)).toBe(true);
  });

  it('retires provider sessions when Repo Explorer changes a conversation workspace', async () => {
    const originalWorkspace = mkdtempSync(join(tmpdir(), 'workbench-session-workspace-'));
    writeFileSync(join(originalWorkspace, 'package.json'), '{}');
    const item = repository.create({ title: 'Move repository', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: originalWorkspace, dueDate: null });
    const conversation = repository.createConversation('Move repository', item.id);
    repository.setConversationClaudeSessionId(conversation.id, 'claude-session');
    repository.setConversationCodexThreadId(conversation.id, 'codex-thread');

    try {
      const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/workspaces/selection`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: process.cwd() }),
      });

      expect(response.status).toBe(200);
      expect(repository.getConversation(conversation.id)).toEqual(expect.objectContaining({ claudeSessionId: null, codexThreadId: null }));
    } finally {
      rmSync(originalWorkspace, { recursive: true, force: true });
    }
  });

  it('reports only work owned by this backend in its runtime drain health', async () => {
    const idle = await fetch(`${baseUrl}/api/health`);
    expect(await idle.json()).toEqual({ ok: true, mode: 'live', runtimeWorkActive: false, ownedAgentWorkActive: false, liveAgentProcessCount: 0, buildId: expect.any(String) });

    const conversation = repository.ensureDefaultConversation();
    const promotion = repository.createSharedMessage('system', 'Promoting…', 'running', conversation.id, [], 'promotion');
    expect(repository.claimSharedMessage(promotion.id, OWNER_ID, 60_000)).toBe(true);
    const active = await fetch(`${baseUrl}/api/health`);
    expect(await active.json()).toEqual({ ok: true, mode: 'live', runtimeWorkActive: true, ownedAgentWorkActive: false, liveAgentProcessCount: 0, buildId: expect.any(String) });
  });

  it('persists a manually selected bug-fix type when creating a task', async () => {
    const response = await fetch(`${baseUrl}/api/work-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Investigate missing task type', description: '', priority: 2, status: 'backlog', projectName: null, workspacePath: null, dueDate: null, sourceUrl: null, classificationKind: 'bugfix' }),
    });

    expect(response.status).toBe(201);
    const { item } = await response.json() as { item: { id: string; classificationKind: string | null } };
    expect(item.classificationKind).toBe('bugfix');
    expect(repository.getClassification(item.id)).toEqual(expect.objectContaining({ kind: 'bugfix', source: 'manual' }));
  });

  it('rejects a PATCH whose expectedVersion is stale with a 409 carrying the current item (VERSION_CONFLICT)', async () => {
    const item = repository.create({ title: 'Racing edit', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    // Simulate a concurrent writer landing first, so the version the client
    // read is no longer current by the time its own PATCH arrives.
    repository.update(item.id, { title: 'Won the race' });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Lost the race', expectedVersion: item.version }),
    });

    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; code: string; item: WorkItem };
    expect(body.code).toBe('VERSION_CONFLICT');
    expect(body.item).toEqual(expect.objectContaining({ id: item.id, title: 'Won the race' }));
  });

  it('rejects a second /execute while a run is already active for the task (409)', async () => {
    const item = repository.create({ title: 'Dedup guard task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    // Simulate an in-flight run without depending on spawning a real agent process.
    repository.createRun(item.id, 'analysis', 'codex', 'codex', '');

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/already has an active agent run/i);
  });

  it('rejects executing a task again after its first run has finished', async () => {
    const item = repository.create({ title: 'One-shot execution task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const prior = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
    repository.updateRun(prior.id, { status: 'completed', completedAt: new Date().toISOString() });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toMatch(/already been executed/i);
  });

  it('rejects a duplicate /runs request while a run is already active for the task (409)', async () => {
    const item = repository.create({ title: 'Dedup guard task 2', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(item.id, 'review', 'codex', 'codex', '');

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
    });
    expect(response.status).toBe(409);
  });

  it('retrying one of two independent agent threads on the same task does not block the other', async () => {
    fakeAgentDirectory(`trap 'exit 143' TERM\nwhile true; do /bin/sleep 0.1; done`, 'exit 1');
    const item = repository.create({ title: 'Double thread task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const codexRun = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    const claudeRun = repository.createRun(item.id, 'analysis', 'claude', 'claude', '');
    repository.updateRun(codexRun.id, { status: 'canceled', completedAt: new Date().toISOString() });
    repository.updateRun(claudeRun.id, { status: 'canceled', completedAt: new Date().toISOString() });

    const codexRetry = await fetch(`${baseUrl}/api/agent-runs/${codexRun.id}/retry`, { method: 'POST' });
    expect(codexRetry.status).toBe(202);

    // Codex's retry is now active for the item, but Claude's sibling thread
    // failed/canceled independently and must remain retryable on its own.
    const claudeRetry = await fetch(`${baseUrl}/api/agent-runs/${claudeRun.id}/retry`, { method: 'POST' });
    expect(claudeRetry.status).toBe(202);

    const { run: retriedCodexRun } = await codexRetry.json() as { run: { id: string } };
    const { run: retriedClaudeRun } = await claudeRetry.json() as { run: { id: string } };
    expect(cancelAgentRun(repository, retriedCodexRun.id)).toBeTruthy();
    expect(cancelAgentRun(repository, retriedClaudeRun.id)).toBeTruthy();
    await vi.waitFor(() => expect(isAgentRunActive(retriedCodexRun.id)).toBe(false));
    await vi.waitFor(() => expect(isAgentRunActive(retriedClaudeRun.id)).toBe(false));
  });

  it('retries a canceled shared reply while its other-agent dispatch sibling is still running', async () => {
    fakeAgentDirectory('exit 1', 'exit 1');
    const conversation = repository.createConversation('Retry mixed group');
    const groupId = 'same-original-dispatch';
    const codex = repository.createSharedMessage('codex', 'Canceled Codex reply', 'canceled', conversation.id, [], 'none', null, null, groupId);
    repository.createSharedMessage('claude', 'Claude is still working', 'running', conversation.id, [], 'none', null, null, groupId);

    const retry = await fetch(`${baseUrl}/api/shared/messages/${codex.id}/retry`, { method: 'POST' });

    expect(retry.status).toBe(202);
    const body = await retry.json() as { replies: Array<{ id: string; author: string }> };
    expect(body.replies).toEqual([expect.objectContaining({ id: codex.id, author: 'codex' })]);
    await vi.waitFor(() => expect(repository.getSharedMessageById(codex.id)?.status).toBe('failed'));
  });

  it('retries each terminal reply from a paired dispatch independently', async () => {
    fakeAgentDirectory('exit 1', 'exit 1');
    const conversation = repository.createConversation('Retry both paired replies');
    const groupId = 'paired-retry-group';
    const codex = repository.createSharedMessage('codex', 'Canceled Codex reply', 'canceled', conversation.id, [], 'none', null, null, groupId);
    const claude = repository.createSharedMessage('claude', 'Canceled Claude reply', 'canceled', conversation.id, [], 'none', null, null, groupId);

    const [codexRetry, claudeRetry] = await Promise.all([
      fetch(`${baseUrl}/api/shared/messages/${codex.id}/retry`, { method: 'POST' }),
      fetch(`${baseUrl}/api/shared/messages/${claude.id}/retry`, { method: 'POST' }),
    ]);

    expect(codexRetry.status).toBe(202);
    expect(claudeRetry.status).toBe(202);
    await vi.waitFor(() => expect(repository.getSharedMessageById(codex.id)?.status).toBe('failed'));
    await vi.waitFor(() => expect(repository.getSharedMessageById(claude.id)?.status).toBe('failed'));
  });

  it('retries a terminal reply even when a newer reply from the same agent is running', async () => {
    fakeAgentDirectory('exit 1', 'exit 1');
    const conversation = repository.createConversation('Retry alongside a newer reply');
    const staleClaude = repository.createSharedMessage('claude', 'Canceled Claude reply', 'canceled', conversation.id);
    repository.createSharedMessage('claude', 'New Claude reply is running', 'running', conversation.id);

    const retry = await fetch(`${baseUrl}/api/shared/messages/${staleClaude.id}/retry`, { method: 'POST' });

    expect(retry.status).toBe(202);
    await vi.waitFor(() => expect(repository.getSharedMessageById(staleClaude.id)?.status).toBe('failed'));
  });

  describe('open-prerequisite dispatch gate', () => {
    const seedBlockedTask = () => {
      const blocker = repository.create({ title: 'Schema lands first', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const dependent = repository.create({ title: 'API lands second', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      repository.replaceDependencies(dependent.id, [blocker.id]);
      return { blocker, dependent };
    };

    it('rejects /execute while a prerequisite is still open and names the blockers', async () => {
      const { blocker, dependent } = seedBlockedTask();

      const response = await fetch(`${baseUrl}/api/work-items/${dependent.id}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

      expect(response.status).toBe(409);
      const body = await response.json() as { code: string; blockedBy: Array<{ id: string; title: string }> };
      // The client renders these titles, so the payload has to carry them rather
      // than leaving the UI to re-fetch the task just to explain the refusal.
      expect(body.code).toBe('OPEN_PREREQUISITES');
      expect(body.blockedBy).toEqual([expect.objectContaining({ id: blocker.id, title: 'Schema lands first' })]);
      // The gate must refuse before any run row exists, or a blocked task would
      // burn its one-shot execution budget on a request that never dispatched.
      expect(repository.listRuns(dependent.id)).toHaveLength(0);
    });

    it('rejects /runs while a prerequisite is still open', async () => {
      const { dependent } = seedBlockedTask();

      const response = await fetch(`${baseUrl}/api/work-items/${dependent.id}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
      });

      expect(response.status).toBe(409);
      expect((await response.json() as { code: string }).code).toBe('OPEN_PREREQUISITES');
      expect(repository.listRuns(dependent.id)).toHaveLength(0);
    });

    it('opens the gate once the prerequisite reaches a terminal state', async () => {
      const { blocker, dependent } = seedBlockedTask();
      repository.update(blocker.id, { status: 'done' });

      // An active run on the dependent isolates this assertion to the dependency
      // gate: reaching the *dedup* 409 proves the prerequisite check let it past.
      repository.createRun(dependent.id, 'review', 'codex', 'codex', '');
      const response = await fetch(`${baseUrl}/api/work-items/${dependent.id}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
      });

      expect(response.status).toBe(409);
      const body = await response.json() as { code?: string; error: string };
      expect(body.code).toBeUndefined();
      expect(body.error).toMatch(/already has an active agent run/i);
    });

    it('lets an unblocked task past the gate', async () => {
      const { dependent } = seedBlockedTask();
      repository.replaceDependencies(dependent.id, []);
      repository.createRun(dependent.id, 'review', 'codex', 'codex', '');

      const response = await fetch(`${baseUrl}/api/work-items/${dependent.id}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
      });

      expect((await response.json() as { code?: string }).code).toBeUndefined();
    });
  });

  describe('self-assigned execution gate', () => {
    const seedSelfAssignedTask = () => {
      const item = repository.create({ title: 'Jeffrey handles this one', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      repository.update(item.id, { assignees: ['jeffrey'] });
      return item;
    };

    it('rejects /execute while Jeffrey owns the task and starts no run', async () => {
      const item = seedSelfAssignedTask();

      const response = await fetch(`${baseUrl}/api/work-items/${item.id}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

      expect(response.status).toBe(409);
      expect((await response.json() as { code: string }).code).toBe('SELF_ASSIGNED');
      // Refusing before any run row exists keeps the task's one-shot execution budget intact.
      expect(repository.listRuns(item.id)).toHaveLength(0);
    });

    it('rejects /runs while Jeffrey owns the task', async () => {
      const item = seedSelfAssignedTask();

      const response = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
      });

      expect(response.status).toBe(409);
      expect((await response.json() as { code: string }).code).toBe('SELF_ASSIGNED');
      expect(repository.listRuns(item.id)).toHaveLength(0);
    });

    it('rejects retrying an earlier run once Jeffrey takes the task over', async () => {
      const item = seedSelfAssignedTask();
      const prior = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
      repository.updateRun(prior.id, { status: 'failed', completedAt: new Date().toISOString() });

      const response = await fetch(`${baseUrl}/api/agent-runs/${prior.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

      expect(response.status).toBe(409);
      expect((await response.json() as { code: string }).code).toBe('SELF_ASSIGNED');
    });

    it('rejects assigning an agent alongside Jeffrey', async () => {
      const item = seedSelfAssignedTask();

      const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignees: ['jeffrey', 'codex'] }),
      });

      expect(response.status).toBe(400);
      expect(repository.get(item.id)?.assignees).toEqual(['jeffrey']);
    });

    it('lets execution through once Jeffrey is unassigned', async () => {
      const item = seedSelfAssignedTask();
      repository.update(item.id, { assignees: ['codex'] });
      // An active run isolates this assertion to the ownership gate: reaching the
      // dedup 409 proves the self-assignment check let the request past.
      repository.createRun(item.id, 'review', 'codex', 'codex', '');

      const response = await fetch(`${baseUrl}/api/work-items/${item.id}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

      expect(response.status).toBe(409);
      expect((await response.json() as { code?: string }).code).toBeUndefined();
    });
  });

  it('parses screenshot-sized JSON bodies instead of rejecting them at the Express boundary', async () => {
    const item = repository.create({ title: 'Large request parser check', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x'.repeat(1_100_000) }),
    });

    // The route schema may reject the unknown field, but the body parser must not
    // reject a normal mobile screenshot payload with HTTP 413 first.
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/entity too large/i);
  });

  it('allows a fresh /runs request once the prior run has completed', async () => {
    // A real codex/claude binary must never be spawned from this suite: point PATH at a
    // fake that just hangs until SIGTERM, so cancellation below is fast and deterministic.
    fakeAgentDirectory(`trap 'exit 143' TERM\nwhile true; do /bin/sleep 0.1; done`, 'exit 1');
    const item = repository.create({ title: 'Dedup guard task 3', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const priorRun = repository.createRun(item.id, 'review', 'codex', 'codex', '');
    repository.updateRun(priorRun.id, { status: 'completed', completedAt: new Date().toISOString() });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
    });
    expect(response.status).toBe(202);
    const { runs } = await response.json() as { runs: Array<{ id: string }> };
    expect(repository.get(item.id)).toEqual(expect.objectContaining({ status: 'in_progress' }));
    // This route intentionally starts work in the background. End the test's
    // real run and wait for its process callback before closing its database.
    expect(cancelAgentRun(repository, runs[0].id)).toBeTruthy();
    await vi.waitFor(() => expect(isAgentRunActive(runs[0].id)).toBe(false));
  });

  it('promotes a task to in progress before its background execution claims a workspace', async () => {
    // Keep the background run alive long enough to prove the request itself,
    // rather than agent-runner timing, owns the visible status transition.
    fakeAgentDirectory(`trap 'exit 143' TERM\nwhile true; do /bin/sleep 0.1; done`, 'exit 1');
    const item = repository.create({ title: 'Promote immediately', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.setClassification(item.id, { kind: 'execute', agent: 'codex', complex: false, instructions: 'Implement the task.' }, 'manual');

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });

    expect(response.status).toBe(202);
    const { runs } = await response.json() as { runs: Array<{ id: string }> };
    expect(repository.get(item.id)).toEqual(expect.objectContaining({ status: 'in_progress' }));
    expect(cancelAgentRun(repository, runs[0].id)).toBeTruthy();
    await vi.waitFor(() => expect(isAgentRunActive(runs[0].id)).toBe(false));
  });
});

describe('preview promotion delegation', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    server = createApp(database, previewRuntimeCapabilities).listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  it('durably queues preview approval for the live promotion worker instead of permission-refusing it', async () => {
    const conversation = repository.ensureDefaultConversation();
    const response = await fetch(`${baseUrl}/api/shared/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'promote preview', conversationId: conversation.id, attachments: [], dispatchTo: 'none' }),
    });

    expect(response.status).toBe(202);
    const body = await response.json() as { replies: Array<{ status: string; dispatchTarget: string }> };
    expect(body.replies).toEqual([expect.objectContaining({ status: 'queued', dispatchTarget: 'promotion' })]);
    expect(repository.listQueuedPromotionMessageIds()).toHaveLength(1);
  });
});

describe('linked task API', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    server = createApp(database).listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => { await closeServer(server); database.close(); });

  it('adds and removes a bidirectional task link exposed by task detail', async () => {
    const first = repository.create({ title: 'First', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const created = await fetch(`${baseUrl}/api/work-items/${first.id}/linked-tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkedWorkItemId: second.id }) });
    expect(created.status).toBe(201);
    expect((await created.json() as { item: { id: string } }).item.id).toBe(second.id);

    const detail = await (await fetch(`${baseUrl}/api/work-items/${second.id}`)).json() as { linkedTasks: Array<{ id: string }> };
    expect(detail.linkedTasks).toEqual([expect.objectContaining({ id: first.id })]);

    const removed = await fetch(`${baseUrl}/api/work-items/${first.id}/linked-tasks/${second.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });
});

describe('work-item metadata ownership and dates', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    server = createApp(database).listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => { await closeServer(server); database.close(); });

  it('accepts real past calendar dates and rejects impossible dates', async () => {
    const valid = await fetch(`${baseUrl}/api/work-items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Overdue task', dueDate: '2024-02-29' }) });
    expect(valid.status).toBe(201);
    expect((await valid.json() as { item: { dueDate: string } }).item.dueDate).toBe('2024-02-29');

    const invalid = await fetch(`${baseUrl}/api/work-items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Bad date', dueDate: '2026-02-30' }) });
    expect(invalid.status).toBe(400);
  });

  it('records Jeffrey\'s pertinent edits in the activity log, and ignores queue-only moves', async () => {
    const item = repository.create({ title: 'Edited task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const edit = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blocked', priority: 1, dueDate: '2026-08-25', assignees: ['claude'] }),
    });
    expect(edit.status).toBe(200);
    const logged = repository.listActivity(item.id).find((entry) => entry.kind === 'edited');
    expect(logged?.actor).toBe('jeffrey');
    expect(logged?.body).toBe('Status: ready → blocked · Priority: 2 → 1 · Owners: none → claude · Due date: none → 2026-08-25.');

    const before = repository.listActivity(item.id).length;
    await fetch(`${baseUrl}/api/work-items/${item.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queuePosition: 5 }),
    });
    expect(repository.listActivity(item.id)).toHaveLength(before);
  });

  it('attributes lifecycle moves made from the UI to Jeffrey', async () => {
    const item = repository.create({ title: 'Finished task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    expect((await fetch(`${baseUrl}/api/work-items/${item.id}/complete`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work-items/${item.id}/restore`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work-items/${item.id}/archive`, { method: 'POST' })).status).toBe(200);

    expect(repository.listActivity(item.id)
      .filter((entry) => ['archived', 'completed', 'restored'].includes(entry.kind))
      .map((entry) => `${entry.actor}/${entry.kind}: ${entry.body}`))
      .toEqual(expect.arrayContaining([
        'jeffrey/completed: Completed and moved to the archive.',
        'jeffrey/restored: Restored from the archive.',
        'jeffrey/archived: Archived without completing.',
      ]));
  });

  it('tracks local Linear status and due-date edits for conflict-aware sync', async () => {
    repository.upsertLinearItem({ sourceIdentifier: 'ENG-99', sourceUrl: 'https://linear.app/example/issue/ENG-99', title: 'Provider item', description: '', status: 'ready', priority: 2, projectName: null, labels: [], dueDate: '2026-08-22', providerUpdatedAt: '2026-08-20T00:00:00.000Z', providerPayload: {} });
    const item = repository.searchLinear('ENG-99')[0];
    const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dueDate: '2026-08-23' }) });
    expect(response.status).toBe(200);
    expect(repository.get(item.id)?.dueDate).toBe('2026-08-23');
  });

  it('returns and resolves a Linear field conflict without overwriting the local edit', async () => {
    const input = { sourceIdentifier: 'ENG-100', sourceUrl: null, title: 'Provider title', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: [], dueDate: null, providerUpdatedAt: '2026-08-20T00:00:00.000Z', providerPayload: {} };
    repository.upsertLinearItem(input);
    const item = repository.searchLinear('ENG-100')[0];
    await fetch(`${baseUrl}/api/work-items/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Local title' }) });
    repository.upsertLinearItem({ ...input, title: 'Provider title v2', providerUpdatedAt: '2026-08-20T01:00:00.000Z' });

    const detail = await fetch(`${baseUrl}/api/work-items/${item.id}`);
    expect((await detail.json() as { providerConflicts: Array<{ field: string; localValue: string; providerValue: string }> }).providerConflicts)
      .toEqual([expect.objectContaining({ field: 'title', localValue: 'Local title', providerValue: 'Provider title v2' })]);

    const resolution = await fetch(`${baseUrl}/api/work-items/${item.id}/provider-conflicts/title/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'keep_local' }),
    });
    expect(resolution.status).toBe(200);
    expect(await resolution.json()).toEqual(expect.objectContaining({ item: expect.objectContaining({ title: 'Local title' }), providerConflicts: [] }));
  });
});

describe('GET /api/shared/search', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const app = createApp(database);
    server = app.listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  it('returns 200 with ranked results for a matching query', async () => {
    const conversation = repository.createConversation('Search route thread');
    repository.createSharedMessage('jeffrey', 'A message about full text search indexing.', 'completed', conversation.id);

    const response = await fetch(`${baseUrl}/api/shared/search?q=indexing`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message', conversationId: conversation.id }),
    ]));
  });

  it('returns 400 when q is missing', async () => {
    const response = await fetch(`${baseUrl}/api/shared/search`);
    expect(response.status).toBe(400);
  });

  it('returns 400 when q is empty', async () => {
    const response = await fetch(`${baseUrl}/api/shared/search?q=`);
    expect(response.status).toBe(400);
  });

  it('returns an empty results array when nothing matches', async () => {
    repository.createConversation('Some conversation');
    const response = await fetch(`${baseUrl}/api/shared/search?q=zzz-no-such-token`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });
});

describe('GET /api/shared/conversations/:id', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const app = createApp(database);
    server = app.listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  it('returns a conversation by id even when it is archived', async () => {
    const conversation = repository.createConversation('Deep-linked thread');
    repository.setConversationArchived(conversation.id, true);

    const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversation: { id: string; title: string } };
    expect(body.conversation).toMatchObject({ id: conversation.id, title: 'Deep-linked thread' });
  });

  it('returns 404 for an unknown conversation id', async () => {
    const response = await fetch(`${baseUrl}/api/shared/conversations/00000000-0000-4000-8000-000000000999`);
    expect(response.status).toBe(404);
  });

  it('links and unlinks an existing conversation from a task', async () => {
    const conversation = repository.createConversation('Manual thread');
    const task = repository.create({ title: 'Link target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const linked = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/task`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workItemId: task.id }) });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({ conversation: expect.objectContaining({ workItemId: task.id }) });

    const unlinked = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/task`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workItemId: null }) });
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toEqual({ conversation: expect.objectContaining({ workItemId: null }) });
  });

  it('keeps a linked conversation and task pinned together from either pin control', async () => {
    const task = repository.create({ title: 'Shared pin target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Shared pin conversation', task.id);

    const conversationPinned = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/pin`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true }),
    });
    expect(conversationPinned.status).toBe(200);
    expect(repository.get(task.id)?.status).toBe('pinned');
    expect(repository.getConversation(conversation.id)).toEqual(expect.objectContaining({ pinned: true, linkedWorkItemPinned: true }));

    const taskUnpinned = await fetch(`${baseUrl}/api/work-items/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ready' }),
    });
    expect(taskUnpinned.status).toBe(200);
    expect(repository.get(task.id)?.status).toBe('ready');
    expect(repository.getConversation(conversation.id)).toEqual(expect.objectContaining({ pinned: false, linkedWorkItemPinned: false }));

    const taskPinned = await fetch(`${baseUrl}/api/work-items/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'pinned' }),
    });
    expect(taskPinned.status).toBe(200);
    expect(repository.getConversation(conversation.id)).toEqual(expect.objectContaining({ pinned: true, linkedWorkItemPinned: true }));

    const conversationUnpinned = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/pin`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: false }),
    });
    expect(conversationUnpinned.status).toBe(200);
    expect(repository.get(task.id)?.status).toBe('ready');
    expect(repository.getConversation(conversation.id)).toEqual(expect.objectContaining({ pinned: false, linkedWorkItemPinned: false }));
  });

  it('unpins the conversation and its linked task when restoring a pinned archived conversation', async () => {
    const task = repository.create({ title: 'Pinned link target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { status: 'pinned' });
    const conversation = repository.createConversation('Restart me', task.id);
    repository.setConversationPinned(conversation.id, true);
    repository.setConversationArchived(conversation.id, true);

    const restored = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { conversation: { pinned: boolean; linkedWorkItemPinned: boolean } };
    expect(body.conversation.pinned).toBe(false);
    expect(body.conversation.linkedWorkItemPinned).toBe(false);
    expect(repository.get(task.id)?.status).toBe('ready');
  });

  it('unpins a pinned conversation and its linked task when a new message is dispatched to an agent', async () => {
    const task = repository.create({ title: 'Pinned dispatch target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { status: 'pinned' });
    const conversation = repository.createConversation('Keep working', task.id);
    repository.setConversationPinned(conversation.id, true);

    const response = await fetch(`${baseUrl}/api/shared/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'testing', conversationId: conversation.id, attachments: [], dispatchTo: 'claude' }),
    });
    expect(response.status).toBe(202);
    expect(repository.getConversation(conversation.id)?.pinned).toBe(false);
    expect(repository.get(task.id)?.status).not.toBe('pinned');
  });

  it('unpins a standalone pinned conversation with no linked task on restore', async () => {
    const conversation = repository.createConversation('Solo pinned thread');
    repository.setConversationPinned(conversation.id, true);
    repository.setConversationArchived(conversation.id, true);

    const restored = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { conversation: { pinned: boolean } };
    expect(body.conversation.pinned).toBe(false);
  });

  it('unpins a pinned task and its linked conversation when restoring from the task', async () => {
    const task = repository.create({ title: 'Restart from task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { status: 'pinned' });
    const conversation = repository.createConversation('Linked restart', task.id);
    repository.setConversationPinned(conversation.id, true);
    repository.archive(task.id, false);

    const restored = await fetch(`${baseUrl}/api/work-items/${task.id}/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    expect((await restored.json()) as { item: { status: string } }).toEqual({ item: expect.objectContaining({ status: 'ready' }) });
    expect(repository.getConversation(conversation.id)).toEqual(expect.objectContaining({ archivedAt: null, pinned: false, linkedWorkItemPinned: false }));
  });

  it('persists all composer dropdown choices before a message is sent', async () => {
    const conversation = repository.createConversation('Remember composer choices');

    const saved = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/preferences`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executionProfile: 'deep', accountProfile: 'personal', dispatchTarget: 'claude' }),
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ conversation: expect.objectContaining({
      id: conversation.id,
      preferredExecutionProfile: 'deep',
      preferredAccountProfile: 'personal',
      preferredDispatchTarget: 'claude',
    }) });
    const reopened = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}`);
    expect(await reopened.json()).toEqual({ conversation: expect.objectContaining({
      preferredExecutionProfile: 'deep', preferredAccountProfile: 'personal', preferredDispatchTarget: 'claude',
    }) });
  });

  it('merges independent composer dropdown updates instead of letting one reset the others', async () => {
    const conversation = repository.createConversation('Independent composer choices');
    for (const body of [{ executionProfile: 'deep' }, { accountProfile: 'personal' }, { dispatchTarget: 'claude' }]) {
      const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/preferences`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    expect(repository.getConversation(conversation.id)).toEqual(expect.objectContaining({
      preferredExecutionProfile: 'deep', preferredAccountProfile: 'personal', preferredDispatchTarget: 'claude',
    }));
  });
});

describe('queue explainability and undo routes', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    server = createApp(database).listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  const create = (title: string, status: 'ready' | 'backlog' = 'ready') =>
    repository.create({ title, description: '', priority: 2, status, projectName: null, workspacePath: null, dueDate: null });

  it('explains the current order without changing it', async () => {
    const backlog = create('Vague idea', 'backlog');
    const ready = create('Ready to go');
    repository.reorder([backlog.id, ready.id]);

    const response = await fetch(`${baseUrl}/api/queue/explain`);
    expect(response.status).toBe(200);
    const body = await response.json() as { plan: { orderedItemIds: string[]; rationale: string; explanations: Array<{ itemId: string; signals: Array<{ key: string }> }> } };

    expect(body.plan.orderedItemIds).toEqual([ready.id, backlog.id]);
    expect(body.plan.rationale).toContain('ready to start');
    expect(body.plan.explanations.find((entry) => entry.itemId === ready.id)?.signals.map((signal) => signal.key)).toEqual(['status']);
    // Explaining is a read: the stored order is untouched.
    expect(repository.list().map((entry) => entry.id)).toEqual([backlog.id, ready.id]);
  });

  it('reverses the last movement through /api/queue/undo and 404s when there is nothing left', async () => {
    const first = create('First');
    const second = create('Second');
    repository.reorder([first.id, second.id]);

    const moved = await fetch(`${baseUrl}/api/queue/order`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: second.id, beforeId: first.id }),
    });
    expect(moved.status).toBe(200);
    expect(repository.list().map((entry) => entry.id)).toEqual([second.id, first.id]);

    const undo = await fetch(`${baseUrl}/api/queue/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(undo.status).toBe(200);
    const body = await undo.json() as { change: { actor: string; reason: string }; items: Array<{ id: string }> };
    expect(body.items.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(body.change.actor).toBe('jeffrey');
    expect(body.change.reason).toContain('Second');

    const empty = await fetch(`${baseUrl}/api/queue/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(empty.status).toBe(404);
  });

  it('moves tasks within the Workbench stack instead of looking them up in Attention', async () => {
    const attention = create('Attention stays in place');
    const first = repository.create({ title: 'Workbench first', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Workbench second', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.reorder([first.id, attention.id, second.id]);

    const moved = await fetch(`${baseUrl}/api/queue/order`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: second.id, beforeId: first.id, stack: 'workbench' }),
    });

    expect(moved.status).toBe(200);
    expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(repository.list().map((entry) => entry.id)).toEqual([second.id, attention.id, first.id]);
  });

  it('undoes an accepted proposal that reject can no longer reverse', async () => {
    const fresh = create('Fresh');
    const stale = create('Stale');
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * 86_400_000).toISOString(), stale.id);
    repository.reorder([fresh.id, stale.id]);

    const planned = await fetch(`${baseUrl}/api/queue/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const { proposal } = await planned.json() as { proposal: { id: string; explanations: Array<{ itemId: string; score: number }> } };
    // Planning is non-mutating. The proposed order is only applied by accept.
    expect(repository.list().map((entry) => entry.id)).toEqual([fresh.id, stale.id]);
    expect(proposal.explanations).toHaveLength(2);

    const accepted = await fetch(`${baseUrl}/api/queue/proposals/${proposal.id}/accepted`, { method: 'POST' });
    expect(accepted.status).toBe(200);

    const undo = await fetch(`${baseUrl}/api/queue/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(undo.status).toBe(200);
    expect(repository.list().map((entry) => entry.id)).toEqual([fresh.id, stale.id]);
  });

  it('plans the Workbench stack on its own from the Workbench focus route, leaving Attention untouched', async () => {
    const attention = create('Customer task');
    const fresh = repository.create({ title: 'Fresh roadmap task', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const stale = repository.create({ title: 'Stale roadmap task', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * 86_400_000).toISOString(), stale.id);

    const response = await fetch(`${baseUrl}/api/queue/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack: 'workbench' }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { proposal: { id: string; stack: string }; items: Array<{ id: string }> };
    expect(body.proposal.stack).toBe('workbench');
    expect(body.items.map((item) => item.id)).toEqual([stale.id, fresh.id]);
    // Planning is non-mutating and Attention is untouched by a Workbench-scoped plan.
    expect(repository.listWorkbench().map((item) => item.id)).toEqual([stale.id, fresh.id]);
    expect(repository.list().map((item) => item.id)).toEqual([stale.id, fresh.id, attention.id]);

    const accepted = await fetch(`${baseUrl}/api/queue/proposals/${body.proposal.id}/accepted`, { method: 'POST' });
    const acceptedBody = await accepted.json() as { proposal: { stack: string }; items: Array<{ id: string }> };
    expect(acceptedBody.proposal.stack).toBe('workbench');
    expect(acceptedBody.items.map((item) => item.id)).toEqual([stale.id, fresh.id]);
    expect(repository.listWorkbench().map((item) => item.id)).toEqual([stale.id, fresh.id]);
    expect(repository.list().map((item) => item.id)).toEqual([stale.id, fresh.id, attention.id]);
  });
});

describe('destructive operations soft-delete instead of hard-deleting', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const app = createApp(database);
    server = app.listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  it('deletes a work item from every list/get view while keeping the row in the database and logging the action', async () => {
    const item = repository.create({ title: 'Delete me', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    expect(repository.get(item.id)).toBeNull();
    expect(repository.list().some((entry) => entry.id === item.id)).toBe(false);
    expect(repository.listArchived().some((entry) => entry.id === item.id)).toBe(false);
    const row = database.prepare('SELECT deleted_at FROM work_items WHERE id = ?').get(item.id) as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
    const audit = repository.listAuditLog(10, null, 'destructive_action');
    expect(audit.entries).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining(item.id), workItemId: item.id })]));
  });

  it('404s a repeat DELETE for a work item that no longer exists (already deleted)', async () => {
    const item = repository.create({ title: 'Delete twice', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    await fetch(`${baseUrl}/api/work-items/${item.id}`, { method: 'DELETE' });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, { method: 'DELETE' });
    expect(response.status).toBe(404);
  });

  it('deletes a conversation from listings while keeping the row and logging the action', async () => {
    const conversation = repository.createConversation('To be deleted');

    const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    expect(repository.listConversations('all').some((entry) => entry.id === conversation.id)).toBe(false);
    const row = database.prepare('SELECT deleted_at FROM shared_conversations WHERE id = ?').get(conversation.id) as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
    const audit = repository.listAuditLog(10, null, 'destructive_action');
    expect(audit.entries).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining(conversation.id) })]));
  });

  it('lets undeleting a soft-deleted conversation restore it to the active listing', async () => {
    const conversation = repository.createConversation('To be undeleted');
    await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}`, { method: 'DELETE' });

    const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/undelete`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json() as { conversation: { id: string } };
    expect(body.conversation.id).toBe(conversation.id);

    expect(repository.listConversations('active').some((entry) => entry.id === conversation.id)).toBe(true);
    const row = database.prepare('SELECT deleted_at FROM shared_conversations WHERE id = ?').get(conversation.id) as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  it('404s undeleting a conversation that was never deleted', async () => {
    const conversation = repository.createConversation('Never deleted');

    const response = await fetch(`${baseUrl}/api/shared/conversations/${conversation.id}/undelete`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('removes a source connection from listings while keeping the row and logging the action', async () => {
    repository.setSourceConnection('github', 'Work GitHub', { token: 'secret-token' });

    const response = await fetch(`${baseUrl}/api/source-connections/github`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    expect(repository.listSourceConnections()).toEqual([]);
    const row = database.prepare('SELECT deleted_at FROM source_connections WHERE provider = ?').get('github') as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
    const audit = repository.listAuditLog(10, null, 'destructive_action');
    expect(audit.entries).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('github') })]));
  });

  it('404s removing a source connection that was never configured', async () => {
    const response = await fetch(`${baseUrl}/api/source-connections/github`, { method: 'DELETE' });
    expect(response.status).toBe(404);
  });

  it('rejects managed MCP authorization for a provider Codex login does not cover', async () => {
    const response = await fetch(`${baseUrl}/api/source-connections/github/managed/oauth/start`, { method: 'POST' });
    expect(response.status).toBe(400);
  });

  it('reports Atlassian as connected once a managed Codex login is stored', async () => {
    repository.setSourceConnection('confluence', 'Atlassian MCP · Codex', { mode: 'managed' });

    const response = await fetch(`${baseUrl}/api/source-connections`);
    const body = (await response.json()) as { connections: Array<{ id: string; state: string }> };
    expect(body.connections.find((connection) => connection.id === 'atlassian')?.state).toBe('connected');
  });

  it('reports Grafana as connected once a service-account token is stored', async () => {
    repository.setSourceConnection('grafana', 'Writer Grafana', { token: 'test-token' });

    const response = await fetch(`${baseUrl}/api/source-connections`);
    const body = (await response.json()) as { connections: Array<{ id: string; state: string }> };
    expect(body.connections.find((connection) => connection.id === 'grafana')?.state).toBe('connected');
  });

  it('persists Figma Discovery roots without replacing the managed connection settings', async () => {
    repository.setSourceConnection('figma', 'Figma MCP · Codex', { mode: 'managed' });
    const roots = ['https://www.figma.com/design/abc123/Workbench?node-id=1-2'];

    const saved = await fetch(`${baseUrl}/api/source-connections/figma/scope`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ roots });
    expect(repository.getSourceSettings('figma')).toEqual({ mode: 'managed', figmaRoots: JSON.stringify(roots) });

    const loaded = await fetch(`${baseUrl}/api/source-connections/figma/scope`);
    expect(await loaded.json()).toEqual({ roots });
  });

  it('lets reconnecting a soft-deleted source restore it to the active listing', async () => {
    repository.setSourceConnection('github', 'Work GitHub', { token: 'secret-token' });
    repository.removeSourceConnection('github');
    expect(repository.listSourceConnections()).toEqual([]);

    repository.setSourceConnection('github', 'Work GitHub (again)', { token: 'new-token' });
    expect(repository.listSourceConnections()).toEqual([expect.objectContaining({ provider: 'github', label: 'Work GitHub (again)' })]);
  });
});

describe('GET /api/audit-log', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const app = createApp(database);
    server = app.listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  it('lists recorded audit entries newest first, bounded by limit', async () => {
    repository.addAuditEntry('outbound_call', 'linear', 'POST https://api.linear.app/graphql');
    repository.addAuditEntry('agent_file_write', 'codex', 'src/app.ts');

    const response = await fetch(`${baseUrl}/api/audit-log`);
    expect(response.status).toBe(200);
    const body = await response.json() as { entries: Array<{ category: string; source: string; detail: string }>; nextCursor: string | null };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({ category: 'agent_file_write', source: 'codex' });
    expect(body.nextCursor).toBeNull();
  });

  it('filters by category and workItemId', async () => {
    const item = repository.create({ title: 'Audited task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.addAuditEntry('outbound_call', 'linear', 'call one');
    repository.addAuditEntry('agent_file_read', 'claude', 'src/index.ts', item.id);

    const byCategory = await fetch(`${baseUrl}/api/audit-log?category=agent_file_read`);
    const byCategoryBody = await byCategory.json() as { entries: Array<{ category: string }> };
    expect(byCategoryBody.entries).toEqual([expect.objectContaining({ category: 'agent_file_read' })]);

    const byWorkItem = await fetch(`${baseUrl}/api/audit-log?workItemId=${item.id}`);
    const byWorkItemBody = await byWorkItem.json() as { entries: Array<{ workItemId: string | null }> };
    expect(byWorkItemBody.entries).toEqual([expect.objectContaining({ workItemId: item.id })]);
  });

  it('rejects an invalid cursor with 400 instead of throwing', async () => {
    const response = await fetch(`${baseUrl}/api/audit-log?cursor=not-a-real-cursor`);
    expect(response.status).toBe(400);
  });

  it('rejects a limit above the bounded maximum of 200', async () => {
    const response = await fetch(`${baseUrl}/api/audit-log?limit=5000`);
    expect(response.status).toBe(400);
  });
});

describe('API mutation audit middleware', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const app = createApp(database);
    server = app.listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // searchActivityMemory refreshes memory-index.ts before every search;
    // stub the embedder so tests never download or run the real model.
    setEmbedder(deterministicTestEmbedder);
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
    setEmbedder(null);
  });

  it('records every completed mutating request without recording its body', async () => {
    const item = repository.create({ title: 'Audited through middleware', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'private request body' }),
    });
    expect(response.status).toBe(200);

    const audit = repository.listAuditLog(10, null, 'api_mutation', item.id);
    expect(audit.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'workbench_api', detail: 'PATCH /api/work-items/:id → 200', workItemId: item.id }),
    ]));
    expect(audit.entries.some((entry) => entry.detail.includes('private request body'))).toBe(false);
  });

  it('makes middleware audit entries available through activity memory', async () => {
    const response = await fetch(`${baseUrl}/api/work-items`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Middleware memory task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null }),
    });
    expect(response.status).toBe(201);
    const results = await repository.searchActivityMemory('api_mutation');
    expect(results.some((entry) => entry.source === 'audit' && entry.body === 'api_mutation: POST /api/work-items → 201')).toBe(true);
  });
});

describe('OAuth callback base origin', () => {
  const originalAppApiOrigin = process.env.APP_API_ORIGIN;
  const originalPort = process.env.PORT;

  afterEach(() => {
    if (originalAppApiOrigin === undefined) delete process.env.APP_API_ORIGIN;
    else process.env.APP_API_ORIGIN = originalAppApiOrigin;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it('never derives the callback origin from a client-supplied Host', () => {
    // No request object is passed in at all — this asserts the function has no
    // avenue back to request.protocol/request.get('host').
    delete process.env.APP_API_ORIGIN;
    process.env.PORT = '4317';
    expect(oauthCallbackBase()).toBe('http://localhost:4317/api/source-connections');
  });

  it('uses a validated APP_API_ORIGIN when it is an absolute http(s) URL', () => {
    process.env.APP_API_ORIGIN = 'https://workbench.example.com/api/source-connections';
    expect(oauthCallbackBase()).toBe('https://workbench.example.com/api/source-connections');
  });

  it('falls back to the fixed local origin when APP_API_ORIGIN is malformed', () => {
    process.env.APP_API_ORIGIN = 'not-a-url';
    process.env.PORT = '4317';
    expect(oauthCallbackBase()).toBe('http://localhost:4317/api/source-connections');
  });

  it('falls back to the fixed local origin when APP_API_ORIGIN uses a non-http(s) scheme', () => {
    process.env.APP_API_ORIGIN = 'javascript:alert(1)';
    process.env.PORT = '4317';
    expect(oauthCallbackBase()).toBe('http://localhost:4317/api/source-connections');
  });
});

describe('work-item activity logging middleware', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const app = createApp(database);
    server = app.listen(0);
    await new Promise<void>((resolveListen) => server.once('listening', () => resolveListen()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  // Previously-unlogged routes: the middleware must fill these gaps.

  it('logs an activity when a task link is removed', async () => {
    const first = repository.create({ title: 'First task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.addTaskLink(first.id, second.id);
    const activityCountBeforeRemoval = repository.listActivity(first.id).length;

    const response = await fetch(`${baseUrl}/api/work-items/${first.id}/linked-tasks/${second.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    const activity = repository.listActivity(first.id);
    expect(activity).toHaveLength(activityCountBeforeRemoval + 1);
    expect(activity[0]).toMatchObject({ kind: 'task_unlinked', actor: 'jeffrey', body: expect.stringContaining('Second task') });
  });

  it('logs an activity when a reference is removed', async () => {
    const item = repository.create({ title: 'Task with a reference', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const reference = repository.addReference(item.id, { type: 'document', url: 'https://example.com/doc', title: 'Design doc' });
    const activityCountBeforeRemoval = repository.listActivity(item.id).length;

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/references/${reference.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    const activity = repository.listActivity(item.id);
    expect(activity).toHaveLength(activityCountBeforeRemoval + 1);
    expect(activity[0]).toMatchObject({ kind: 'reference_removed', actor: 'jeffrey', body: expect.stringContaining(reference.id) });
  });

  it('logs an activity when a work item is deleted', async () => {
    const item = repository.create({ title: 'Task to delete', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    // The item is soft-deleted, so it no longer resolves through the normal
    // get() path, but the activities row still exists directly.
    const activity = repository.listActivity(item.id);
    expect(activity).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'deleted', actor: 'jeffrey', body: expect.stringContaining(item.id) })]));
    // The pre-existing destructive_action audit entry must still be written too.
    const audit = repository.listAuditLog(10, null, 'destructive_action');
    expect(audit.entries).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining(item.id) })]));
  });

  it('does not write an activity for a failed (404) request', async () => {
    const item = repository.create({ title: 'Solo task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/linked-tasks/00000000-0000-0000-0000-000000000000`, { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect(repository.listActivity(item.id).some((entry) => entry.kind === 'task_unlinked')).toBe(false);
  });

  // Routes that already log a richer, dynamic activity entry elsewhere (in the
  // handler or deeper inside the repository) must not get a second, duplicate
  // entry from this middleware.

  it('does not duplicate the activity entry when archiving a task', async () => {
    const item = repository.create({ title: 'Archive me', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/archive`, { method: 'POST' });
    expect(response.status).toBe(200);

    const activity = repository.listActivity(item.id);
    expect(activity.filter((entry) => entry.kind === 'archived')).toHaveLength(1);
  });

  it('does not duplicate the activity entry when adding a reference', async () => {
    const item = repository.create({ title: 'Task with a reference', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/references`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'document', url: 'https://example.com/doc', title: 'Design doc' }),
    });
    expect(response.status).toBe(201);

    const activity = repository.listActivity(item.id);
    expect(activity.filter((entry) => entry.kind === 'reference_added')).toHaveLength(1);
  });

  it('does not duplicate the activity entry when linking two tasks', async () => {
    const first = repository.create({ title: 'First task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const response = await fetch(`${baseUrl}/api/work-items/${first.id}/linked-tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkedWorkItemId: second.id }),
    });
    expect(response.status).toBe(201);

    const activity = repository.listActivity(first.id);
    expect(activity.filter((entry) => entry.kind === 'task_linked')).toHaveLength(1);
  });
});

describe('follow-up task plan parsing', () => {
  const rawPlan = JSON.stringify({
    summary: 'Establish the baseline.',
    tasks: [{ title: 'Investigate q14', description: 'Determine the root cause and record it.', workspacePath: null }],
  });

  it('accepts a valid unwrapped JSON plan from the agent', () => {
    expect(parseFollowUpPlan(rawPlan)).toEqual(JSON.parse(rawPlan));
  });

  it('continues to accept the requested workbench-plan wrapper', () => {
    expect(parseFollowUpPlan(`<workbench-plan>${rawPlan}</workbench-plan>`)).toEqual(JSON.parse(rawPlan));
  });
});
