import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { REALTIME_PROTOCOL_VERSION, type RealtimeServerFrame } from '../shared/realtime-protocol.js';
import { createApp } from './app.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { attachRealtimeServer } from './realtime.js';
import { createApplicationSocketHandler } from './socket-application.js';

describe('WebSocket application transport', () => {
  let database: WorkbenchDatabase | null = null;
  let stopRealtime: (() => void) | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  let client: WebSocket | null = null;
  const queuedFrames: RealtimeServerFrame[] = [];
  const frameWaiters: Array<(frame: RealtimeServerFrame) => void> = [];

  function nextFrame(): Promise<RealtimeServerFrame> {
    const queued = queuedFrames.shift();
    return queued ? Promise.resolve(queued) : new Promise((resolve) => frameWaiters.push(resolve));
  }

  async function nextResponse(id: string): Promise<Extract<RealtimeServerFrame, { type: 'response' }>> {
    for (;;) {
      const frame = await nextFrame();
      if (frame.type === 'response' && frame.id === id) return frame;
    }
  }

  afterEach(async () => {
    client?.terminate();
    stopRealtime?.();
    if (server) {
      server.close();
      await once(server, 'close');
    }
    database?.close();
  });

  it('creates and reads application state through one WebSocket with no HTTP data request', async () => {
    database = openDatabase(':memory:');
    const app = createApp(database);
    server = createServer(app);
    stopRealtime = attachRealtimeServer(server, { handleRequest: createApplicationSocketHandler(app) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');

    client = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`);
    await once(client, 'open');
    client.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as RealtimeServerFrame;
      const waiter = frameWaiters.shift();
      if (waiter) waiter(frame); else queuedFrames.push(frame);
    });
    client.send(JSON.stringify({ type: 'hello', protocol: REALTIME_PROTOCOL_VERSION, clientId: 'integration-browser', resumeFrom: null }));
    expect(await nextFrame()).toMatchObject({ type: 'ready', resumed: true });

    client.send(JSON.stringify({
      type: 'request', protocol: REALTIME_PROTOCOL_VERSION, id: 'create-1', operation: 'application.command', mode: 'command',
      input: { method: 'POST', path: '/api/work-items', body: JSON.stringify({ title: 'Socket only', description: '', status: 'ready', priority: 2, projectName: null, dueDate: null }) },
    }));
    const createdFrame = await nextResponse('create-1');
    const createdEnvelope = createdFrame.data as { status: number; body: string };
    expect(createdEnvelope.status).toBe(201);
    expect(JSON.parse(createdEnvelope.body)).toMatchObject({ item: { title: 'Socket only' } });

    client.send(JSON.stringify({
      type: 'request', protocol: REALTIME_PROTOCOL_VERSION, id: 'list-1', operation: 'application.read', mode: 'read',
      input: { method: 'GET', path: '/api/work-items?view=active' },
    }));
    const listedFrame = await nextResponse('list-1');
    const listedEnvelope = listedFrame.data as { status: number; body: string };
    expect(JSON.parse(listedEnvelope.body)).toMatchObject({ items: [expect.objectContaining({ title: 'Socket only' })] });
  });
});
