// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_PROTOCOL_VERSION } from '../../shared/realtime-protocol';
import { SocketTransport } from './socket-transport';

class MockSocket {
  static instances: MockSocket[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent | Event) => void>>();
  readonly sent: string[] = [];
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', new CloseEvent('close'));
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open', new Event('open'));
  }

  receive(frame: unknown): void {
    this.emit('message', new MessageEvent('message', { data: JSON.stringify(frame) }));
  }

  private emit(type: string, event: MessageEvent | Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createTransport(): SocketTransport {
  return new SocketTransport(() => 'ws://workbench.test/api/realtime', (url) => new MockSocket(url));
}

function frame(index: number): Record<string, unknown> {
  return JSON.parse(MockSocket.instances[0].sent[index]) as Record<string, unknown>;
}

afterEach(() => {
  MockSocket.instances = [];
  sessionStorage.clear();
  vi.useRealTimers();
});

describe('SocketTransport', () => {
  it('shares one connection and waits for the versioned ready handshake before sending requests', async () => {
    const transport = createTransport();
    const states: string[] = [];
    transport.subscribeState((state) => states.push(state));
    const result = transport.request<{ ok: boolean }>('system.health', {}, { mode: 'read' });
    expect(MockSocket.instances).toHaveLength(1);

    const socket = MockSocket.instances[0];
    socket.open();
    expect(frame(0)).toMatchObject({ type: 'hello', protocol: REALTIME_PROTOCOL_VERSION, resumeFrom: null });
    expect(socket.sent).toHaveLength(1);
    socket.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's1', sequence: 0, resumed: true });
    const request = frame(1);
    expect(request).toMatchObject({ type: 'request', operation: 'system.health', mode: 'read' });
    socket.receive({ type: 'response', protocol: REALTIME_PROTOCOL_VERSION, id: request.id, data: { ok: true } });
    await expect(result).resolves.toEqual({ ok: true });
    expect(states.at(-1)).toBe('connected');
    transport.dispose();
  });

  it('retries an interrupted read with the same request id after reconnect', async () => {
    vi.useFakeTimers();
    const transport = createTransport();
    const result = transport.request<{ items: number[] }>('tasks.list', {}, { mode: 'read' });
    const first = MockSocket.instances[0];
    first.open();
    first.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's1', sequence: 4, resumed: true });
    const firstRequest = JSON.parse(first.sent[1]) as { id: string };
    first.close();

    await vi.advanceTimersByTimeAsync(2_000);
    const second = MockSocket.instances[1];
    second.open();
    second.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's2', sequence: 4, resumed: true });
    const retried = JSON.parse(second.sent[1]) as { id: string };
    expect(retried.id).toBe(firstRequest.id);
    second.receive({ type: 'response', protocol: REALTIME_PROTOCOL_VERSION, id: retried.id, data: { items: [1] } });
    await expect(result).resolves.toEqual({ items: [1] });
    transport.dispose();
  });

  it('does not retry a command whose result became uncertain', async () => {
    const transport = createTransport();
    const result = transport.request('tasks.create', { title: 'A' }, { mode: 'command' });
    const socket = MockSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's1', sequence: 0, resumed: true });
    socket.close();
    await expect(result).rejects.toThrow('was not retried');
    transport.dispose();
  });

  it('never leaks a backpressured command onto a replacement connection', async () => {
    vi.useFakeTimers();
    const transport = createTransport();
    transport.subscribeState(() => undefined);
    const socket = MockSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's1', sequence: 0, resumed: true });
    socket.bufferedAmount = 5 * 1024 * 1024;
    const result = transport.request('tasks.create', { title: 'A' }, { mode: 'command' });
    expect(socket.sent).toHaveLength(1);
    socket.close();
    await expect(result).rejects.toThrow('was not retried');

    await vi.advanceTimersByTimeAsync(2_000);
    const replacement = MockSocket.instances[1];
    replacement.open();
    replacement.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's2', sequence: 0, resumed: true });
    expect(replacement.sent.map((payload) => JSON.parse(payload))).toEqual([
      expect.objectContaining({ type: 'hello' }),
    ]);
    transport.dispose();
  });

  it('delivers ordered events once and requests a resync on an unrecoverable gap', () => {
    const transport = createTransport();
    const events: string[] = [];
    transport.subscribeEvents((event) => events.push(event.kind));
    const socket = MockSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's1', sequence: 0, resumed: true });
    socket.receive({ type: 'event', protocol: REALTIME_PROTOCOL_VERSION, sequence: 1, event: { kind: 'invalidate', topics: ['work-items'] } });
    socket.receive({ type: 'event', protocol: REALTIME_PROTOCOL_VERSION, sequence: 1, event: { kind: 'invalidate', topics: ['work-items'] } });
    socket.receive({ type: 'event', protocol: REALTIME_PROTOCOL_VERSION, sequence: 3, event: { kind: 'notification', tone: 'info', message: 'Changed' } });
    expect(events).toEqual(['invalidate', 'resync-required', 'notification']);
    transport.dispose();
  });

  it('sends cancellation when an AbortSignal stops an in-flight request', async () => {
    const transport = createTransport();
    const controller = new AbortController();
    const result = transport.request('search.run', {}, { mode: 'read', signal: controller.signal });
    const socket = MockSocket.instances[0];
    socket.open();
    socket.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 's1', sequence: 0, resumed: true });
    const request = JSON.parse(socket.sent[1]) as { id: string };
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(JSON.parse(socket.sent[2])).toMatchObject({ type: 'cancel', id: request.id });
    transport.dispose();
  });
});
