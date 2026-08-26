// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceDiff } from './hooks.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useWorkspaceDiff', () => {
  it('does not refetch a running workspace while the diff is being reviewed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      diff: { workspacePath: '/tmp/workbench', branch: 'review', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [] },
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    const { result } = renderHook(() => useWorkspaceDiff('work-item-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
