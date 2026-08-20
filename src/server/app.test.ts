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
