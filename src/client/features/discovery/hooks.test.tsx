// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryCandidate, DiscoveryInbox } from '../../../shared/contracts';
import { getToasts, toast } from '../../state/toast-store';
import { useDiscoveryCard, useDiscoveryInbox } from './hooks';

const candidateA = '00000000-0000-4000-8000-000000000001';
const candidateB = '00000000-0000-4000-8000-000000000002';

function makeCandidate(id: string, title: string): DiscoveryCandidate {
  return {
    id,
    provider: 'github',
    title,
    description: '',
    sourceUrl: null,
    occurredAt: null,
    status: 'pending',
    discoveredAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    snoozedUntil: null,
    workItemId: null,
    relevance: 1,
    suggestedWorkItemId: null,
  };
}

const inbox: DiscoveryInbox = {
  candidates: [makeCandidate(candidateA, 'First discovery'), makeCandidate(candidateB, 'Second discovery')],
  pendingCount: 2,
  reviewedCount: 0,
  lastRun: null,
  running: false,
  queueProposal: null,
};

const workItemsPage = { items: [], nextCursor: null, totalCount: 0, proposal: null };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  act(() => toast.clear());
  vi.unstubAllGlobals();
});

describe('useDiscoveryInbox error surfacing', () => {
  it('toasts when the scan fails to start', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/discovery/scan' && init?.method === 'POST') return jsonResponse({ error: 'Scan already running.' }, 500);
      if (url.startsWith('/api/discovery?view=pending')) return jsonResponse(inbox);
      if (url.startsWith('/api/work-items?')) return jsonResponse(workItemsPage);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDiscoveryInbox(), { wrapper: wrapper(client) });

    await act(async () => { await result.current.scan.mutateAsync().catch(() => {}); });

    expect(getToasts().map((entry) => entry.message)).toContain('Could not start the discovery scan.');
    expect(getToasts().find((entry) => entry.message === 'Could not start the discovery scan.')?.description).toBe('Scan already running.');
  });

  it.each([
    ['convert', 'Could not add "First discovery".'],
    ['dismiss', 'Could not dismiss "First discovery".'],
    ['snooze', 'Could not snooze "First discovery".'],
  ] as const)('toasts when resolving a single candidate via %s fails', async (action, expectedMessage) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/discovery/${candidateA}/${action}`) return jsonResponse({ error: 'Candidate already resolved.' }, 409);
      if (url.startsWith('/api/discovery?view=pending')) return jsonResponse(inbox);
      if (url.startsWith('/api/work-items?')) return jsonResponse(workItemsPage);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDiscoveryInbox(), { wrapper: wrapper(client) });

    await act(async () => { await result.current.resolveCandidate.mutateAsync({ candidate: inbox.candidates[0], action }).catch(() => {}); });

    expect(getToasts().map((entry) => entry.message)).toContain(expectedMessage);
  });

  it('keeps unresolved candidates selected and reports the split when a bulk action partially succeeds', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/discovery/bulk' && init?.method === 'POST') {
        // Candidate B silently fails to resolve server-side; only A comes back.
        return jsonResponse({ candidates: [inbox.candidates[0]] });
      }
      if (url.startsWith('/api/discovery?view=pending')) return jsonResponse(inbox);
      if (url.startsWith('/api/work-items?')) return jsonResponse(workItemsPage);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDiscoveryInbox(), { wrapper: wrapper(client) });

    act(() => result.current.setSelected(new Set([candidateA, candidateB])));
    await act(async () => { await result.current.bulkResolve.mutateAsync('dismiss').catch(() => {}); });

    expect(result.current.selected).toEqual(new Set([candidateB]));
    expect(getToasts().map((entry) => entry.message)).toContain('1 of 2 discoveries dismissed; 1 could not be resolved and stay selected.');
  });

  it('leaves the selection untouched and toasts when the whole bulk request fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/discovery/bulk' && init?.method === 'POST') return jsonResponse({ error: 'Bulk review failed.' }, 500);
      if (url.startsWith('/api/discovery?view=pending')) return jsonResponse(inbox);
      if (url.startsWith('/api/work-items?')) return jsonResponse(workItemsPage);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDiscoveryInbox(), { wrapper: wrapper(client) });

    act(() => result.current.setSelected(new Set([candidateA, candidateB])));
    await act(async () => { await result.current.bulkResolve.mutateAsync('convert').catch(() => {}); });

    expect(result.current.selected).toEqual(new Set([candidateA, candidateB]));
    expect(getToasts().map((entry) => entry.message)).toContain('Could not complete the bulk review action; the selection was left unchanged.');
  });

  it('toasts when restoring a discovery fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/discovery/${candidateA}/restore`) return jsonResponse({ error: 'Already pending.' }, 409);
      if (url.startsWith('/api/discovery?view=pending')) return jsonResponse(inbox);
      if (url.startsWith('/api/work-items?')) return jsonResponse(workItemsPage);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDiscoveryInbox(), { wrapper: wrapper(client) });

    await act(async () => { await result.current.restore.mutateAsync(candidateA).catch(() => {}); });

    expect(getToasts().map((entry) => entry.message)).toContain('Could not restore this discovery.');
  });

  it('toasts when merging a discovery into a task fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/discovery/${candidateA}/merge`) return jsonResponse({ error: 'Task no longer exists.' }, 404);
      if (url.startsWith('/api/discovery?view=pending')) return jsonResponse(inbox);
      if (url.startsWith('/api/work-items?')) return jsonResponse(workItemsPage);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDiscoveryInbox(), { wrapper: wrapper(client) });

    await act(async () => { await result.current.resolveMerge.mutateAsync({ id: candidateA, workItemId: 'work-item-1' }).catch(() => {}); });

    await waitFor(() => expect(getToasts().map((entry) => entry.message)).toContain('Could not merge this discovery into the task.'));
  });
});

describe('useDiscoveryCard error surfacing', () => {
  it('toasts when saving edits to a discovery fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/discovery/${candidateA}` && init?.method === 'PATCH') return jsonResponse({ error: 'Discovery already resolved.' }, 409);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDiscoveryCard(inbox.candidates[0]), { wrapper: wrapper(client) });

    act(() => result.current.setEditing(true));
    await act(async () => { await result.current.update.mutateAsync().catch(() => {}); });

    expect(getToasts().map((entry) => entry.message)).toContain('Could not save changes to this discovery.');
    expect(result.current.editing).toBe(true);
  });
});
