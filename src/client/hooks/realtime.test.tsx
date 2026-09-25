// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_PROTOCOL_VERSION } from '../../shared/realtime-protocol';
import { resetSocketTransportForTests } from '../data/socket-transport';
import { invalidateRealtimeTopics, realtimeUrl, useRealtimeNotifications } from './realtime';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly sent: string[] = [];
  readonly url: string;
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  receive(frame: unknown) { this.emit('message', JSON.stringify(frame)); }
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
}

function installSocket(): void {
  vi.stubGlobal('WebSocket', MockWebSocket);
  resetSocketTransportForTests();
}

function ready(socket: MockWebSocket, resumed = true): void {
  socket.open();
  socket.receive({ type: 'ready', protocol: REALTIME_PROTOCOL_VERSION, sessionId: 'session', sequence: 0, resumed });
}

afterEach(() => {
  MockWebSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('realtime application hook', () => {
  it('uses a secure socket for secure pages', () => {
    expect(realtimeUrl({ protocol: 'https:', host: 'workbench.example' })).toBe('wss://workbench.example/api/realtime');
    expect(realtimeUrl({ protocol: 'http:', host: 'localhost:5180' })).toBe('ws://localhost:5180/api/realtime');
  });

  it('maps transitional topic events to every affected feature cache without duplicates', () => {
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    invalidateRealtimeTopics(client, ['work-items', 'shared', 'shared-messages', 'discovery', 'runtime', 'insights', 'artifacts'], new Set(), new Set(), true);
    for (const queryKey of [
      ['work-items'], ['work-item'], ['tab-counts'], ['shared-conversations'], ['shared-messages'],
      ['shared-agent-events'], ['workspace-diff'], ['discovery'], ['runtime-preview-status'], ['health'],
      ['insights'], ['memory-diagnostics'], ['mcp-quality'], ['artifacts'],
    ]) expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
    expect(invalidateQueries.mock.calls.filter(([input]) => JSON.stringify(input) === JSON.stringify({ queryKey: ['workspace-diff-status'] }))).toHaveLength(1);
  });

  it('keeps unrelated task details cached and scopes detail invalidation by work item id', () => {
    const client = new QueryClient();
    client.setQueryData(['work-item', 'task-a'], { item: { id: 'task-a' } });
    client.setQueryData(['work-item', 'task-b'], { item: { id: 'task-b' } });

    invalidateRealtimeTopics(client, ['work-items']);
    expect(client.getQueryState(['work-item', 'task-a'])?.isInvalidated).toBe(false);
    expect(client.getQueryState(['work-item', 'task-b'])?.isInvalidated).toBe(false);

    invalidateRealtimeTopics(client, ['work-items'], new Set(), new Set(['task-a']));
    expect(client.getQueryState(['work-item', 'task-a'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['work-item', 'task-b'])?.isInvalidated).toBe(false);
  });

  it('keeps metadata-only conversation events away from message and task caches', () => {
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    invalidateRealtimeTopics(client, ['shared-metadata']);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['shared-conversations'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['conversation-unread-count'] });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['shared-messages'] });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['work-item'] });
  });

  it('requests one socket resync only when replay cannot cover a reconnect gap', () => {
    vi.useFakeTimers();
    installSocket();
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    function RealtimeClient() { useRealtimeNotifications(() => undefined); return null; }
    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    ready(MockWebSocket.instances[0], false);
    expect(invalidateQueries).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['work-items'] });
    rendered.unmount();
  });

  it('batches socket events and delivers notifications without polling', () => {
    vi.useFakeTimers();
    installSocket();
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    const notify = vi.fn();
    function RealtimeClient() { useRealtimeNotifications(notify); return null; }
    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    const socket = MockWebSocket.instances[0];
    ready(socket);
    socket.receive({ type: 'event', protocol: REALTIME_PROTOCOL_VERSION, sequence: 1, event: { kind: 'invalidate', topics: ['work-items', 'shared-messages'], conversationId: 'c1' } });
    socket.receive({ type: 'event', protocol: REALTIME_PROTOCOL_VERSION, sequence: 2, event: { kind: 'notification', tone: 'success', message: 'Agent finished' } });
    expect(invalidateQueries).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['work-items'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['shared-messages', 'c1'] });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', message: 'Agent finished' }));
    rendered.unmount();
  });

  it('reports handshake-backed connection state and treats browser offline as a hint', () => {
    installSocket();
    const client = new QueryClient();
    const snapshots: Array<{ state: string; browserOffline: boolean }> = [];
    function RealtimeClient() {
      const { state, browserOffline } = useRealtimeNotifications(() => undefined);
      snapshots.push({ state, browserOffline });
      return null;
    }
    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    expect(snapshots.at(-1)?.state).toBe('connecting');
    act(() => ready(MockWebSocket.instances[0]));
    expect(snapshots.at(-1)?.state).toBe('connected');
    act(() => window.dispatchEvent(new Event('offline')));
    expect(snapshots.at(-1)).toEqual({ state: 'connected', browserOffline: true });
    act(() => MockWebSocket.instances[0].close());
    expect(snapshots.at(-1)?.state).toBe('reconnecting');
    rendered.unmount();
  });
});
