// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewsWorkspace } from './ReviewsWorkspace.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const createdReview = {
  id: 'review-1',
  title: 'acme/widgets #42',
  source: { kind: 'pull-request', url: 'https://github.com/acme/widgets/pull/42' },
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
};

function renderWorkspace() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let reviews: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/api/reviews/repositories/refs')) return json({ refs: { base: 'main', branches: [{ name: 'feature', ahead: 2 }], worktrees: [] } });
    if (url.includes('/api/reviews/repositories')) return json({ repositories: [{ path: '/repos/widgets', label: 'widgets' }] });
    if (url.endsWith('/api/reviews') && method === 'POST') {
      reviews = [createdReview];
      return json({ review: createdReview });
    }
    if (url.endsWith('/api/reviews')) return json({ reviews });
    if (url.includes('/workspace-diff/snapshots')) return json({ snapshots: [] });
    if (url.includes('/workspace-diff/block-reviews')) return json({ reviews: [] });
    if (url.includes('/workspace-diff')) return json({ diff: { workspacePath: '', branch: '', revision: 'pull-request', files: [], changedFiles: 0, additions: 0, deletions: 0, publish: { branch: null, hasOrigin: false, ahead: 0, hasChanges: false, reason: null } } });
    if (url.includes('/api/shared/conversations')) return json({ conversations: [], nextCursor: null });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ReviewsWorkspace /></QueryClientProvider>);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('ReviewsWorkspace', () => {
  it('starts a review from a pasted pull request link, with no conversation involved', async () => {
    const calls = renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: /new review/i }));
    fireEvent.change(screen.getByLabelText(/GitHub pull request link/i), { target: { value: 'https://github.com/acme/widgets/pull/42' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create review$/ }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/api/reviews') && call.method === 'POST')).toBe(true));
    const created = calls.find((call) => call.url.endsWith('/api/reviews') && call.method === 'POST')!;
    expect(created.body).toEqual({ pullRequestUrl: 'https://github.com/acme/widgets/pull/42' });

    // The new review opens straight away, scoped to itself rather than to a
    // conversation.
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/reviews/review-1/workspace-diff'))).toBe(true));
    expect(calls.some((call) => call.url.includes('/api/shared/conversations/') && call.url.includes('workspace-diff'))).toBe(false);
    // The pull request it was created from is the source it opens on.
    expect(JSON.parse(window.localStorage.getItem('workbench:review-stack-selections') ?? '{}')['review:review-1']?.source)
      .toBe('https://github.com/acme/widgets/pull/42');
  });

  it('refuses to create a review from a link that is not a pull request', async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /new review/i }));
    fireEvent.change(screen.getByLabelText(/GitHub pull request link/i), { target: { value: 'https://github.com/acme/widgets' } });

    expect(screen.getByText(/not a GitHub pull request link/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Create review$/ })).toBeDisabled();
  });

  it('offers this machine’s repositories and their branches as the other way in', async () => {
    const calls = renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /new review/i }));
    fireEvent.click(screen.getByRole('radio', { name: /repository/i }));

    const repositorySelect = await screen.findByLabelText(/^Repository$/);
    // The picker lists checkouts asynchronously; choosing before they land
    // would select nothing at all.
    await waitFor(() => expect(repositorySelect).toHaveTextContent('widgets'));
    fireEvent.change(repositorySelect, { target: { value: '/repos/widgets' } });
    const branchSelect = await screen.findByLabelText(/^Branch$/);
    await waitFor(() => expect(branchSelect).not.toBeDisabled());
    fireEvent.change(branchSelect, { target: { value: 'branch:feature' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create review$/ }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/api/reviews') && call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.url.endsWith('/api/reviews') && call.method === 'POST')!.body)
      .toEqual({ repositoryPath: '/repos/widgets', ref: 'branch:feature' });
  });
});
