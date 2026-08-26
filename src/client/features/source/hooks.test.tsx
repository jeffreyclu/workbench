// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSourceConnections } from './hooks.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSourceConnections', () => {
  it('does not poll while the connections dialog remains open', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connections: [] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    const { result } = renderHook(() => useSourceConnections(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.isSuccess).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
