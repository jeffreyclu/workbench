import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';

describe('POST /api/work-items/:id/execute and /runs dedup guard', () => {
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
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    database.close();
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

  it('rejects a duplicate /runs request while a run is already active for the task (409)', async () => {
    const item = repository.create({ title: 'Dedup guard task 2', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(item.id, 'review', 'codex', 'codex', '');

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
    });
    expect(response.status).toBe(409);
  });

  it('allows a fresh /runs request once the prior run has completed', async () => {
    const item = repository.create({ title: 'Dedup guard task 3', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const priorRun = repository.createRun(item.id, 'review', 'codex', 'codex', '');
    repository.updateRun(priorRun.id, { status: 'completed', completedAt: new Date().toISOString() });

    const response = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'review', target: 'codex', instructions: '' }),
    });
    expect(response.status).toBe(202);
  });
});

describe('/api/memories', () => {
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
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    database.close();
  });

  it('creates a memory via POST, landing active, and exposes provenance on GET (criterion 3)', async () => {
    const item = repository.create({ title: 'Provenance task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Provenance thread', item.id);
    const message = repository.createSharedMessage('codex', 'We decided to use SQLite for this.', 'completed', conversation.id);

    const createResponse = await fetch(`${baseUrl}/api/memories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'decision', scope: 'reference', sourceTaskId: item.id, sourceConversationId: conversation.id,
        sourceMessageId: message.id, sourceQuote: 'We decided to use SQLite for this.', body: 'Use SQLite for local persistence.', createdBy: 'codex',
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { memory: { id: string; status: string } };
    expect(created.memory.status).toBe('active');

    const getResponse = await fetch(`${baseUrl}/api/memories?scope=reference`);
    expect(getResponse.status).toBe(200);
    const listed = (await getResponse.json()) as { memories: Array<Record<string, unknown>> };
    const found = listed.memories.find((entry) => entry.id === created.memory.id);
    expect(found).toMatchObject({
      sourceTaskId: item.id,
      sourceConversationId: conversation.id,
      sourceMessageId: message.id,
      sourceQuote: 'We decided to use SQLite for this.',
    });
  });

  it('rejects a memory scope missing its required field with a 400', async () => {
    const response = await fetch(`${baseUrl}/api/memories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'fact', scope: 'project', body: 'Missing project name.' }),
    });
    expect(response.status).toBe(400);
  });

  it('edits a memory via PATCH', async () => {
    const createResponse = await fetch(`${baseUrl}/api/memories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'fact', scope: 'global', body: 'Original body.' }),
    });
    const { memory } = (await createResponse.json()) as { memory: { id: string } };

    const patchResponse = await fetch(`${baseUrl}/api/memories/${memory.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Edited body.' }),
    });
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as { memory: { body: string } };
    expect(patched.memory.body).toBe('Edited body.');
  });

  it('returns 404 for PATCH/supersede/DELETE on an unknown memory id', async () => {
    const unknownId = '00000000-0000-0000-0000-000000000000';
    const patchResponse = await fetch(`${baseUrl}/api/memories/${unknownId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
    });
    expect(patchResponse.status).toBe(404);

    const supersedeResponse = await fetch(`${baseUrl}/api/memories/${unknownId}/supersede`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fact', body: 'x' }),
    });
    expect(supersedeResponse.status).toBe(404);

    const deleteResponse = await fetch(`${baseUrl}/api/memories/${unknownId}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(404);
  });

  it('supersedes a memory: old marked superseded, new one returned active', async () => {
    const createResponse = await fetch(`${baseUrl}/api/memories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'constraint', scope: 'global', body: 'Old constraint.' }),
    });
    const { memory: original } = (await createResponse.json()) as { memory: { id: string } };

    const supersedeResponse = await fetch(`${baseUrl}/api/memories/${original.id}/supersede`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'constraint', body: 'New constraint.' }),
    });
    expect(supersedeResponse.status).toBe(201);
    const { memory: replacement } = (await supersedeResponse.json()) as { memory: { id: string; status: string; supersedesId: string; body: string } };
    expect(replacement.status).toBe('active');
    expect(replacement.supersedesId).toBe(original.id);
    expect(replacement.body).toBe('New constraint.');

    const listResponse = await fetch(`${baseUrl}/api/memories?status=superseded`);
    const listed = (await listResponse.json()) as { memories: Array<{ id: string; status: string }> };
    expect(listed.memories.find((entry) => entry.id === original.id)?.status).toBe('superseded');
  });

  it('DELETE rejects a memory and returns the row, never 204', async () => {
    const createResponse = await fetch(`${baseUrl}/api/memories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'fact', scope: 'global', body: 'Delete me.' }),
    });
    const { memory } = (await createResponse.json()) as { memory: { id: string } };

    const deleteResponse = await fetch(`${baseUrl}/api/memories/${memory.id}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    const deleted = (await deleteResponse.json()) as { memory: { id: string; status: string } };
    expect(deleted.memory.id).toBe(memory.id);
    expect(deleted.memory.status).toBe('rejected');
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
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
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
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
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

  it('undoes an accepted proposal that reject can no longer reverse', async () => {
    const fresh = create('Fresh');
    const stale = create('Stale');
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * 86_400_000).toISOString(), stale.id);
    repository.reorder([fresh.id, stale.id]);

    const planned = await fetch(`${baseUrl}/api/queue/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const { proposal } = await planned.json() as { proposal: { id: string; explanations: Array<{ itemId: string; score: number }> } };
    expect(repository.list().map((entry) => entry.id)).toEqual([stale.id, fresh.id]);
    expect(proposal.explanations).toHaveLength(2);

    const accepted = await fetch(`${baseUrl}/api/queue/proposals/${proposal.id}/accepted`, { method: 'POST' });
    expect(accepted.status).toBe(200);

    const undo = await fetch(`${baseUrl}/api/queue/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(undo.status).toBe(200);
    expect(repository.list().map((entry) => entry.id)).toEqual([fresh.id, stale.id]);
  });
});
