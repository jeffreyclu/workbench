// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { toast } from '../../state/toast-store';
import { WorkspaceDiffView } from './view.js';
import { getToasts } from '../../state/toast-store';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const publish = { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null };

const files: WorkspaceDiffFile[] = [
  { path: 'src/alpha.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1,3 +1,3 @@ alphaBehavior\n context-one\n-before\n+after' },
  { path: 'src/beta.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1, isBinary: false, patch: '@@ -5,2 +5,2 @@ betaBehavior\n context-two\n-old\n+rareToken = true\n@@ -40,1 +40,2 @@ betaTail\n tail-context\n+tailAdded' },
];

function renderView() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
    if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
    if (url.endsWith('/workspace-diff')) return json({ diff: { workspacePath: '/tmp/workbench', branch: 'review', revision: 'permalink-revision', changedFiles: 2, additions: 3, deletions: 2, publish, files } });
    if (url.includes('/workspace-diff/file?')) {
      const lines = Array.from({ length: 45 }, (_, index) => `filler-${index + 1}`);
      lines[4] = 'context-two'; lines[5] = 'rareToken = true'; lines[39] = 'tail-context'; lines[40] = 'tailAdded';
      return json({ file: { path: 'src/beta.ts', revision: null, content: lines.join('\n'), unavailable: null } });
    }
    if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  toast.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView permalinks', () => {
  it('copies a URL for a line that names the file and line, and opening it lands on that line', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    window.history.replaceState(null, '', '/tasks/work-item-1?tab=changes');
    renderView();
    await screen.findByLabelText('Full diff for src/alpha.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link to line 2' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const url = new URL((writeText.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname + url.search).toBe('/tasks/work-item-1?tab=changes');
    expect(url.hash).toBe('#diff=src%2Falpha.ts&hunk=1%2C1&line=n2');
    expect(getToasts().map((entry) => entry.message)).toContain('Link copied');

    // A fresh session at that URL: the decision is a different file than the
    // default selection, and the named line is the one highlighted.
    cleanup();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/tasks/work-item-1#diff=src%2Fbeta.ts&hunk=40%2C40&line=n41');
    renderView();
    const beta = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(beta.querySelector('.diff-line.search-hit')).toHaveTextContent('tailAdded'));
    expect(screen.queryByLabelText('Full diff for src/alpha.ts')).not.toBeInTheDocument();
  });

  it('lands on a deleted line by its old number', async () => {
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&line=o6');
    renderView();
    const beta = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(beta.querySelector('.diff-line.search-hit')).toHaveTextContent('old'));
  });

  it('lands on the line in split reading as well', async () => {
    window.localStorage.setItem('workbench:review-stack-reading-mode', JSON.stringify({ readingMode: 'split' }));
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&line=n6');
    renderView();
    const beta = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(beta.querySelector('.diff-split-cell.search-hit')).toHaveTextContent('rareToken = true'));
  });

  it('lands on the line in final reading', async () => {
    window.localStorage.setItem('workbench:review-stack-reading-mode', JSON.stringify({ readingMode: 'final' }));
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&line=n6');
    renderView();
    const beta = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(beta.querySelector('.diff-line.final.search-hit')).toHaveTextContent('rareToken = true'));
  });

  it('lands on the line in whole-file reading, even one outside every change', async () => {
    window.localStorage.setItem('workbench:review-stack-reading-mode', JSON.stringify({ readingMode: 'file' }));
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&line=n41');
    const { container } = renderView();
    await waitFor(() => expect(container.querySelector('.review-full-file-row.linked')).toHaveAttribute('data-line', '41'));
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&line=n20');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(container.querySelector('.review-full-file-row.linked')).toHaveAttribute('data-line', '20'));
  });

  it('opens the unified diff for a deleted line, which final reading folds away', async () => {
    window.localStorage.setItem('workbench:review-stack-reading-mode', JSON.stringify({ readingMode: 'final' }));
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&line=o6');
    renderView();
    const beta = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(beta.querySelector('.diff-line.deletion.search-hit')).toHaveTextContent('old'));
  });

  it('tells the reader when the linked file is not in this diff', async () => {
    window.history.replaceState(null, '', '/#diff=src%2Fgone.ts');
    renderView();
    await screen.findByLabelText('Full diff for src/alpha.ts');
    await waitFor(() => expect(getToasts().map((entry) => entry.message)).toContain('That link points at a file that is not in this diff.'));
  });

  it('follows a link pasted into the open tab', async () => {
    renderView();
    await screen.findByLabelText('Full diff for src/alpha.ts');
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&line=n6');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const beta = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(beta.querySelector('.diff-line.search-hit')).toHaveTextContent('rareToken = true'));
  });
});

describe('WorkspaceDiffView collapse and expand', () => {
  it('folds every other change from the all-files control and remembers it in the diff preferences', async () => {
    renderView();
    const alpha = await screen.findByLabelText('Full diff for src/alpha.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(JSON.parse(window.localStorage.getItem('workbench:review-stack-reading-mode')!).collapsedFiles).toEqual(['src/alpha.ts', 'src/beta.ts']);
    // The selected change stays open under the reader's cursor.
    expect(alpha.querySelector('.diff-line')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(JSON.parse(window.localStorage.getItem('workbench:review-stack-reading-mode')!).collapsedFiles).toEqual([]);
  });

  it('toggles one file and keeps other files as they were', async () => {
    renderView();
    await screen.findByLabelText('Full diff for src/alpha.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse hunks' }));
    expect(JSON.parse(window.localStorage.getItem('workbench:review-stack-reading-mode')!).collapsedFiles).toEqual(['src/alpha.ts']);
    fireEvent.click(screen.getByRole('button', { name: 'Expand hunks' }));
    expect(JSON.parse(window.localStorage.getItem('workbench:review-stack-reading-mode')!).collapsedFiles).toEqual([]);
  });

  it('opens a collapsed file folded after a reload', async () => {
    window.localStorage.setItem('workbench:review-stack-reading-mode', JSON.stringify({ readingMode: 'diff', collapsedFiles: ['src/beta.ts'] }));
    window.history.replaceState(null, '', '/#diff=src%2Fbeta.ts&hunk=5%2C5');
    renderView();
    const beta = await screen.findByLabelText('Full diff for src/beta.ts');
    // The linked change is the selected one, so it is open; its sibling hunk is folded.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Expand hunks' })).toBeInTheDocument());
    expect(beta.querySelectorAll('.diff-review-diff-block')).toHaveLength(2);
  });
});
