// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { WorkspaceDiffView } from './view.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const publish = { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null };

const files: WorkspaceDiffFile[] = [
  { path: 'src/alpha.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1,3 +1,3 @@ alphaBehavior\n context-one\n-before\n+after' },
  { path: 'src/beta.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -5,3 +5,3 @@ betaBehavior\n context-two\n-old\n+rareToken = true' },
];

function renderView() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
    if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
    if (url.endsWith('/workspace-diff')) return json({ diff: { workspacePath: '/tmp/workbench', branch: 'review', revision: 'search-revision', changedFiles: 2, additions: 2, deletions: 2, publish, files } });
    if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView find in diff', () => {
  it('searches text in a file that is not on screen and jumps to the matching line', async () => {
    renderView();
    // Only the selected decision's file is drawn, so the browser's own find could not see the other one.
    await screen.findByLabelText('Full diff for src/alpha.ts');
    expect(screen.queryByLabelText('Full diff for src/beta.ts')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'f', metaKey: true });
    const box = await screen.findByRole('searchbox', { name: 'Find in diff' });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: 'raretoken' } });

    const results = await screen.findByRole('list', { name: 'Matching lines' });
    const result = within(results).getByRole('button', { name: /src\/beta\.ts:6/ });
    fireEvent.click(result);

    const betaPane = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(betaPane.querySelector('.diff-line.search-hit')).toHaveTextContent('rareToken = true'));
    expect(result).toHaveAttribute('aria-current', 'true');
  });

  it('reports no matches, steps with Enter, and drops the highlight on Escape', async () => {
    renderView();
    await screen.findByLabelText('Full diff for src/alpha.ts');
    fireEvent.click(screen.getByRole('button', { name: /Find in diff/ }));
    const box = await screen.findByRole('searchbox', { name: 'Find in diff' });

    fireEvent.change(box, { target: { value: 'zzzz' } });
    await waitFor(() => expect(screen.getByText('No matches')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();

    fireEvent.change(box, { target: { value: 'context' } });
    await screen.findByText('2 matches');
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('1 of 2');
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('2 of 2');
    await waitFor(() => expect(screen.getByLabelText('Full diff for src/beta.ts').querySelector('.diff-line.search-hit')).toHaveTextContent('context-two'));

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(document.querySelector('.diff-line.search-hit')).toBeNull();
  });
});
