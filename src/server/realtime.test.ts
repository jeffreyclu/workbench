import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { attachRealtimeServer, publishRealtimeEvent, publishRealtimeNotification } from './realtime.js';

describe('realtime server', () => {
  let close: (() => void) | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    close?.();
    if (server) {
      server.close();
      await once(server, 'close');
    }
    close = undefined;
    server = undefined;
  });

  it('sends ready and publishes typed invalidations and notifications to connected clients', async () => {
    server = createServer();
    close = attachRealtimeServer(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`);
    const [ready] = await once(client, 'message');
    expect(JSON.parse(String(ready))).toEqual({ type: 'ready' });

    publishRealtimeEvent('shared', 'work-items');
    const [invalidation] = await once(client, 'message');
    expect(JSON.parse(String(invalidation))).toEqual({ type: 'invalidate', topics: ['shared', 'work-items'] });
    publishRealtimeNotification({ tone: 'success', message: 'Agent finished', action: { label: 'Open conversation', route: '/conversations/123' } });
    const [notification] = await once(client, 'message');
    expect(JSON.parse(String(notification))).toEqual({ type: 'notification', tone: 'success', message: 'Agent finished', action: { label: 'Open conversation', route: '/conversations/123' } });
    client.close();
  });

  it('rejects a cross-origin upgrade', async () => {
    server = createServer();
    close = attachRealtimeServer(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`, { headers: { Origin: 'https://untrusted.example' } });
    const [, response] = await once(client, 'unexpected-response');
    expect(response.statusCode).toBe(401);
  });
});
