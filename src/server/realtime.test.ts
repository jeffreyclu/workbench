import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_PROTOCOL_VERSION, type RealtimeServerFrame } from '../shared/realtime-protocol.js';
import { attachRealtimeServer, publishRealtimeEvent, publishRealtimeNotification, retireRealtimeClients } from './realtime.js';

function nextFrame(client: WebSocket): Promise<RealtimeServerFrame> {
  return once(client, 'message').then(([data]) => JSON.parse(String(data)) as RealtimeServerFrame);
}

function sendHello(client: WebSocket, clientId: string, resumeFrom: number | null = null): void {
  client.send(JSON.stringify({ type: 'hello', protocol: REALTIME_PROTOCOL_VERSION, clientId, resumeFrom }));
}

describe('realtime server', () => {
  let close: (() => void) | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  const clients: WebSocket[] = [];

  async function start(options: Parameters<typeof attachRealtimeServer>[1] = {}): Promise<number> {
    server = createServer();
    close = attachRealtimeServer(server, options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    return address.port;
  }

  async function connect(port: number, clientId = 'browser-1', resumeFrom: number | null = null): Promise<{ client: WebSocket; ready: Extract<RealtimeServerFrame, { type: 'ready' }> }> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`);
    clients.push(client);
    await once(client, 'open');
    sendHello(client, clientId, resumeFrom);
    const ready = await nextFrame(client);
    if (ready.type !== 'ready') throw new Error(`Expected ready, received ${ready.type}.`);
    return { client, ready };
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.on('error', () => undefined);
      if (client.readyState === WebSocket.OPEN) client.terminate();
    }
    close?.();
    if (server) {
      server.close();
      await once(server, 'close');
    }
    close = undefined;
    server = undefined;
  });

  it('requires a versioned hello before accepting application requests', async () => {
    const port = await start({ handleRequest: async () => ({ ok: true }) });
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`);
    clients.push(client);
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'request', protocol: REALTIME_PROTOCOL_VERSION, id: 'r1', operation: 'system.health', input: {}, mode: 'read' }));
    expect(await nextFrame(client)).toMatchObject({ type: 'error', id: 'r1', code: 'hello_required' });
  });

  it('delivers sequenced events and replays only missed events after reconnect', async () => {
    const port = await start();
    const first = await connect(port);
    publishRealtimeEvent('shared', 'work-items');
    const live = await nextFrame(first.client);
    expect(live).toMatchObject({ type: 'event', event: { kind: 'invalidate', topics: ['shared', 'work-items'] } });
    if (live.type !== 'event') throw new Error('Expected event.');
    const firstClosed = once(first.client, 'close');
    first.client.terminate();
    await firstClosed;

    publishRealtimeNotification({ tone: 'success', message: 'Agent finished' });
    const secondClient = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`);
    clients.push(secondClient);
    await once(secondClient, 'open');
    const frames = new Promise<RealtimeServerFrame[]>((resolve) => {
      const received: RealtimeServerFrame[] = [];
      secondClient.on('message', (data) => {
        received.push(JSON.parse(String(data)) as RealtimeServerFrame);
        if (received.length === 2) resolve(received);
      });
    });
    sendHello(secondClient, 'browser-1', live.sequence);
    const [replayed, ready] = await frames;
    expect(replayed).toMatchObject({ type: 'event', sequence: live.sequence + 1, event: { kind: 'notification', message: 'Agent finished' } });
    expect(ready).toMatchObject({ type: 'ready', resumed: true, sequence: live.sequence + 1 });
  });

  it('runs correlated requests and returns typed results', async () => {
    const handleRequest = vi.fn(async (operation: string, input: unknown) => ({ operation, input }));
    const port = await start({ handleRequest });
    const { client } = await connect(port);
    client.send(JSON.stringify({ type: 'request', protocol: REALTIME_PROTOCOL_VERSION, id: 'r1', operation: 'system.health', input: { verbose: false }, mode: 'read' }));
    expect(await nextFrame(client)).toEqual({
      type: 'response',
      protocol: REALTIME_PROTOCOL_VERSION,
      id: 'r1',
      data: { operation: 'system.health', input: { verbose: false } },
    });
    expect(handleRequest).toHaveBeenCalledOnce();
  });

  it('deduplicates a repeated request id for the same browser session', async () => {
    const handleRequest = vi.fn(async () => ({ saved: true }));
    const port = await start({ handleRequest });
    const { client } = await connect(port, 'dedupe-browser');
    const request = JSON.stringify({ type: 'request', protocol: REALTIME_PROTOCOL_VERSION, id: 'same-command', operation: 'tasks.save', input: {}, mode: 'command' });
    client.send(request);
    expect(await nextFrame(client)).toMatchObject({ type: 'response', id: 'same-command' });
    client.send(request);
    expect(await nextFrame(client)).toMatchObject({ type: 'response', id: 'same-command' });
    expect(handleRequest).toHaveBeenCalledOnce();
  });

  it('keeps a command alive across a network drop and lets reconnect recover its result once', async () => {
    let finish: ((value: { saved: boolean }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const handleRequest = vi.fn(() => new Promise<{ saved: boolean }>((resolve) => {
      finish = resolve;
      markStarted?.();
    }));
    const port = await start({ handleRequest });
    const first = await connect(port, 'reconnecting-browser');
    const request = JSON.stringify({ type: 'request', protocol: REALTIME_PROTOCOL_VERSION, id: 'durable-command', operation: 'tasks.save', input: {}, mode: 'command' });
    first.client.send(request);
    await started;
    const closed = once(first.client, 'close');
    first.client.terminate();
    await closed;

    const second = await connect(port, 'reconnecting-browser');
    second.client.send(request);
    finish?.({ saved: true });
    expect(await nextFrame(second.client)).toMatchObject({ type: 'response', id: 'durable-command', data: { saved: true } });
    expect(handleRequest).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight operation', async () => {
    const handleRequest = vi.fn((_operation: string, _input: unknown, context: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const port = await start({ handleRequest });
    const { client } = await connect(port);
    client.send(JSON.stringify({ type: 'request', protocol: REALTIME_PROTOCOL_VERSION, id: 'slow', operation: 'search.run', input: {}, mode: 'read' }));
    client.send(JSON.stringify({ type: 'cancel', protocol: REALTIME_PROTOCOL_VERSION, id: 'slow' }));
    expect(await nextFrame(client)).toMatchObject({ type: 'error', id: 'slow', code: 'cancelled', retryable: false });
  });

  it('rejects a cross-origin upgrade', async () => {
    const port = await start();
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, { headers: { Origin: 'https://untrusted.example' } });
    clients.push(client);
    const [, response] = await once(client, 'unexpected-response');
    expect(response.statusCode).toBe(401);
  });

  it('closes clients with service-restart status when its runtime retires', async () => {
    const port = await start();
    const { client } = await connect(port);
    const closed = once(client, 'close');
    retireRealtimeClients();
    const [code] = await closed;
    expect(code).toBe(1012);
  });
});
