// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { WorkspaceDiffView } from '../workspace-diff/view.js';
import { storageKeyForScope, type ReviewNote } from './notes-logic.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const publish = { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null };
const files: WorkspaceDiffFile[] = [
  { path: 'src/alpha.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1,3 +1,3 @@ alphaBehavior\n context-one\n-before\n+after' },
  { path: 'src/beta.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -5,3 +5,3 @@ betaBehavior\n context-two\n-old\n+rareToken = true' },
];
const SCOPE_KEY = 'work-item:work-item-1';
const betaNote: ReviewNote = {
  id: 'note-1', body: 'Why is this always true?', resolved: false, createdAt: '2026-10-09T00:00:00.000Z',
  anchor: { filePath: 'src/beta.ts', hunkRange: '@@ -5,3 +5,3 @@ betaBehavior', startIndex: 2, endIndex: 2, excerpt: '+rareToken = true' },
};

// Newer Node ships its own `localStorage` global that shadows jsdom's and is
// undefined without a backing file, so the test supplies a plain in-memory one.
function installMemoryStorage() {
  const items = new Map<string, string>();
  const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  return storage;
}

function renderView() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
    if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
    if (url.endsWith('/workspace-diff')) return json({ diff: { workspacePath: '/tmp/workbench', branch: 'review', revision: 'notes-revision', changedFiles: 2, additions: 2, deletions: 2, publish, files } });
    if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);
}

beforeEach(installMemoryStorage);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('review notes in the diff view', () => {
  it('lists a stored draft by file and line, and jumps to the line in a file that is not on screen', async () => {
    window.localStorage.setItem(storageKeyForScope(SCOPE_KEY), JSON.stringify([betaNote]));
    renderView();
    await screen.findByLabelText('Full diff for src/alpha.ts');
    expect(screen.queryByLabelText('Full diff for src/beta.ts')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Notes \(1\)/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Review notes' });
    const section = within(drawer).getByRole('region', { name: 'Notes in src/beta.ts' });
    expect(within(section).getByText('Why is this always true?')).toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'Jump to src/beta.ts line 6' }));
    const betaPane = await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(betaPane.querySelector('.diff-line.search-hit')).toHaveTextContent('rareToken = true'));
  });

  it('keeps resolved state across a remount and marks a note whose code changed as outdated', async () => {
    window.localStorage.setItem(storageKeyForScope(SCOPE_KEY), JSON.stringify([betaNote, { ...betaNote, id: 'note-2', body: 'Stale', anchor: { ...betaNote.anchor, excerpt: '+gone' } }]));
    renderView();
    await screen.findByLabelText('Full diff for src/alpha.ts');
    fireEvent.click(screen.getByRole('button', { name: /^Notes/ }));
    const drawer = await screen.findByRole('complementary', { name: 'Review notes' });
    expect(within(drawer).getByText('Outdated')).toBeInTheDocument();

    fireEvent.click(within(drawer).getAllByRole('button', { name: /Resolve/ })[0]!);
    const stored = JSON.parse(window.localStorage.getItem(storageKeyForScope(SCOPE_KEY)) ?? '[]') as ReviewNote[];
    expect(stored.find((note) => note.id === 'note-1')?.resolved).toBe(true);
    expect(within(drawer).getByRole('status')).toHaveTextContent('1 open · 1 resolved');
  });
});
