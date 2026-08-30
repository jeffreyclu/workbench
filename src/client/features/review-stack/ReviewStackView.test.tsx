// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { ReviewStackView } from './ReviewStackView.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const AUTH_PATCH = [
  '@@ -20,4 +20,6 @@ export function authorize(request) {',
  ' export function authorize(request) {',
  '-  if (!request.token) return false;',
  '+  if (!request.token) return request.internal === true;',
  '+  if (request.token === "*") return true;',
  '   return verify(request.token);',
  ' }',
].join('\n');

const IMPORT_PATCH = [
  '@@ -1,2 +1,3 @@',
  ' import { a } from "./a.js";',
  '+import { c } from "./c.js";',
  ' export const x = 1;',
].join('\n');

function file(path: string, patch: string): WorkspaceDiffFile {
  return { path, status: 'modified', additions: 2, deletions: 1, previousPath: null, patch, isBinary: false, editorUrl: null };
}

const diff = {
  workspacePath: '/tmp/workbench', branch: 'review', revision: 'rev-1', changedFiles: 2, additions: 4, deletions: 2,
  publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
  files: [file('src/server/auth.ts', AUTH_PATCH), file('src/app.ts', IMPORT_PATCH)],
};

function renderReview() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/workspace-diff/snapshots')) return json({ snapshots: [] });
    if (url.includes('/workspace-diff/block-reviews')) return init?.method === 'PUT'
      ? json({ review: { id: 'r1', revision: 'rev-1', filePath: 'src/server/auth.ts', blockRange: '@@', contentHash: 'h', state: 'reviewed', note: null, updatedAt: '2026-01-01' } })
      : json({ reviews: [] });
    if (url.includes('/review-assist/lookup')) return json({ answer: null });
    if (url.includes('/workspace-diff')) return json({ diff });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ReviewStackView scope={{ workItemId: 'work-item-1' }} /></QueryClientProvider>);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReviewStackView', () => {
  it('leads with the block that deserves attention and collapses what proof settled', async () => {
    renderReview();
    const queue = await screen.findByRole('navigation', { name: 'Review queue' });
    const rows = await waitFor(() => {
      const found = within(queue).queryAllByRole('button');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // The auth change is routed to the top tier; the import-only block is
    // settled by proof and lives behind the disclosure instead of the queue.
    expect(rows[0]).toHaveTextContent('T3');
    expect(rows[0]).toHaveTextContent('authorize');
    expect(await screen.findByRole('button', { name: /settled automatically/ })).toBeInTheDocument();
  });

  it('states what is still owed rather than only what is done', async () => {
    renderReview();
    expect(await screen.findByRole('status')).toHaveTextContent(/1 to judge · 1 settled automatically/);
  });

  it('records a verdict against the block, not the hunk', async () => {
    const calls = renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /Reviewed/ }));
    await waitFor(() => {
      const write = calls.find((call) => call.method === 'PUT');
      expect(write?.url).toContain('/workspace-diff/block-reviews');
      expect(write?.url).not.toContain('hunk-reviews');
      expect(write?.body).toMatchObject({ filePath: 'src/server/auth.ts', state: 'reviewed', revision: 'rev-1' });
      expect((write?.body as { contentHash: string }).contentHash).toBeTruthy();
    });
  });
});
