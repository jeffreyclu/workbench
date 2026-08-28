// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConversationChangesAvailability, useOpenChangesAfterCompletedRun } from './hooks.js';

afterEach(() => vi.unstubAllGlobals());

describe('useConversationChangesAvailability', () => {
  it('distinguishes a diff fetch failure from a zero-change result and retries it', async () => {
    let diffAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspace-diff/snapshots')) return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/workspace-diff')) {
        diffAttempts += 1;
        if (diffAttempts === 1) throw new Error('Network unavailable');
        return new Response(JSON.stringify({ diff: { workspacePath: '/tmp/workbench', branch: 'review', revision: 'retry', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [] } }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useConversationChangesAvailability({ workItemId: 'work-item-1' }, [], false), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.hasChanges).toBe(false);
    await result.current.retry();
    await waitFor(() => expect(result.current.isError).toBe(false));
    expect(result.current.hasChanges).toBe(false);
    expect(diffAttempts).toBe(2);
  });

  it('enables Changes when any linked pull request has files to review', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspace-diff/snapshots')) return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/workspace-diff')) return new Response(JSON.stringify({ diff: { workspacePath: '/tmp/workbench', branch: 'review', revision: 'empty', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [] } }), { headers: { 'Content-Type': 'application/json' } });
      const pullRequest = new URL(url, 'http://localhost').searchParams.get('url')?.match(/pull\/(\d+)/)?.[1];
      if (pullRequest) return new Response(JSON.stringify({ diff: { changedFiles: pullRequest === '43' ? 1 : 0 } }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useConversationChangesAvailability({ workItemId: 'work-item-1' }, ['https://github.com/writer/workbench/pull/42', 'https://github.com/writer/workbench/pull/43'], false), { wrapper });

    await waitFor(() => expect(result.current.hasChanges).toBe(true));
    expect(result.current.isError).toBe(false);
  });
});

describe('useOpenChangesAfterCompletedRun', () => {
  it('opens the inline review only when the completed refresh has a diff', () => {
    const onOpen = vi.fn();
    const { rerender } = renderHook(({ completedRunRefresh, hasChanges }) => useOpenChangesAfterCompletedRun(completedRunRefresh, hasChanges, onOpen), {
      initialProps: { completedRunRefresh: 0, hasChanges: false },
    });

    rerender({ completedRunRefresh: 1, hasChanges: true });
    expect(onOpen).toHaveBeenCalledTimes(1);

    rerender({ completedRunRefresh: 2, hasChanges: false });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
