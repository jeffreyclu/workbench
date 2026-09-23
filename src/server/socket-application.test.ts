import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import express from 'express';
import { createApp } from './app.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { createApplicationSocketHandler } from './socket-application.js';
import { abortSignalForRequest } from './request-abort.js';

describe('application WebSocket dispatcher', () => {
  let database: WorkbenchDatabase;
  let app: Express;

  beforeEach(() => {
    database = openDatabase(':memory:');
    app = createApp(database);
  });

  afterEach(() => database.close());

  const context = () => ({ clientId: 'browser', requestId: crypto.randomUUID(), headers: {}, signal: new AbortController().signal, emit: () => undefined });

  it('executes an application read in-process and returns its JSON response envelope', async () => {
    const handle = createApplicationSocketHandler(app);
    const result = await handle('application.read', { method: 'GET', path: '/api/projects' }, context());
    expect(result).toMatchObject({ status: 200, contentType: expect.stringContaining('application/json') });
    expect(JSON.parse((result as { body: string }).body)).toEqual({ projects: [] });
  });

  it('executes a command through the same controller and makes the result readable over the socket', async () => {
    const handle = createApplicationSocketHandler(app);
    const created = await handle('application.command', {
      method: 'POST',
      path: '/api/work-items',
      body: JSON.stringify({ title: 'Socket task', description: '', status: 'ready', priority: 2, projectName: null, dueDate: null }),
    }, context()) as { status: number; body: string };
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ item: { title: 'Socket task' } });

    const listed = await handle('application.read', { method: 'GET', path: '/api/work-items?view=active' }, context()) as { status: number; body: string };
    expect(JSON.parse(listed.body)).toMatchObject({ items: [expect.objectContaining({ title: 'Socket task' })] });
  });

  it('rejects HTTP-only and malformed application inputs', async () => {
    const handle = createApplicationSocketHandler(app);
    await expect(handle('application.read', { method: 'POST', path: '/api/work-items' }, context())).rejects.toThrow('Read operations must use GET');
    await expect(handle('application.read', { method: 'GET', path: '/mcp' }, context())).rejects.toThrow('path is invalid');
    await expect(handle('application.read', { method: 'GET', path: '/api/realtime' }, context())).rejects.toThrow('path is invalid');
  });

  it('forwards incremental controller output as correlated WebSocket progress', async () => {
    const streamingApp = express();
    streamingApp.use(express.json());
    streamingApp.post('/api/stream', (_request, response) => {
      response.type('text/event-stream');
      response.write('data: first\n\n');
      response.write('data: second\n\n');
      response.end();
    });
    const emit = vi.fn();
    const handle = createApplicationSocketHandler(streamingApp);
    const result = await handle('application.command', { method: 'POST', path: '/api/stream', body: '{}', stream: true }, { ...context(), emit }) as { status: number; body: string };
    expect(emit.mock.calls.map(([chunk]) => chunk)).toEqual(['data: first\n\n', 'data: second\n\n']);
    expect(result).toMatchObject({ status: 200, body: 'data: first\n\ndata: second\n\n' });
  });

  it('encodes binary controller output without corrupting bytes', async () => {
    const binaryApp = express();
    binaryApp.get('/api/file', (_request, response) => response.type('image/png').send(Buffer.from([0, 255, 12, 10])));
    const handle = createApplicationSocketHandler(binaryApp);
    const result = await handle('application.read', { method: 'GET', path: '/api/file' }, context()) as { status: number; encoding: string; body: string };
    expect(result).toEqual(expect.objectContaining({ status: 200, encoding: 'base64', body: Buffer.from([0, 255, 12, 10]).toString('base64') }));
  });

  it('does not self-abort a slow WebSocket application request when its synthetic body ends', async () => {
    const slowApp = express();
    slowApp.use(express.json());
    slowApp.post('/api/search', async (request, response) => {
      const signal = abortSignalForRequest(request, response);
      await new Promise((resolve) => setTimeout(resolve, 25));
      response.json({ aborted: signal.aborted });
    });
    const handle = createApplicationSocketHandler(slowApp);

    const result = await handle('application.command', { method: 'POST', path: '/api/search', body: '{}' }, context()) as { body: string };

    expect(JSON.parse(result.body)).toEqual({ aborted: false });
  });
});
