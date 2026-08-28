// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrokerConnection } from '../../../shared/contracts.js';
import { SOURCE_AUTHORIZATION_POLL_INTERVAL_MS, useManagedSourceAuthorization, useSourceConnections } from './hooks.js';

const pendingFigmaConnection: BrokerConnection = {
  id: 'figma',
  name: 'Figma',
  state: 'needs_auth',
  host: 'workbench',
  capabilities: ['resolve_links', 'search'],
  configurable: true,
  lastError: null,
  detail: 'Authorize Figma MCP to enable design context.',
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function advanceAuthorizationPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SOURCE_AUTHORIZATION_POLL_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSourceConnections', () => {
  it('does not poll while the connections dialog remains open', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connections: [] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSourceConnections(), { wrapper: queryWrapper() });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.isSuccess).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useManagedSourceAuthorization', () => {
  it('polls while waiting and reaches authorized when the server connection changes', async () => {
    vi.useFakeTimers();
    const connectedFigma = { ...pendingFigmaConnection, state: 'connected' as const };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ connections: [connectedFigma] }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useManagedSourceAuthorization(pendingFigmaConnection), { wrapper: queryWrapper() });

    act(() => result.current.startAuthorization('https://example.com/oauth'));
    expect(result.current.state.status).toBe('awaiting-auth');

    await advanceAuthorizationPoll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('authorized');
  });

  it('reports a failed check and lets a manual check recover', async () => {
    const connectedFigma = { ...pendingFigmaConnection, state: 'connected' as const };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network unavailable.'))
      .mockResolvedValueOnce(jsonResponse({ connections: [connectedFigma] }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useManagedSourceAuthorization(pendingFigmaConnection), { wrapper: queryWrapper() });

    act(() => result.current.startAuthorization('https://example.com/oauth'));
    await act(async () => { await result.current.checkAuthorization(); });
    expect(result.current.state).toMatchObject({ status: 'failed', error: 'Network unavailable.' });

    await act(async () => { await result.current.checkAuthorization(); });
    expect(result.current.state.status).toBe('authorized');
  });
});
