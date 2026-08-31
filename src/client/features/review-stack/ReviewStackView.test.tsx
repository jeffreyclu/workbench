// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffBlockReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
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

/** The file `AUTH_PATCH` changes, whole. Lines 20–24 are the patch's new side;
 * everything else is the surrounding code the patch window crops away. */
const AUTH_FILE = [
  ...Array.from({ length: 19 }, (_, index) => `const filler${index + 1} = ${index + 1};`),
  'export function authorize(request) {',
  '  if (!request.token) return request.internal === true;',
  '  if (request.token === "*") return true;',
  '  return verify(request.token);',
  '}',
  'export const AUDIT = true;',
  '',
].join('\n');

function file(path: string, patch: string): WorkspaceDiffFile {
  return { path, status: 'modified', additions: 2, deletions: 1, previousPath: null, patch, isBinary: false, editorUrl: null };
}

const diff = {
  workspacePath: '/tmp/workbench', branch: 'review', revision: 'rev-1', changedFiles: 2, additions: 4, deletions: 2,
  publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
  files: [file('src/server/auth.ts', AUTH_PATCH), file('src/app.ts', IMPORT_PATCH)],
};

// A decision spans every file that carries the same change, so two files with
// an identical patch are one decision, not two. Keyboard navigation between
// decisions needs the two files to differ in what they actually do.
const CLIENT_AUTH_PATCH = [
  '@@ -8,4 +8,5 @@ export function attachToken(request) {',
  ' export function attachToken(request) {',
  '-  request.headers.token = token;',
  '+  if (!token) throw new Error("missing token");',
  '+  request.headers.token = token;',
  '   return request;',
  ' }',
].join('\n');

const twoDecisionDiff = { ...diff, files: [file('src/server/auth.ts', AUTH_PATCH), file('src/client/auth.ts', CLIENT_AUTH_PATCH)] };

