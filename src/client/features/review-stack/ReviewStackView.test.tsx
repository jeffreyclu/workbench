// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffBlockReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { ReviewStackView } from './ReviewStackView.js';
import { indexReviewBlocks } from './review-blocks.js';

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
    if (url.includes('/workspace-diff/hunk-reviews')) return json({ reviews: [] });
    if (url.includes('/review-assist/lookup')) return json({ answer: null });
    if (url.includes('/workspace-diff')) return json({ diff: reviewDiff });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ReviewStackView scope={{ workItemId: 'work-item-1' }} /></QueryClientProvider>);
  return calls;
}

/** The handle on the canvas for a change in this file. Node ids are decision
 * ids, so this is the same change the gutter marker and the queue address. */
function canvasNode(filePath: string) {
  return screen.getByRole('button', { name: new RegExp(`^Change \\d+: .* in ${filePath}(?: — .*)?$`) });
}

/** Waits for the canvas to have drawn, addressed by the same handle. */
async function canvasNodeReadyFor(filePath: string) {
  await screen.findByRole('button', { name: new RegExp(`^Change \\d+: .* in ${filePath}(?: — .*)?$`) });
}

/** The card is the code and the canvas and nothing else, so there is no panel
 * to open and no verdict button to press: a block is judged with the keyboard,
 * against the change the card is already on. */
