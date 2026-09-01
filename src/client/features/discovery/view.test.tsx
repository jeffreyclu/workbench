import '@testing-library/jest-dom/vitest';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryInbox } from '../../../shared/contracts';
import { Toaster } from '../../components/toast/toast';
import { toast } from '../../state/toast-store';
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

afterEach(() => { cleanup(); toast.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('DiscoveryInboxView inbox query failures', () => {
  it('shows an error with Retry and reloads the inbox', async () => {
    let inboxRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/discovery?view=pending')) {
        inboxRequests += 1;
        if (inboxRequests === 1) return new Response(JSON.stringify({ error: 'Discovery service unavailable.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify(inbox), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DiscoveryInboxView onOpenTask={vi.fn()} onOpenStack={vi.fn()} /></QueryClientProvider>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load discoveries. Check your network and try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(inbox.candidates[0].title)).toBeInTheDocument();
    expect(inboxRequests).toBe(2);
  });
});

describe('DiscoveryInboxView bulk review failures', () => {
  it('exposes the Pending and Reviewed views as linked tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/discovery?view=')) return new Response(JSON.stringify(inbox), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DiscoveryInboxView onOpenTask={vi.fn()} onOpenStack={vi.fn()} /></QueryClientProvider>);

    const tablist = await screen.findByRole('tablist', { name: 'Discovery view' });
    const pending = within(tablist).getByRole('tab', { name: /pending/i });
    const reviewed = within(tablist).getByRole('tab', { name: /reviewed/i });
    expect(pending).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(reviewed);
    expect(reviewed).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', reviewed.id);
  });

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

describe('DiscoveryInboxView undo', () => {
  it.each([
    ['Tomorrow', 'snooze', 'Snoozed until tomorrow.'],
    ['Dismiss', 'dismiss', 'Discovery dismissed.'],
    ['Add to stack', 'convert', 'Added to stack.'],
  ])('offers Undo after %s and restores the same card', async (buttonName, action, message) => {
    const successToast = vi.spyOn(toast, 'success');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/discovery/${candidateId}/${action}` && init?.method === 'POST') return new Response(JSON.stringify({ candidate: { ...inbox.candidates[0], status: action } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/discovery/${candidateId}/restore` && init?.method === 'POST') return new Response(JSON.stringify({ candidate: { ...inbox.candidates[0], status: 'pending' } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/discovery?view=pending')) return new Response(JSON.stringify(inbox), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DiscoveryInboxView onOpenTask={vi.fn()} onOpenStack={vi.fn()} /><Toaster /></QueryClientProvider>);

    const card = (await screen.findByText(inbox.candidates[0].title)).closest<HTMLElement>('.discovery-card');
    expect(card).not.toBeNull();
    fireEvent.click(within(card!).getByRole('button', { name: buttonName }));
    const undo = await screen.findByRole('button', { name: `Undo: ${message}` });
    expect(successToast).toHaveBeenCalledWith(message, expect.objectContaining({ actionLabel: 'Undo', duration: 5_000 }));
    fireEvent.click(undo);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/discovery/${candidateId}/restore`, expect.objectContaining({ method: 'POST' })));
  });
});

describe('DiscoveryInboxView restore', () => {
  it('shows restoring only on the selected card and announces completion', async () => {
    const secondCandidateId = '00000000-0000-4000-8000-000000000002';
    const reviewedInbox: DiscoveryInbox = {
      ...inbox,
      candidates: [
        { ...inbox.candidates[0], status: 'dismissed', title: 'First reviewed discovery' },
        { ...inbox.candidates[0], id: secondCandidateId, status: 'snoozed', title: 'Second reviewed discovery' },
      ],
      pendingCount: 0,
      reviewedCount: 2,
    };
    let completeRestore: (() => void) | undefined;
    const restoreRequest = new Promise<Response>((resolve) => { completeRestore = () => resolve(new Response(JSON.stringify({ candidate: reviewedInbox.candidates[0] }), { headers: { 'Content-Type': 'application/json' } })); });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/discovery/${candidateId}/restore` && init?.method === 'POST') return restoreRequest;
      if (url.startsWith('/api/discovery?view=pending')) return new Response(JSON.stringify(inbox), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/discovery?view=reviewed')) return new Response(JSON.stringify(reviewedInbox), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DiscoveryInboxView onOpenTask={vi.fn()} onOpenStack={vi.fn()} /><Toaster /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('tab', { name: /reviewed/i }));
    const firstCard = (await screen.findByText('First reviewed discovery')).closest<HTMLElement>('.discovery-card')!;
    const secondCard = screen.getByText('Second reviewed discovery').closest<HTMLElement>('.discovery-card')!;
    fireEvent.click(within(firstCard).getByRole('button', { name: 'Restore to inbox' }));

    expect(within(firstCard).getByRole('button', { name: 'Restoring…' })).toBeDisabled();
    expect(within(secondCard).getByRole('button', { name: 'Restore to inbox' })).toBeEnabled();

    completeRestore!();
    const notifications = await screen.findByRole('list', { name: 'Notifications' });
    expect(notifications).toHaveAttribute('aria-live', 'polite');
    expect(notifications).toHaveTextContent('Discovery restored to inbox.');
  });
});
