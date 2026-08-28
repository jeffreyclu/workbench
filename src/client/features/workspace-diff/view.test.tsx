// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunReviewHandoff, DiffHunkReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { formatDiffFollowUpReference, type DiffFollowUpReference } from '../diff-confidence.js';
import { WorkspaceDiffView } from './view.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const publish = { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null };

function workspaceDiff(files: WorkspaceDiffFile[], revision = 'review-revision') {
  return {
    workspacePath: '/tmp/workbench', branch: 'review', revision, changedFiles: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    publish,
    files,
  };
}

/** This surface never scores decisions ambiently; assistance is on demand from
 * the detail card instead. Tests only stub the requests this view actually
 * makes, so a stray `/api/diff-confidence` call would fail as unexpected. */
function renderView(fetchMock: ReturnType<typeof vi.fn>, isRunning = false, onFollowUp?: (reference: DiffFollowUpReference) => void, reviewHandoff?: AgentRunReviewHandoff | null) {
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={isRunning} reviewHandoff={reviewHandoff} onFollowUp={onFollowUp} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView decision queue', () => {
  it('uses arrow navigation and keeps the decision panel closed on phones until requested', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const file: WorkspaceDiffFile = {
      path: 'src/mobile-review.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false,
      patch: '@@ -1 +1 @@ firstDecision\n-before\n+after\n@@ -10 +10 @@ secondDecision\n-old\n+new',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'mobile-review') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByRole('button', { name: 'View decision' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Changes behavior in src/mobile-review.ts.' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous decision' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next decision' }));
    expect(screen.getByText('Decision 2 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Changes behavior in src/mobile-review.ts.' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View decision' }));
    expect(await screen.findByRole('heading', { name: 'Changes behavior in src/mobile-review.ts.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide decision' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders the agent handoff before the review decision queue', async () => {
    const files: WorkspaceDiffFile[] = [{ path: 'src/app.ts', editorUrl: null, previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff(files) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, false, undefined, {
      agentRunId: 'run-1', formatVersion: 1, summary: 'Implemented the requested change.', changes: [], acceptanceCriteria: [], contractChanges: [], verification: [],
      uncertainties: ['No completed test, build, typecheck, or lint command was observed by the runner.'], tradeoffs: [], createdAt: '2026-08-27T01:00:00.000Z',
    });

    const handoff = await screen.findByRole('region', { name: 'Agent review handoff' });
    const queue = await screen.findByRole('navigation', { name: /review decision queue/i });
    expect(handoff.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a retry action instead of an empty state when loading the workspace diff fails', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) {
        attempts += 1;
        if (attempts === 1) throw new Error('Network unavailable');
        return json({ diff: workspaceDiff([], 'retry') });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByText('Could not load local workspace changes.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No uncommitted changes to review.')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('orders the queue deterministically by source order, with no ambient AI scoring', async () => {
    const files: WorkspaceDiffFile[] = [
      { path: 'src/local.ts', editorUrl: 'vscode://file/tmp/workbench/src/local.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false, patch: '@@ -1 +1 @@ localOne\n-before\n+after\n@@ -10 +10 @@ localTwo\n-old\n+new' },
      { path: 'src/server/auth/routes.ts', previousPath: null, status: 'modified', additions: 3, deletions: 1, isBinary: false, patch: '@@ -20 +20,3 @@ authorizeRequest\n-export function authorizeRequest() {}\n+export async function authorizeRequest() {\n+  await repository.update(session)\n+  throw new Error("denied")' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/diff-confidence')) throw new Error(`Unexpected ambient AI request: ${url}`);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [{ path: '/tmp/workbench', label: 'workbench', selected: true }] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff(files) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.includes('/workspace-diff/status?')) return json({ changed: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, true);

    expect(await screen.findByLabelText('3 decisions across 2 files, 0 completed')).toHaveTextContent('3 decisions across 2 files');
    // Priority order is purely deterministic by source order (ordinal): decision 1 opens first.
    expect(screen.getByRole('button', { name: /Decision 1.*local/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('src/local.ts', { selector: 'code' })).toBeInTheDocument();
    // Deterministic risk signals still surface on the detail card (Phase 1 stays visible by
    // default); they never gate or reorder the queue, and no ambient AI request ever fires for them.
    expect(screen.getByText('Risk signals')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh changes' })).toHaveClass('workspace-diff-refresh-pending');

    const decisionQueue = screen.getByRole('navigation', { name: 'Review decision queue' });
    const decisionButtons = within(decisionQueue).getAllByRole('button');
    expect(decisionButtons[0]).toHaveTextContent('local');
    fireEvent.click(within(decisionQueue).getByRole('button', { name: /Decision 3/ }));
    expect(await screen.findByLabelText('Full diff for src/server/auth/routes.ts')).toBeInTheDocument();
  });

  it('shows the whole file diff and highlights the block the selected decision changes', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/local.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false,
      patch: '@@ -1,3 +1,3 @@ firstBehavior\n context-one\n-before\n+after\n@@ -10,3 +10,3 @@ secondBehavior\n context-two\n-old\n+new',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'jump-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    const diffPane = await screen.findByLabelText('Full diff for src/local.ts');
    // Every hunk of the file is on screen, not only the selected decision's lines.
    for (const line of ['context-one', '-before', '+after', 'context-two', '-old', '+new']) {
      expect(within(diffPane).getByText(line)).toBeInTheDocument();
    }
    expect(diffPane.querySelectorAll('.diff-review-diff-block')).toHaveLength(2);
    expect(diffPane.querySelector('.diff-review-diff-block.active')).toHaveTextContent('@@ -1,3 +1,3 @@ firstBehavior');

    // Old and new line numbers are carried through, so the highlighted block is locatable in the file.
    const deletedLine = within(diffPane).getByText('-before').closest('.diff-line');
    expect(deletedLine).toHaveTextContent('2-before');

    fireEvent.click(screen.getByRole('button', { name: /Decision 2.*behavior/ }));
    expect(diffPane.querySelector('.diff-review-diff-block.active')).toHaveTextContent('@@ -10,3 +10,3 @@ secondBehavior');
    expect(screen.getByRole('heading', { name: 'Changes behavior in src/local.ts.' })).toBeInTheDocument();

    // Clicking a block inside the diff selects that decision too.
    fireEvent.click(within(diffPane).getByRole('button', { name: 'Select the decision at Lines 1\u20133 in src/local.ts' }));
    expect(diffPane.querySelector('.diff-review-diff-block.active')).toHaveTextContent('@@ -1,3 +1,3 @@ firstBehavior');
  });

  it('highlights the block for a decision grouped across files by shared subject', async () => {
    const authFile: WorkspaceDiffFile = {
      path: 'src/server/auth/routes.ts', previousPath: null, status: 'modified', additions: 3, deletions: 1, isBinary: false,
      patch: '@@ -10 +10,3 @@ function authorizeRequest()\n-export function authorizeRequest() {}\n+export async function authorizeRequest() {\n+  await repository.update(session)\n+  throw new Error("denied")',
    };
    const authTestFile: WorkspaceDiffFile = {
      path: 'src/server/auth/routes.test.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false,
      patch: '@@ -30 +30 @@ describe("authorizeRequest")\n-expect(authorizeRequest()).toBe(false)\n+await expect(authorizeRequest()).rejects.toThrow()',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([authFile, authTestFile], 'cross-file-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    // The two files share the "authorizeRequest" subject, so buildReviewDecisions groups
    // them into one decision whose id differs from either raw per-hunk id. The pane opens
    // on the first grouped file's hunk, which must still highlight as the selected decision.
    const diffPane = await screen.findByLabelText('Full diff for src/server/auth/routes.ts');
    expect(diffPane.querySelector('.diff-review-diff-block.active')).toHaveTextContent('@@ -10 +10,3 @@ function authorizeRequest()');
  });

  it('clears the on-demand AI explanation when the reviewer switches to a different decision', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/local.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false,
      patch: '@@ -1,3 +1,3 @@ firstBehavior\n context-one\n-before\n+after\n@@ -10,3 +10,3 @@ secondBehavior\n context-two\n-old\n+new',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'jump-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.endsWith('/api/review-assist')) return json({ answer: 'This decision only touches local formatting.' });
      throw new Error(`Unexpected request: ${url} ${init?.method ?? ''}`);
    });
    renderView(fetchMock);

    await screen.findByRole('heading', { name: 'Changes behavior in src/local.ts.' });
    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));
    await screen.findByText('This decision only touches local formatting.');

    fireEvent.click(screen.getByRole('button', { name: /Decision 2.*behavior/ }));
    expect(screen.queryByText('This decision only touches local formatting.')).toBeNull();
  });

  it('persists exact hunk outcomes and auto-advances after each decision', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/reviewed.ts', previousPath: null, status: 'modified', additions: 3, deletions: 3, isBinary: false,
      patch: '@@ -1 +1 @@ firstBehavior\n-a\n+b\n@@ -10 +10 @@ secondBehavior\n-c\n+d\n@@ -20 +20 @@ thirdBehavior\n-e\n+f',
    };
    let reviews: DiffHunkReview[] = [{ id: 'review-3', revision: 'hunk-revision', filePath: file.path, hunkRange: '@@ -20 +20 @@ thirdBehavior', state: 'commented', note: 'Existing context.', updatedAt: '2026-08-27T00:00:00.000Z' }];
    const putBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'hunk-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews });
      if (url.endsWith('/workspace-diff/hunk-reviews/batch') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { revision: string; hunks: Array<{ filePath: string; hunkRange: string }>; state: DiffHunkReview['state']; note?: string };
        putBodies.push(body);
        const saved = body.hunks.map((hunk, index): DiffHunkReview => ({ id: `review-${reviews.length + index + 1}`, revision: body.revision, ...hunk, state: body.state, note: body.note ?? null, updatedAt: '2026-08-27T00:00:00.000Z' }));
        reviews = [...reviews.filter((review) => !body.hunks.some((hunk) => hunk.filePath === review.filePath && hunk.hunkRange === review.hunkRange)), ...saved];
        return json({ reviews: saved });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByRole('heading', { name: 'Changes behavior in src/reviewed.ts.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    expect(await screen.findByText('@@ -10 +10 @@ secondBehavior')).toBeInTheDocument();
    expect(putBodies[0]).toEqual({ revision: 'hunk-revision', hunks: [{ filePath: 'src/reviewed.ts', hunkRange: '@@ -1 +1 @@ firstBehavior' }], state: 'reviewed' });

    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    expect(await screen.findByText('@@ -20 +20 @@ thirdBehavior')).toBeInTheDocument();
    expect(screen.getByText('Commented', { selector: '.diff-review-completion-state' })).toBeInTheDocument();
    expect(putBodies[1]).toEqual({ revision: 'hunk-revision', hunks: [{ filePath: 'src/reviewed.ts', hunkRange: '@@ -10 +10 @@ secondBehavior' }], state: 'reviewed' });
    expect(await screen.findByLabelText('3 decisions across 1 file, 3 completed')).toHaveTextContent('3 completed');
  });

  it('attaches the decision and its hunks to the composer and records it as commented', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/follow-up.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false,
      patch: '@@ -1 +1 @@ followUpBehavior\n-before\n+after',
    };
    const putBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'follow-up-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.endsWith('/workspace-diff/hunk-reviews/batch') && init?.method === 'PUT') {
        putBodies.push(JSON.parse(String(init.body)));
        return json({ reviews: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const onFollowUp = vi.fn();
    renderView(fetchMock, false, onFollowUp);

    fireEvent.click(await screen.findByRole('button', { name: 'Request fix' }));

    await waitFor(() => expect(onFollowUp).toHaveBeenCalledTimes(1));
    const reference = onFollowUp.mock.calls[0][0] as DiffFollowUpReference;
    const text = formatDiffFollowUpReference(reference);
    expect(text).toContain('review decision 1');
    expect(text).toContain('src/follow-up.ts');
    expect(text).toContain('AI risk: not scored yet');
    expect(text).toContain('-before\n+after');
    expect(putBodies[0]).toEqual({ revision: 'follow-up-revision', hunks: [{ filePath: 'src/follow-up.ts', hunkRange: '@@ -1 +1 @@ followUpBehavior' }], state: 'commented' });
  });

  it('keeps the active decision in place and shows an actionable error when persistence fails', async () => {
    const file: WorkspaceDiffFile = { path: 'src/failure.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ failureBehavior\n-before\n+after' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file]) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.endsWith('/workspace-diff/hunk-reviews/batch') && init?.method === 'PUT') return json({ error: 'Database busy.' }, 503);
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByRole('heading', { name: 'Changes behavior in src/failure.ts.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this decision. Database busy.');
    expect(screen.getByRole('heading', { name: 'Changes behavior in src/failure.ts.' })).toBeInTheDocument();
  });

  it('opens the latest preserved version automatically when current Git changes are clean', async () => {
    const recordedFile: WorkspaceDiffFile = { path: 'src/preserved.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@ preservedBehavior\n+preserved' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: { ...workspaceDiff([], 'clean'), publish: { ...publish, hasChanges: false } } });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [{ id: 'recorded-version', revision: 'before-push', capturedAt: '2026-08-26T12:00:00.000Z', originatingAgentRunId: 'run-123', commitHash: 'abcdef0123456789', diff: workspaceDiff([recordedFile], 'before-push') }] });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByRole('heading', { name: 'Workspace review record' })).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace diff history')).toHaveValue('recorded-version');
    expect(screen.getByText(/Agent run run-123/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Adds behavior in src/preserved.ts.' })).toBeInTheDocument();
  });
});