function renderReview(reviewDiff = diff, seededReviews: DiffBlockReview[] = []) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/workspace-diff/file')) return json({ file: { path: 'src/server/auth.ts', revision: null, content: AUTH_FILE, unavailable: null } });
    if (url.includes('/workspace-diff/snapshots')) return json({ snapshots: [] });
    if (url.includes('/workspace-diff/block-reviews')) return init?.method === 'PUT'
      ? json({ review: { id: 'r1', revision: 'rev-1', filePath: 'src/server/auth.ts', blockRange: '@@', contentHash: 'h', state: 'reviewed', note: null, updatedAt: '2026-01-01' } })
      : json({ reviews: seededReviews });
    if (url.includes('/review-assist/lookup')) return json({ answer: null });
    if (url.includes('/workspace-diff')) return json({ diff: reviewDiff });
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
  // Reading mode is remembered globally, so one test's choice must not become
  // the next test's starting state.
  window.localStorage.clear();
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

  it('opens the canvas when a card is clicked and hands the stack back on request', async () => {
    renderReview();
    const queue = await screen.findByRole('navigation', { name: 'Review queue' });
    const rows = await waitFor(() => {
      const found = within(queue).queryAllByRole('button');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // Nothing is open until a card is chosen: the stack is the whole surface.
    expect(document.querySelector('.review-stack-layout')).not.toHaveClass('is-canvas-open');

    fireEvent.click(rows[0]);
    expect(document.querySelector('.review-stack-layout')).toHaveClass('is-canvas-open');

    fireEvent.click(screen.getByRole('button', { name: 'Back to stack' }));
    expect(document.querySelector('.review-stack-layout')).not.toHaveClass('is-canvas-open');
  });

  it('states what is still owed rather than only what is done', async () => {
    renderReview();
    expect(await screen.findByRole('status')).toHaveTextContent(/1 to judge · 1 settled automatically/);
  });

  it('records the verdict at block identity first, not at hunk identity', async () => {
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

  it('reconciles a fully answered hunk back into the Changes surface', async () => {
    const calls = renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /Reviewed/ }));
    await waitFor(() => {
      // The auth hunk holds a single block, so answering that block answers the
      // whole hunk. Changes addresses hunks, so it is the parent hunk range that
      // travels back, not the block range Review records against.
      const write = calls.find((call) => call.method === 'PUT' && call.url.includes('hunk-reviews'));
      expect(write?.body).toMatchObject({ revision: 'rev-1', state: 'reviewed', hunks: [{ filePath: 'src/server/auth.ts', hunkRange: '@@ -20,4 +20,6 @@ export function authorize(request) {' }] });
    });
  });

  it('suggests a stopping point only after more than 400 changed lines', async () => {
    const boundaryDiff = { ...diff, files: [{ ...diff.files[0], additions: 400, deletions: 0 }] };
    renderReview(boundaryDiff);
    await screen.findByRole('navigation', { name: 'Review queue' });
    expect(screen.queryByRole('note', { name: 'Suggested stopping point' })).not.toBeInTheDocument();
    cleanup();

    const largeDiff = { ...diff, files: [{ ...diff.files[0], additions: 401, deletions: 0 }] };
    renderReview(largeDiff);
    expect(await screen.findByRole('note', { name: 'Suggested stopping point' })).toHaveTextContent('401 changed lines');
  });

  it('moves linearly between flagged blocks and changed files with keyboard shortcuts', async () => {
    renderReview(twoDecisionDiff);
    const queue = await screen.findByRole('navigation', { name: 'Review queue' });
    await waitFor(() => expect(within(queue).getAllByRole('button')).toHaveLength(2));
    // A queue row is labelled by the block it points at, not by its file path.
    const activeLabel = () => within(queue).getAllByRole('button').find((button) => button.getAttribute('aria-current') === 'true')!.textContent;

    expect(activeLabel()).toContain('authorize');
    fireEvent.keyDown(document, { key: 'j' });
    await waitFor(() => expect(activeLabel()).toContain('attachToken'));
    fireEvent.keyDown(document, { key: 'k' });
    await waitFor(() => expect(activeLabel()).toContain('authorize'));
    fireEvent.keyDown(document, { key: ']' });
    await waitFor(() => expect(activeLabel()).toContain('attachToken'));
    fireEvent.keyDown(document, { key: '[' });
    await waitFor(() => expect(activeLabel()).toContain('authorize'));
  });

  it('leads with the claim and keeps the code closed until it is opened to falsify it', async () => {
    renderReview();
    // The claim is what a reviewer reads first. Line-by-line reading from an
    // already-open pane is the habit this surface exists to break.
    await screen.findByRole('region', { name: /what this block claims/i });
    const open = screen.getByRole('button', { name: /read the code to falsify/i });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.diff-line')).toBeNull();

    fireEvent.click(open);

    await waitFor(() => expect(document.querySelector('.diff-line')).not.toBeNull());
    expect(screen.getByRole('button', { name: /hide the code/i })).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes the code again when the reviewer moves to the next block', async () => {
    renderReview(twoDecisionDiff);
    await screen.findByRole('region', { name: /what this block claims/i });
    fireEvent.keyDown(document, { key: 'o' });
    await waitFor(() => expect(document.querySelector('.diff-line')).not.toBeNull());

    fireEvent.keyDown(document, { key: 'j' });

    // Each block gets its own reading: a pane left open would put the code back
    // in front of the next block's claim.
    await waitFor(() => expect(document.querySelector('.diff-line')).toBeNull());
  });

  it('reads a block as its finished code by default and drops to the diff with d', async () => {
    renderReview();
    await screen.findByRole('region', { name: /what this block claims/i });
    fireEvent.keyDown(document, { key: 'o' });
    // The default reading is the code that will exist: a rewritten block is
    // judged as a whole construct rather than as an interleaving of two files.
    const toggle = await screen.findByRole('button', { name: /final code/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.diff-line.final')).not.toBeNull();
    expect(document.querySelector('.diff-line.deletion:not(.final)')).toBeNull();

    fireEvent.keyDown(document, { key: 'd' });

    await waitFor(() => expect(screen.getByRole('button', { name: /^diff$/i })).toHaveAttribute('aria-pressed', 'false'));
    expect(document.querySelector('.diff-line.deletion')).not.toBeNull();
    expect(document.querySelector('.diff-line.final')).toBeNull();
  });

  it('reopens in the reading mode the reviewer last chose', async () => {
    renderReview();
    await screen.findByRole('region', { name: /what this block claims/i });
    fireEvent.keyDown(document, { key: 'o' });
    await screen.findByRole('button', { name: /final code/i });
    fireEvent.keyDown(document, { key: 'd' });
    await screen.findByRole('button', { name: /^diff$/i });

    cleanup();
    renderReview();
    await screen.findByRole('region', { name: /what this block claims/i });
    fireEvent.keyDown(document, { key: 'o' });

    // A remount is not a new reviewer. Coming back to Review must not silently
    // put the pane back into final reading after it was deliberately left.
    await waitFor(() => expect(screen.getByRole('button', { name: /^diff$/i })).toHaveAttribute('aria-pressed', 'false'));
    expect(document.querySelector('.diff-line.final')).toBeNull();
  });

  it('marks the active flagged block reviewed with r', async () => {
    const calls = renderReview();
    await screen.findByRole('button', { name: /Reviewed/ });
    fireEvent.keyDown(document, { key: 'r' });
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT' && (call.body as { state: string }).state === 'reviewed')).toBe(true));
  });

  it('opens the whole file when the surrounding code is the argument', async () => {
    renderReview();
    await screen.findByRole('region', { name: /what this block claims/i });
    fireEvent.keyDown(document, { key: 'o' });
    await screen.findByRole('button', { name: /final code/i });
    // final → diff → whole file: one key, three magnifications of one block.
    fireEvent.keyDown(document, { key: 'd' });
    await screen.findByRole('button', { name: /^diff$/i });
    fireEvent.keyDown(document, { key: 'd' });

    expect(await screen.findByRole('button', { name: /whole file/i })).toBeInTheDocument();
    const rows = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.review-full-file-row'));
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // The patch window stops three lines out; the file does not. Line 1 is
    // nowhere in the diff and is exactly the context a refactor is judged on.
    expect(rows.some((row) => row.textContent?.includes('const filler1 = 1;'))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes('export const AUDIT = true;'))).toBe(true);
    // Only the added lines are marked, at their real line numbers in the file.
    const changed = Array.from(document.querySelectorAll('.review-full-file-row.changed'));
    expect(changed.map((row) => row.getAttribute('data-line'))).toEqual(['21', '22']);
    expect(document.querySelector('.review-full-file-row.removed')).not.toBeNull();
  });

  it('offers the composer on a block without opening it, so the code stays in front of the reviewer', async () => {
    renderReview();
    expect(await screen.findByRole('button', { name: 'Comment on this block' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Comment on this block' })).toBeNull();
  });

  it('carries an existing comment forward when the block is later marked reviewed', async () => {
    // The block's storage identity is the surface's own, hash included, so it
    // is read off a real write rather than guessed at here.
    const discovery = renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /Reviewed/ }));
    const written = await waitFor(() => {
      const put = discovery.find((call) => call.method === 'PUT' && call.url.includes('block-reviews'));
      expect(put).toBeDefined();
      return put!.body as { filePath: string; blockRange: string; contentHash: string };
    });
    cleanup();
    vi.unstubAllGlobals();

    const note = 'A token of "*" skips verification entirely.';
    const calls = renderReview(diff, [{
      id: 'r1', revision: 'rev-1', filePath: written.filePath, blockRange: written.blockRange,
      contentHash: written.contentHash, state: 'commented', note, updatedAt: '2026-01-01',
    }]);

    expect(await screen.findByText(note)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Reviewed/ }));
    // Every upsert overwrites the note column, so a verdict saved without a
    // note has to resend the one already there or the comment is deleted.
    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url.includes('block-reviews'));
      expect(put?.body).toMatchObject({ state: 'reviewed', note });
    });
  });
});