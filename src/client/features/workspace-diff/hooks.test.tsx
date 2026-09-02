// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceDiff } from './hooks.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const diffFor = (workspacePath: string) => ({
  workspacePath,
  branch: 'review',
  revision: `rev:${workspacePath}`,
  changedFiles: 0,
  additions: 0,
  deletions: 0,
  publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: false, reason: null },
  files: [],
});

describe('useWorkspaceDiff', () => {
  const wrapperFor = (client: QueryClient) => ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  it('puts the selected workspace in the request and keeps an open document stable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://workbench.test');
      return json({ diff: diffFor(url.searchParams.get('workspacePath') ?? '') });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    const first = renderHook(() => useWorkspaceDiff({ workItemId: 'work-item-1' }, '/tmp/repo-a'), { wrapper });
    await waitFor(() => expect(first.result.current.data?.diff.workspacePath).toBe('/tmp/repo-a'));
    first.unmount();

    const second = renderHook(() => useWorkspaceDiff({ workItemId: 'work-item-1' }, '/tmp/repo-a'), { wrapper });
    await waitFor(() => expect(second.result.current.data?.diff.workspacePath).toBe('/tmp/repo-a'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('workspacePath=%2Ftmp%2Frepo-a');
  });

  it('never shows the previous repository while the selected repository is loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://workbench.test');
      const workspacePath = url.searchParams.get('workspacePath') ?? '';
      if (workspacePath === '/tmp/repo-b') return new Promise<Response>(() => {});
      return json({ diff: diffFor(workspacePath) });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ workspacePath }) => useWorkspaceDiff({ workItemId: 'work-item-1' }, workspacePath),
      { initialProps: { workspacePath: '/tmp/repo-a' }, wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.data?.diff.workspacePath).toBe('/tmp/repo-a'));

    rerender({ workspacePath: '/tmp/repo-b' });

    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(result.current.isLoading).toBe(true);
  });

  it('ignores a late response from the repository that was left', async () => {
    let resolveRepositoryA: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://workbench.test');
      const workspacePath = url.searchParams.get('workspacePath') ?? '';
      if (workspacePath === '/tmp/repo-a') return new Promise<Response>((resolve) => { resolveRepositoryA = resolve; });
      return json({ diff: diffFor(workspacePath) });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ workspacePath }) => useWorkspaceDiff({ workItemId: 'work-item-1' }, workspacePath),
      { initialProps: { workspacePath: '/tmp/repo-a' }, wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(resolveRepositoryA).not.toBeNull());
    rerender({ workspacePath: '/tmp/repo-b' });
    await waitFor(() => expect(result.current.data?.diff.workspacePath).toBe('/tmp/repo-b'));

    await act(async () => { resolveRepositoryA?.(json({ diff: diffFor('/tmp/repo-a') })); });
    expect(result.current.data?.diff.workspacePath).toBe('/tmp/repo-b');
  });
});
