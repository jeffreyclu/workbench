// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchQueryClient, workbenchQueryDefaults } from './query-client.js';

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    if (!['.ts', '.tsx'].includes(extname(path)) || /\.test\.[^.]+$/.test(path)) return [];
    return [path];
  });
}

describe('Workbench query cache policy', () => {
  it('retains successful REST reads across unmounts for the browser session', async () => {
    const queryFn = vi.fn(async () => ({ title: 'Cached task' }));
    const client = createWorkbenchQueryClient({
      queries: { ...workbenchQueryDefaults.queries, retry: false },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    const first = renderHook(() => useQuery({ queryKey: ['work-item', 'task-1'], queryFn }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useQuery({ queryKey: ['work-item', 'other-task'], queryFn }), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    second.unmount();

    const reopened = renderHook(() => useQuery({ queryKey: ['work-item', 'task-1'], queryFn }), { wrapper });
    await waitFor(() => expect(reopened.result.current.data?.title).toBe('Cached task'));
    expect(queryFn).toHaveBeenCalledTimes(2);

    reopened.unmount();
    await client.invalidateQueries({ queryKey: ['work-item', 'task-1'], exact: true });
    const invalidated = renderHook(() => useQuery({ queryKey: ['work-item', 'task-1'], queryFn }), { wrapper });
    await waitFor(() => expect(invalidated.result.current.isFetching).toBe(false));
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('forbids route-local timers and remount/focus refetch overrides', () => {
    const violations = productionFiles(join(process.cwd(), 'src/client'))
      .flatMap((path) => readFileSync(path, 'utf8').split('\n').map((line, index) => ({ path, line, index: index + 1 })))
      .filter(({ path, line }) => path !== join(process.cwd(), 'src/client/app/query-client.ts') && (
        (/\bstaleTime\s*:/.test(line) && !line.includes('Infinity'))
        || /\bgcTime\s*:/.test(line)
        || /\bcacheTime\s*:/.test(line)
        || /\brefetchOnMount\s*:/.test(line)
        || /\brefetchOnWindowFocus\s*:/.test(line)
        || /\brefetchOnReconnect\s*:/.test(line)
      ));

    expect(violations.map(({ path, index, line }) => `${path}:${index}: ${line.trim()}`)).toEqual([]);
  });
});