async function judgeActiveBlock(filePath = 'src/server/auth.ts') {
  await screen.findByRole('button', { name: new RegExp(`^Change \\d+: .* in ${filePath}(?: — .*)?$`) });
  fireEvent.keyDown(document, { key: 'r' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Reading mode is remembered globally, so one test's choice must not become
  // the next test's starting state.
  window.localStorage.clear();
});

describe('ReviewStackView', () => {
  it('opens on the block that deserves attention', async () => {
    renderReview();
    // With no stack to pick from, the card has to land on the highest-tier
    // unsettled block itself. The import-only block is settled by proof, so it
    // is never what opens.
    expect(await screen.findByLabelText('Full diff for src/server/auth.ts')).toBeInTheDocument();
    await waitFor(() => expect(canvasNode('src/server/auth.ts')).toHaveClass('is-active'));
  });

  it('shows no decision stack anywhere around the card', async () => {
    renderReview();
    await screen.findByRole('region', { name: 'Change canvas' });
    // The queue of decision cards is gone, and with it the control that used to
    // hand it back: the card is the whole surface.
    expect(screen.queryByRole('navigation', { name: 'Review queue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to stack' })).toBeNull();
    expect(screen.queryByRole('button', { name: /settled automatically/ })).toBeNull();
    expect(document.querySelector('.review-queue')).toBeNull();
  });

  it('states what is still owed rather than only what is done', async () => {
    renderReview();
    expect(await screen.findByRole('status')).toHaveTextContent(/1 to judge · 1 settled automatically/);
  });

  it('records the verdict at block identity first, not at hunk identity', async () => {
    const calls = renderReview();
    await judgeActiveBlock();
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
    await judgeActiveBlock();
    await waitFor(() => {
      // The auth hunk holds a single block, so answering that block answers the
      // whole hunk. Changes addresses hunks, so it is the parent hunk range that
      // travels back, not the block range Review records against.
      const write = calls.find((call) => call.method === 'PUT' && call.url.includes('hunk-reviews'));
      expect(write?.body).toMatchObject({ revision: 'rev-1', state: 'reviewed', hunks: [{ filePath: 'src/server/auth.ts', hunkRange: '@@ -20,4 +20,6 @@ export function authorize(request) {' }] });
    });
  });

  it('reports the full diff size as files, additions and deletions', async () => {
    const sizedDiff = { ...diff, files: [{ ...diff.files[0], additions: 401, deletions: 27 }] };
    renderReview(sizedDiff);
    await screen.findByRole('region', { name: 'Change canvas' });

    const stat = await screen.findByRole('note', { name: 'Diff size' });
    expect(stat).toHaveTextContent('1 file changed');
    expect(stat).toHaveTextContent('+401');
    expect(stat).toHaveTextContent('−27');
    expect(stat).toHaveTextContent('428 changed lines');
  });

  it('moves linearly between flagged blocks and changed files with keyboard shortcuts', async () => {
    renderReview(twoDecisionDiff);
    await screen.findByRole('region', { name: 'Change canvas' });
    await waitFor(() => expect(document.querySelectorAll('.review-canvas-node')).toHaveLength(2));
    // The canvas is the only readout of the selection now, so the shortcuts are
    // checked against the node that is current there.
    const activeLabel = () => document.querySelector('.review-canvas-node[aria-current="true"]')?.textContent ?? '';

    // A canvas node names the file it stands for, so the moves are checked
    // against that rather than against the symbol a queue row used to show.
    expect(activeLabel()).toContain('server/auth.ts');
    fireEvent.keyDown(document, { key: 'j' });
    await waitFor(() => expect(activeLabel()).toContain('client/auth.ts'));
    fireEvent.keyDown(document, { key: 'k' });
    await waitFor(() => expect(activeLabel()).toContain('server/auth.ts'));
    fireEvent.keyDown(document, { key: ']' });
    await waitFor(() => expect(activeLabel()).toContain('client/auth.ts'));
    fireEvent.keyDown(document, { key: '[' });
    await waitFor(() => expect(activeLabel()).toContain('server/auth.ts'));
  });

  it('opens a card as the code and the canvas, and nothing else', async () => {
    renderReview();
    // Both readings are there from the start — no disclosure to open, and no
    // panel of controls in front of them.
    await waitFor(() => expect(document.querySelector('.diff-line')).not.toBeNull());
    expect(screen.getByRole('region', { name: 'Change canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /what this block claims/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reviewed/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment on this block' })).toBeNull();
  });

  it('greys the changes already handled and leaves the ones still owed at full strength', async () => {
    renderReview();
    await canvasNodeReadyFor('src/server/auth.ts');

    const nodes = [...document.querySelectorAll('.review-canvas-node')];
    const labelled = (path: string) => nodes.find((node) => node.getAttribute('aria-label')?.includes(path));

    // An import-only change is routed below Jeffrey's reading time, so the
    // canvas has to say so without him opening it.
    expect(labelled('src/app.ts')?.classList.contains('is-handled')).toBe(true);
    // The auth change is the one still owed: greying it would hide the work.
    expect(labelled('src/server/auth.ts')?.classList.contains('is-handled')).toBe(false);
  });

  it('greys a change in the canvas once a verdict is recorded against it', async () => {
    const discovery = renderReview();
    await judgeActiveBlock();

    // The block's storage identity is the surface's own, hash included, so it
    // is read off a real write rather than guessed at here.
    const written = await waitFor(() => {
      const put = discovery.find((call) => call.method === 'PUT' && call.url.includes('block-reviews'));
      expect(put).toBeDefined();
      return put!.body as { filePath: string; blockRange: string; contentHash: string };
    });
    cleanup();
    vi.unstubAllGlobals();

    renderReview(diff, [{
      id: 'r1', revision: 'rev-1', filePath: written.filePath, blockRange: written.blockRange,
      contentHash: written.contentHash, state: 'reviewed', note: null, updatedAt: '2026-01-01',
    }]);

    await waitFor(() => {
      const node = [...document.querySelectorAll('.review-canvas-node')]
        .find((candidate) => candidate.getAttribute('aria-label')?.includes('src/server/auth.ts'));
      // A change with a verdict on it is done, and the canvas has to say so
      // before Jeffrey spends a read finding that out.
      expect(node?.classList.contains('is-handled')).toBe(true);
      expect(node?.getAttribute('aria-label')).toContain('Approved');
    });
  });

  it('greys a change that was answered before the branch moved', async () => {
    // Same code, different revision: rebasing or pushing a follow-up commit
    // changes the revision of every block in the diff, including the ones nobody
    // touched. Those must not come back asking the same question.
    const seeded: DiffBlockReview[] = [...indexReviewBlocks(diff.files).values()]
      .filter((identity) => identity.filePath === 'src/server/auth.ts')
      .map((identity, index) => ({
        id: `seed-${index}`, revision: 'rev-0', filePath: identity.filePath, blockRange: identity.range,
        contentHash: identity.contentHash, state: 'reviewed', note: null, updatedAt: '2026-01-01',
      }));
    renderReview(diff, seeded);

    await waitFor(() => {
      const node = [...document.querySelectorAll('.review-canvas-node')]
        .find((candidate) => candidate.getAttribute('aria-label')?.includes('src/server/auth.ts'));
      expect(node?.classList.contains('is-handled')).toBe(true);
      expect(node?.getAttribute('aria-label')).toContain('Approved');
    });
  });

  it('tells Changes about a verdict carried in from an earlier revision, once', async () => {
    // Every block of the import file, answered under a revision that is no
    // longer the one on screen. The identities come from the surface's own
    // splitter, so the hashes are the ones the carry-forward matches on rather
    // than values invented here.
    const seeded: DiffBlockReview[] = [...indexReviewBlocks(diff.files).values()]
      .filter((identity) => identity.filePath === 'src/app.ts')
      .map((identity, index) => ({
        id: `seed-${index}`, revision: 'rev-0', filePath: identity.filePath, blockRange: identity.range,
        contentHash: identity.contentHash, state: 'reviewed', note: null, updatedAt: '2026-01-01',
      }));
    const calls = renderReview(diff, seeded);
    await canvasNodeReadyFor('src/server/auth.ts');

    // Changes keys its rows on the revision, so a review given before the branch
    // moved reaches it only if the carried verdict is projected again here.
    const written = await waitFor(() => {
      const puts = calls.filter((call) => call.method === 'PUT' && call.url.includes('hunk-reviews'));
      expect(puts).toHaveLength(1);
      return puts[0].body as { revision: string; state: string; hunks: Array<{ filePath: string; hunkRange: string; contentHash: string }> };
    });
    expect(written.revision).toBe('rev-1');
    expect(written.state).toBe('reviewed');
    expect(written.hunks).toEqual([{ filePath: 'src/app.ts', hunkRange: '@@ -1,2 +1,3 @@', contentHash: expect.any(String) }]);

    // The read this is diffed against is stubbed empty, so a reconcile that did
    // not remember what it already asked for would rewrite Changes forever.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.method === 'PUT' && call.url.includes('hunk-reviews'))).toHaveLength(1);
  });

  it('puts no decision panel up from either handle', async () => {
    renderReview();
    await screen.findByRole('button', { name: /^Change \d+: .* in src\/server\/auth.ts(?: — .*)?$/ });

    // A canvas node and a gutter marker both only move the selection: neither
    // opens a panel over the code, and nothing is left waiting behind them.
    fireEvent.click(canvasNode('src/server/auth.ts'));
    fireEvent.click(document.querySelector('.diff-review-block-marker')!);
    await waitFor(() => expect(canvasNode('src/server/auth.ts')).toHaveClass('is-active'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: /what this block claims/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reviewed/ })).toBeNull();
  });

  it('focuses the hunk and its canvas node together, whichever one is picked', async () => {
    renderReview(twoDecisionDiff);
    await screen.findByRole('button', { name: /^Change \d+: .* in src\/server\/auth.ts(?: — .*)?$/ });
    expect(canvasNode('src/server/auth.ts')).toHaveClass('is-active');
    expect(screen.getByLabelText('Full diff for src/server/auth.ts')).toBeInTheDocument();

    // Picking a node moves the code to the hunk it stands for.
    fireEvent.click(canvasNode('src/client/auth.ts'));
    await waitFor(() => expect(screen.getByLabelText('Full diff for src/client/auth.ts')).toBeInTheDocument());
    expect(canvasNode('src/client/auth.ts')).toHaveClass('is-active');

    // And moving through the hunks moves the node, so the two never disagree.
    fireEvent.keyDown(document, { key: 'k' });
    await waitFor(() => expect(canvasNode('src/server/auth.ts')).toHaveClass('is-active'));
    expect(canvasNode('src/client/auth.ts')).not.toHaveClass('is-active');
  });

  it('acknowledges a handle press even on the change already selected', async () => {
    renderReview();
    await screen.findByRole('button', { name: /^Change \d+: .* in src\/server\/auth.ts(?: — .*)?$/ });
    const node = () => canvasNode('src/server/auth.ts');
    const block = () => document.querySelector('.diff-review-diff-block.active')!;
    const marker = () => document.querySelector('.diff-review-block-marker')!;

    // The change under both handles is the one already open, so nothing scrolls
    // and nothing changes state: this is the press that used to do nothing at
    // all once the popover behind the marker was removed.
    expect(node()).toHaveClass('is-active');

    fireEvent.click(node());
    await waitFor(() => expect(node()).toHaveClass('handle-pulse'));
    expect(block()).toHaveClass('handle-pulse');

    block().classList.remove('handle-pulse');
    node().classList.remove('handle-pulse');

    fireEvent.click(marker());
    await waitFor(() => expect(block()).toHaveClass('handle-pulse'));
    expect(node()).toHaveClass('handle-pulse');
  });

  it('opens the change under either handle, and closes it on a second press', async () => {
    renderReview(twoDecisionDiff);
    await screen.findByRole('button', { name: /^Change \d+: .* in src\/server\/auth.ts(?: — .*)?$/ });
    const brief = () => document.querySelector('.review-change-brief');
    const marker = () => document.querySelector('.diff-review-block-marker')!;

    // A press has to produce something to read, not only a highlight.
    expect(brief()).toBeNull();

    fireEvent.click(marker());
    await waitFor(() => expect(brief()).not.toBeNull());
    // It opens against the block it names, inside the diff.
    expect(document.querySelector('.diff-review-diff-block.active .review-change-brief')).not.toBeNull();
    expect(screen.getByRole('button', { name: /mark reviewed/i })).toBeInTheDocument();

    fireEvent.click(marker());
    await waitFor(() => expect(brief()).toBeNull());

    // The canvas node is the same handle, so it opens the same thing.
    fireEvent.click(canvasNode('src/client/auth.ts'));
    await waitFor(() => expect(screen.getByLabelText('Full diff for src/client/auth.ts')).toBeInTheDocument());
    await waitFor(() => expect(brief()).not.toBeNull());
  });

  it('reads a block as its finished code by default and drops to the diff with d', async () => {
    renderReview();
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
    await screen.findByRole('button', { name: /final code/i });
    fireEvent.keyDown(document, { key: 'd' });
    await screen.findByRole('button', { name: /^diff$/i });

    cleanup();
    renderReview();

    // A remount is not a new reviewer. Coming back to Review must not silently
    // put the pane back into final reading after it was deliberately left.
    await waitFor(() => expect(screen.getByRole('button', { name: /^diff$/i })).toHaveAttribute('aria-pressed', 'false'));
    expect(document.querySelector('.diff-line.final')).toBeNull();
  });

  it('marks the active flagged block reviewed with r', async () => {
    const calls = renderReview();
    // There is no panel at all: the shortcut answers the block the card is on.
    await screen.findByRole('button', { name: /^Change \d+: .* in src\/server\/auth.ts(?: — .*)?$/ });
    fireEvent.keyDown(document, { key: 'r' });
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT' && (call.body as { state: string }).state === 'reviewed')).toBe(true));
  });

  it('opens the whole file when the surrounding code is the argument', async () => {
    renderReview();
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

  it('carries an existing comment forward when the block is later marked reviewed', async () => {
    // The block's storage identity is the surface's own, hash included, so it
    // is read off a real write rather than guessed at here.
    const discovery = renderReview();
    await judgeActiveBlock();
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

    await judgeActiveBlock();
    // Every upsert overwrites the note column, so a verdict saved without a
    // note has to resend the one already there or the comment is deleted.
    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url.includes('block-reviews'));
      expect(put?.body).toMatchObject({ state: 'reviewed', note });
    });
  });
  it('reads a branch commit by commit as well as whole', async () => {
    const commits = [
      { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', title: 'tighten authorize', author: 'jeffrey', committedAt: '2026-01-02T00:00:00Z' },
      { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', title: 'add an import', author: 'jeffrey', committedAt: '2026-01-01T00:00:00Z' },
    ];
    const branchDiff = { ...diff, branch: 'feature', revision: 'branch:feature:base..tip' };
    const commitDiff = {
      ...diff, branch: 'feature', revision: `commit:${commits[0].sha}`, changedFiles: 1,
      files: [file('src/server/auth.ts', AUTH_PATCH)],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/workspace-diff/file')) return json({ file: { path: 'src/server/auth.ts', revision: null, content: AUTH_FILE, unavailable: null } });
      if (url.includes('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.includes('/workspace-diff/refs')) return json({ refs: { base: 'main', branches: [{ name: 'feature', current: false, ahead: 2 }], worktrees: [] } });
      if (url.includes('/workspace-diff/ref/commits')) return json({ commits });
      if (url.includes('/workspace-diff/commit')) return json({ diff: commitDiff });
      if (url.includes('/workspace-diff/ref')) return json({ diff: branchDiff });
      if (url.includes('block-reviews')) return init?.method === 'PUT' ? json({ review: null }) : json({ reviews: [] });
      if (url.includes('hunk-reviews')) return json({ reviews: [] });
      if (url.includes('/review-assist/lookup')) return json({ answer: null });
      if (url.includes('/workspace-diff')) return json({ diff });
      return json({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><ReviewStackView scope={{ workItemId: 'work-item-1' }} /></QueryClientProvider>);

    await screen.findByLabelText('Reviewing');
    fireEvent.change(screen.getByLabelText('Reviewing'), { target: { value: 'branch:feature' } });

    // The whole branch first: every file the branch touched.
    await waitFor(() => expect(canvasNode('src/app.ts')).toBeInTheDocument());
    const commitSelect = await screen.findByLabelText('Commit');
    expect(screen.getByRole('option', { name: 'All 2 commits' })).toBeInTheDocument();

    fireEvent.change(commitSelect, { target: { value: commits[0].sha } });
    // Now only what that commit did, rather than the branch's total.
    await waitFor(() => expect(screen.queryByRole('button', { name: /in src\/app\.ts/ })).toBeNull());
    await canvasNodeReadyFor('src/server/auth.ts');
  });
});
