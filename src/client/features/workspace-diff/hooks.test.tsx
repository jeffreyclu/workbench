// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceDiff, workspaceExplorerQueryKey } from './hooks.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const diffFor = (workspacePath: string) => ({
  workspacePath, branch: 'review', revision: `rev:${workspacePath}`, changedFiles: 0, additions: 0, deletions: 0,
  publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [],
});

/** One server, answering from whichever repository Repo Explorer has selected —
 * exactly what the real endpoints do, since the selection never appears in the
 * request. */
function stubWorkbench(initialPath: string) {
  let selectedPath = initialPath;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/workspaces')) return json({ selectedPath, workspaces: [{ path: selectedPath, label: 'repo', selected: true }] });
    return json({ diff: diffFor(selectedPath) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, select: (path: string) => { selectedPath = path; }, diffCalls: () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/workspace-diff')).length };
}

describe('useWorkspaceDiff', () => {
  const wrapperFor = (client: QueryClient) => ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  it('refreshes when the review surface is reopened so it cannot retain a clean prior worktree', async () => {
    const { diffCalls } = stubWorkbench('/tmp/workbench');
    const wrapper = wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    const first = renderHook(() => useWorkspaceDiff({ workItemId: 'work-item-1' }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useWorkspaceDiff({ workItemId: 'work-item-1' }), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(diffCalls()).toBe(2);
  });

  it('never shows the previous repository once Repo Explorer selects another one', async () => {
    const scope = { workItemId: 'work-item-1' };
    let selectedPath = '/tmp/repo-a';
    // The second repository's diff never arrives. What is on screen while it is
    // in flight is the whole question: the previous repository's changes must
    // not stand in for it.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/workspaces')) return json({ selectedPath, workspaces: [{ path: selectedPath, label: 'repo', selected: true }] });
      if (selectedPath === '/tmp/repo-b') return new Promise<Response>(() => {});
      return json({ diff: diffFor(selectedPath) });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useWorkspaceDiff(scope), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.data?.diff.workspacePath).toBe('/tmp/repo-a'));

    selectedPath = '/tmp/repo-b';
    await act(async () => { await client.invalidateQueries({ queryKey: workspaceExplorerQueryKey(scope) }); });

    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(result.current.isLoading).toBe(true);
  });
});
