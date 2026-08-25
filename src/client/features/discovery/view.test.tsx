import '@testing-library/jest-dom/vitest';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryInbox } from '../../../shared/contracts';
import { DiscoveryInboxView } from './view';

const candidateId = '00000000-0000-4000-8000-000000000001';
const inbox: DiscoveryInbox = {
  candidates: [{
    id: candidateId,
    provider: 'github',
    title: 'Failed bulk review',
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
  }],
  pendingCount: 1,
  reviewedCount: 0,
  lastRun: null,
  running: false,
  queueProposal: null,
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DiscoveryInboxView bulk review failures', () => {
  it.each([
    ['Tomorrow', 'snooze'],
    ['Dismiss', 'dismiss'],
    ['Add / update', 'convert'],
  ])('renders an error when bulk %s fails', async (buttonName, action) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/discovery/bulk' && init?.method === 'POST') {
        expect(init.body).toBe(JSON.stringify({ ids: [candidateId], action }));
        return new Response(JSON.stringify({ error: 'Bulk review failed.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('/api/discovery?view=pending')) return new Response(JSON.stringify(inbox), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><DiscoveryInboxView onOpenTask={vi.fn()} onOpenStack={vi.fn()} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('checkbox', { name: /github/i }));
    fireEvent.click(within(container.querySelector('.discovery-bulkbar')!).getByRole('button', { name: buttonName }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not complete bulk review: Bulk review failed.');
    expect(screen.getByRole('checkbox', { name: /github/i })).toBeChecked();
  });
});
