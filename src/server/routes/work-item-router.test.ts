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
}));

import { createApp } from '../app.js';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { closeTestServer } from '../test-http-harness.js';

describe('work item router', () => {
  let database: WorkbenchDatabase;
  let server: Server;
  let baseUrl: string;
  let workspace: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    database = openDatabase(':memory:');
    workspace = mkdtempSync(join(tmpdir(), 'work-item-router-'));
    server = createApp(database).listen(0);
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
  const createItem = async (body: Record<string, unknown> = {}) => {
    const response = await request('/api/work-items', 'POST', { title: 'Publish workspace', workspacePath: workspace, ...body });
    expect(response.status).toBe(201);
    return (await response.json() as { item: { id: string } }).item;
  };

  it('writes sanitized attachments when creating and appending work items', async () => {
    const attachment = { name: '../design brief?.txt', mimeType: 'text/plain', size: 5, dataBase64: Buffer.from('hello').toString('base64') };
    const item = await createItem({ attachments: [attachment] });

    expect(seams.mkdirSync).toHaveBeenCalledWith(resolve('data/attachments'), { recursive: true });
    expect(seams.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/data\/attachments\/.+-design_brief_.txt$/), Buffer.from('hello'));

    const appended = await request(`/api/work-items/${item.id}/attachments`, 'POST', { attachments: [{ ...attachment, name: 'notes.md' }] });
    expect(appended.status).toBe(201);
    expect(seams.writeFileSync).toHaveBeenLastCalledWith(expect.stringMatching(/data\/attachments\/.+-notes.md$/), Buffer.from('hello'));
    expect((await appended.json() as { item: { attachments: unknown[] } }).item.attachments).toHaveLength(2);
  });

  it('returns a stable server error when attachment storage rejects the write', async () => {
    seams.writeFileSync.mockImplementationOnce(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });

    const response = await request('/api/work-items', 'POST', {
      title: 'Cannot persist',
      attachments: [{ name: 'secret.txt', mimeType: 'text/plain', size: 1, dataBase64: 'eA==' }],
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'permission denied' });
    expect((await request('/api/work-items')).status).toBe(200);
  });

  it('resolves the selected workspace before loading a file at a revision', async () => {
    const item = await createItem();
    seams.getWorkspaceFileSource.mockResolvedValue({ path: 'src/worker.ts', content: 'export {}', error: null });

    const response = await request(`/api/work-items/${item.id}/workspace-diff/file?path=src%2Fworker.ts&revision=abc123`);

    expect(response.status).toBe(200);
    expect(seams.getWorkspaceFileSource).toHaveBeenCalledWith(workspace, 'src/worker.ts', 'abc123');
    await expect(response.json()).resolves.toEqual({ file: { path: 'src/worker.ts', content: 'export {}', error: null } });
  });

  it('requires a usable workspace before reading a diff file or committing', async () => {
    const item = await createItem({ workspacePath: null });

    expect((await request(`/api/work-items/${item.id}/workspace-diff/file?path=src%2Fa.ts`)).status).toBe(409);
    expect((await request(`/api/work-items/${item.id}/workspace-diff/commit-and-push`, 'POST', { revision: 'revision' })).status).toBe(409);
  });

  it('commits and pushes the selected workspace with the default item message', async () => {
    const item = await createItem();
    seams.commitAndPushWorkspace.mockResolvedValue({ committed: true, pushed: true, commit: 'abc1234' });

    const response = await request(`/api/work-items/${item.id}/workspace-diff/commit-and-push`, 'POST', { revision: 'revision-1' });

    expect(response.status).toBe(200);
    expect(seams.commitAndPushWorkspace).toHaveBeenCalledWith(workspace, 'chore: Publish workspace', 'revision-1');
    await expect(response.json()).resolves.toEqual({ result: { committed: true, pushed: true, commit: 'abc1234' } });
  });

  it('surfaces a git command failure without reporting a false publish', async () => {
    const item = await createItem();
    seams.commitAndPushWorkspace.mockRejectedValue(new Error('Commit created, but push failed. remote: permission denied'));

    const response = await request(`/api/work-items/${item.id}/workspace-diff/commit-and-push`, 'POST', { revision: 'revision-1', message: 'feat: publish' });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Commit created, but push failed. remote: permission denied' });
    expect(seams.commitAndPushWorkspace).toHaveBeenCalledWith(workspace, 'feat: publish', 'revision-1');
  });

  it('rejects malformed commit requests and unknown work items before calling git', async () => {
    const item = await createItem();
    expect((await request(`/api/work-items/${item.id}/workspace-diff/commit-and-push`, 'POST', {})).status).toBe(400);
    expect((await request('/api/work-items/missing/workspace-diff/commit-and-push', 'POST', { revision: 'revision-1' })).status).toBe(404);
    expect(seams.commitAndPushWorkspace).not.toHaveBeenCalled();
  });
});
