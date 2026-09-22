// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchQueryClient, workbenchQueryDefaults } from '../../app/query-client.js';
import { useTaskDetail } from './hooks.js';

afterEach(() => vi.unstubAllGlobals());

describe('useTaskDetail', () => {
  it('does not repeat its REST read when returning to the same idle task', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      item: { id: String(input).split('/').at(-1), title: 'Cached task' },
      activity: [], runs: [], conversations: [], children: [], artifacts: [], references: [],
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createWorkbenchQueryClient({ queries: { ...workbenchQueryDefaults.queries, retry: false } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    const first = renderHook(() => useTaskDetail('task-1'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    const second = renderHook(() => useTaskDetail('task-2'), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    second.unmount();
    const reopened = renderHook(() => useTaskDetail('task-1'), { wrapper });
    await waitFor(() => expect(reopened.result.current.data?.item.title).toBe('Cached task'));

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/task-1'))).toHaveLength(1);
  });
});
