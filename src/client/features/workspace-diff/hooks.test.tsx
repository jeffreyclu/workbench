// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceDiff } from './hooks.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useWorkspaceDiff', () => {
  it('refreshes when the review surface is reopened so it cannot retain a clean prior worktree', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      diff: { workspacePath: '/tmp/workbench', branch: 'review', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [] },
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    const first = renderHook(() => useWorkspaceDiff({ workItemId: 'work-item-1' }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useWorkspaceDiff({ workItemId: 'work-item-1' }), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
