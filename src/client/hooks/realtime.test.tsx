// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateRealtimeTopics, realtimeUrl, useRealtimeNotifications, type RealtimeConnection } from './realtime';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() { this.emit('close'); }
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
}

afterEach(() => {
  MockWebSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('realtime invalidation', () => {
  it('uses a secure socket for secure pages', () => {
    expect(realtimeUrl({ protocol: 'https:', host: 'workbench.example' })).toBe('wss://workbench.example/api/realtime');
    expect(realtimeUrl({ protocol: 'http:', host: 'localhost:5180' })).toBe('ws://localhost:5180/api/realtime');
  });

  it('maps topic invalidations to the existing query cache', () => {
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');

    invalidateRealtimeTopics(client, ['shared', 'runtime']);

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['shared-messages'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['runtime-preview-status'] });
  });

  it('invalidates active server data and delivers typed notifications from socket events', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    const notify = vi.fn();
    function RealtimeClient() { useRealtimeNotifications(notify); return null; }

    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toMatch(/\/api\/realtime$/);
    socket.emit('message', JSON.stringify({ type: 'invalidate', topics: ['work-items', 'discovery'] }));

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['work-items'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['discovery'] });
    socket.emit('message', JSON.stringify({ type: 'notification', tone: 'success', message: 'Agent finished', action: { label: 'Open conversation', route: '/conversations/123' } }));
    expect(notify).toHaveBeenCalledWith({ type: 'notification', tone: 'success', message: 'Agent finished', action: { label: 'Open conversation', route: '/conversations/123' } });
    rendered.unmount();
  });

  it('exposes reconnecting state while the socket is down so the UI can warn about stale cached data', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const client = new QueryClient();
    const states: string[] = [];
    const noop = () => {};
    function RealtimeClient() { states.push(useRealtimeNotifications(noop).state); return null; }

    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    expect(states.at(-1)).toBe('connecting');

    const socket = MockWebSocket.instances[0];
    act(() => { socket.emit('open'); });
    expect(states.at(-1)).toBe('connected');

    act(() => { socket.emit('close'); });
    expect(states.at(-1)).toBe('reconnecting');
    rendered.unmount();
  });

  it('falls back to HTTPS query polling after a bounded number of websocket failures', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries');
    const states: string[] = [];
    const noop = () => {};
    function RealtimeClient() { states.push(useRealtimeNotifications(noop).state); return null; }

    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      act(() => { MockWebSocket.instances.at(-1)?.emit('close'); });
      if (attempt < 3) act(() => { vi.advanceTimersByTime(30_000); });
    }

    expect(states.at(-1)).toBe('polling');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['shared-messages'] });
    const callsBeforePoll = invalidateQueries.mock.calls.length;
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(invalidateQueries.mock.calls.length).toBeGreaterThan(callsBeforePoll);

    const socketsBeforeProbe = MockWebSocket.instances.length;
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(MockWebSocket.instances).toHaveLength(socketsBeforeProbe + 1);
    act(() => { MockWebSocket.instances.at(-1)?.emit('open'); });
    expect(states.at(-1)).toBe('connected');

    const callsAfterRecovery = invalidateQueries.mock.calls.length;
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(invalidateQueries.mock.calls.length).toBe(callsAfterRecovery);
    rendered.unmount();
  });

  it('treats browser online/offline events as hints, not the authoritative connection state', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const client = new QueryClient();
    const snapshots: Array<{ state: string; browserOffline: boolean }> = [];
    const noop = () => {};
    function RealtimeClient() {
      const { state, browserOffline } = useRealtimeNotifications(noop);
      snapshots.push({ state, browserOffline });
      return null;
    }

    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    act(() => { MockWebSocket.instances[0].emit('open'); });
    expect(snapshots.at(-1)).toEqual({ state: 'connected', browserOffline: false });

    // The 'offline' hint surfaces immediately even though the socket hasn't closed yet.
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(snapshots.at(-1)).toEqual({ state: 'connected', browserOffline: true });

    // 'online' clears the hint but does not itself claim the socket is connected.
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(snapshots.at(-1)?.browserOffline).toBe(false);
    rendered.unmount();
  });

  it('retryNow cancels backoff and makes an immediate reconnection attempt', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const client = new QueryClient();
    const box: { current: RealtimeConnection | null } = { current: null };
    const noop = () => {};
    function RealtimeClient() { box.current = useRealtimeNotifications(noop); return null; }

    const rendered = render(<QueryClientProvider client={client}><RealtimeClient /></QueryClientProvider>);
    act(() => { MockWebSocket.instances[0].emit('close'); });
    expect(box.current?.state).toBe('reconnecting');

    const socketsBeforeRetry = MockWebSocket.instances.length;
    act(() => { box.current?.retryNow(); });
    expect(MockWebSocket.instances).toHaveLength(socketsBeforeRetry + 1);

    act(() => { MockWebSocket.instances.at(-1)?.emit('open'); });
    expect(box.current?.state).toBe('connected');
    rendered.unmount();
  });
});
