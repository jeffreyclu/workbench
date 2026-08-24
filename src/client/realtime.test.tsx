// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateRealtimeTopics, realtimeUrl, useRealtimeNotifications } from './realtime';

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
  vi.unstubAllGlobals();
});

describe('realtime invalidation', () => {
  it('uses a secure socket for secure pages', () => {
    expect(realtimeUrl({ protocol: 'https:', host: 'workbench.example' })).toBe('wss://workbench.example/api/realtime');
    expect(realtimeUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/realtime');
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
});
