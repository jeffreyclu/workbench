// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunReviewHandoff, DiffHunkReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { contentHashOfLines } from '../../../shared/review-decisions.js';
import { WorkspaceDiffView } from './view.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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
function renderView(fetchMock: ReturnType<typeof vi.fn>, isRunning = false, reviewHandoff?: AgentRunReviewHandoff | null, pullRequestUrlCandidates?: string[], onFixRequest?: (prompt: string) => void) {
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={isRunning} reviewHandoff={reviewHandoff} pullRequestUrlCandidates={pullRequestUrlCandidates} onFixRequest={onFixRequest} /></QueryClientProvider>);
}

/**
 * The decision detail card — its title, the AI assist and the review actions —
 * is popover content opened from a block's gutter marker, so a test that needs
 * any of it opens that popover explicitly. Selection itself stays readable
 * without opening anything: the selected queue chip carries `aria-current` and
 * the decision's behavior sentence in its accessible name.
 */
const selectedDecisionChip = () => screen.getByRole('button', { current: 'step' });
const findSelectedDecision = (behavior: string) => waitFor(() =>
  expect(selectedDecisionChip()).toHaveAccessibleName(new RegExp(behavior.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
const openDecisionDetail = async (ordinal: number) =>
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Decision ${ordinal} .*open decision details$`) }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView decision queue', () => {
  it('reports the full diff size as files, additions and deletions', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/large-change.ts', previousPath: null, status: 'modified', additions: 401, deletions: 27, isBinary: false,
      patch: '@@ -1 +1 @@ largeChange\n-before\n+after',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'large-401') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    const stat = await screen.findByRole('note', { name: 'Diff size' });
    expect(stat).toHaveTextContent('1 file changed');
    expect(stat).toHaveTextContent('+401');
    expect(stat).toHaveTextContent('−27');
    expect(stat).toHaveTextContent('428 changed lines');
  });

  it('moves through pending blocks and changed files, then marks the active block reviewed', async () => {
    const files: WorkspaceDiffFile[] = [
      {
        path: 'src/first.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false,
        patch: '@@ -1 +1 @@ firstChange\n-before\n+after\n@@ -10 +10 @@ secondChange\n-old\n+new',
      },
      {
        path: 'src/second.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false,
        patch: '@@ -1 +1 @@ thirdChange\n-before\n+after',
      },
    ];
    const writes: Array<{ state: string; hunks: Array<{ filePath: string }> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff(files, 'keyboard-flow') });
      if (url.endsWith('/workspace-diff/hunk-reviews/batch') && init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)) as { state: string; hunks: Array<{ filePath: string }> });
        return json({ reviews: [] });
      }
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    await screen.findByRole('navigation', { name: 'Review decision queue' });
    expect(screen.queryByRole('navigation', { name: 'Changes keyboard shortcuts' })).not.toBeInTheDocument();
    const selectedName = () => selectedDecisionChip().getAttribute('aria-label');
    expect(selectedName()).toMatch(/^Decision 1/);

    fireEvent.keyDown(document, { key: 'j' });
    await waitFor(() => expect(selectedName()).toMatch(/^Decision 2/));
    fireEvent.keyDown(document, { key: 'k' });
    await waitFor(() => expect(selectedName()).toMatch(/^Decision 1/));
    fireEvent.keyDown(document, { key: ']' });
    await waitFor(() => expect(selectedName()).toMatch(/^Decision 3/));
    fireEvent.keyDown(document, { key: '[' });
    await waitFor(() => expect(selectedName()).toMatch(/^Decision 1/));

    fireEvent.keyDown(document, { key: 'r' });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ state: 'reviewed', hunks: [{ filePath: 'src/first.ts' }] });
  });

  it('does not add phone-only decision navigation or a modal', async () => {
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

    expect(await screen.findByRole('navigation', { name: 'Review decision queue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous decision' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next decision' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View decision' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Decision details' })).toBeNull();
  });

  it('keeps the agentic handoff button visible without a linked run', async () => {
    const file: WorkspaceDiffFile = { path: 'src/app.ts', previousPath: null, status: 'modified', additions: 1, deletions: 0, isBinary: false, patch: '@@ -1 +1 @@\n+after' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file]) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, false, null);

    const trigger = await screen.findByRole('button', { name: 'Agentic handoff' });
    fireEvent.click(trigger);
    const handoff = screen.getByRole('dialog', { name: 'Agentic handoff' });
    expect(within(handoff).getByText('No handoff recorded')).toBeInTheDocument();
  });

  it('opens the styled agentic handoff modal on demand', async () => {
    const files: WorkspaceDiffFile[] = [{ path: 'src/app.ts', editorUrl: null, previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff(files) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, false, {
      agentRunId: 'run-1', formatVersion: 1, summary: 'Implemented the requested change.', changes: [], acceptanceCriteria: [], contractChanges: [], verification: [],
      uncertainties: ['No completed test, build, typecheck, or lint command was observed by the runner.'], tradeoffs: [], createdAt: '2026-08-27T01:00:00.000Z',
    });

    await screen.findByRole('navigation', { name: /review decision queue/i });
    const trigger = screen.getByRole('button', { name: 'Agentic handoff' });
    expect(trigger).toHaveClass('workspace-diff-handoff');
    expect(screen.queryByRole('dialog', { name: 'Agentic handoff' })).toBeNull();
    expect(screen.queryByText('Implemented the requested change.')).toBeNull();

    fireEvent.click(trigger);
    const handoff = screen.getByRole('dialog', { name: 'Agentic handoff' });
    expect(handoff).toHaveClass('review-handoff-dialog');
    expect(within(handoff).getByText('Implemented the requested change.')).toBeInTheDocument();

    fireEvent.click(within(handoff).getByRole('button', { name: 'Close agentic handoff' }));
    expect(screen.queryByRole('dialog', { name: 'Agentic handoff' })).toBeNull();
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

  it('automatically renders the latest recorded changes when the current checkout is clean', async () => {
    const recordedFile: WorkspaceDiffFile = {
      path: 'src/recovered.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false,
      patch: '@@ -1 +1 @@ recoveredBehavior\n-before\n+after',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [{ path: '/tmp/workbench', label: 'workbench', selected: true }] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([], 'clean-main') });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [{ id: 'recorded-run', capturedAt: '2026-08-28T12:40:02.798Z', originatingAgentRunId: 'run-1', commitHash: 'abcdef123456', diff: workspaceDiff([recordedFile], 'recorded-run') }] });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByRole('heading', { name: 'Workspace review record' })).toBeInTheDocument();
    const metadata = document.querySelector('.workspace-diff-record-metadata');
    expect(metadata).toHaveTextContent('review');
    expect(metadata).toHaveTextContent('Captured');
    expect(metadata).toHaveTextContent('Agent run run-1 · Commit abcdef123456');
    expect(metadata?.children).toHaveLength(3);
    expect(screen.getByLabelText('Full diff for src/recovered.ts')).toBeInTheDocument();
    expect(screen.queryByText('No uncommitted changes to review.')).toBeNull();
  });

  it('keeps the repository picker reachable on a clean checkout that has recorded versions', async () => {
    const repositoryA = '/tmp/repository-a';
    const repositoryB = '/tmp/repository-b';
    let selectedPath = repositoryA;
    const recordedFile: WorkspaceDiffFile = { path: 'src/recorded.ts', previousPath: null, status: 'modified', additions: 1, deletions: 0, isBinary: false, patch: '@@ -1 +1 @@\n+recorded' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath, workspaces: [{ path: repositoryA, label: 'repository-a' }, { path: repositoryB, label: 'repository-b' }] });
      if (url.endsWith('/workspaces/selection')) {
        selectedPath = JSON.parse(String(init?.body)).workspacePath;
        return json({ selectedPath, workspaces: [{ path: repositoryA, label: 'repository-a' }, { path: repositoryB, label: 'repository-b' }] });
      }
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [{ id: 'recorded-run', capturedAt: '2026-08-28T12:40:02.798Z', originatingAgentRunId: 'run-1', commitHash: 'abcdef123456', diff: workspaceDiff([recordedFile], 'recorded-run') }] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([]) });
      if (url.includes('/hunk-reviews')) return json({ reviews: [] });
      return json({});
    });
    renderView(fetchMock);

    // A clean checkout still opens on its recorded version...
    expect(await screen.findByRole('heading', { name: 'Workspace review record' })).toBeInTheDocument();
    // ...and the repository picker stays on screen there. Gating it on the
    // workspace source removed it from the tab entirely for exactly this case.
    const picker = await screen.findByLabelText('Workspace');
    expect(picker).toHaveValue(repositoryA);

    fireEvent.change(picker, { target: { value: repositoryB } });
    await waitFor(() => expect(screen.getByLabelText('Workspace')).toHaveValue(repositoryB));
    expect(screen.queryByRole('heading', { name: 'Workspace review record' })).not.toBeInTheDocument();
  });

  it('uses the server-selected repository after remount and never replays a stale local repository preference', async () => {
    const repositoryA = '/tmp/repository-a';
    const repositoryB = '/tmp/repository-b';
    let selectedPath = repositoryA;
    const repositoryADiff = workspaceDiff([{ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ repositoryAChange\n-before\n+after' }], 'repository-a');
    const repositoryBDiff = workspaceDiff([{ path: 'src/b.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ firstRepositoryBChange\n-before\n+after\n@@ -10 +10 @@ secondRepositoryBChange\n-before\n+after' }], 'repository-b');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath, workspaces: [{ path: repositoryA, label: 'repository-a' }, { path: repositoryB, label: 'repository-b' }] });
      if (url.endsWith('/workspaces/selection') && init?.method === 'PUT') {
        selectedPath = (JSON.parse(String(init.body)) as { workspacePath: string }).workspacePath;
        return json({ selectedPath, workspaces: [{ path: repositoryA, label: 'repository-a' }, { path: repositoryB, label: 'repository-b' }] });
      }
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: selectedPath === repositoryB ? repositoryBDiff : repositoryADiff });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    const picker = await screen.findByLabelText('Workspace');
    fireEvent.change(picker, { target: { value: repositoryB } });
    await findSelectedDecision('Changes behavior in src/b.ts.');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Review decision queue' })).getByRole('button', { name: /Decision 2/ }));

    cleanup();
    selectedPath = repositoryA;
    renderView(fetchMock);

    await waitFor(() => expect(screen.getByLabelText('Workspace')).toHaveValue(repositoryA));
    await findSelectedDecision('Changes behavior in src/a.ts.');
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/workspaces/selection') && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1);
  });

  it('keeps source order when decisions have no relationships, with no ambient AI scoring', async () => {
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
    expect(screen.getByRole('button', { name: /Decision 1.*local/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('src/local.ts', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decision 3.*risk signals/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh changes' })).toHaveClass('workspace-diff-refresh-pending');

    const decisionQueue = screen.getByRole('navigation', { name: 'Review decision queue' });
    const decisionButtons = within(decisionQueue).getAllByRole('button');
    expect(decisionButtons[0]).toHaveTextContent('local');
    fireEvent.click(within(decisionQueue).getByRole('button', { name: /Decision 3/ }));
    expect(await screen.findByLabelText('Full diff for src/server/auth/routes.ts')).toBeInTheDocument();
  });

  it('uses the selected file extension to syntax-highlight review diff lines', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/theme.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false,
      patch: '@@ -1 +1 @@ theme\n-const color = "old";\n+const color = "new";',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'syntax-highlight') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    const pane = await screen.findByLabelText('Full diff for src/theme.ts');
    expect(within(pane).getAllByText('const', { selector: '.token.keyword' })).toHaveLength(2);
    expect(within(pane).getByText('"new"', { selector: '.token.string' })).toBeInTheDocument();
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
      expect(diffPane).toHaveTextContent(line);
    }
    expect(diffPane.querySelectorAll('.diff-review-diff-block')).toHaveLength(2);
    expect(diffPane.querySelector('.diff-review-diff-block.active')).toHaveTextContent('@@ -1,3 +1,3 @@ firstBehavior');

    // Old and new line numbers are carried through, so the highlighted block is locatable in the file.
    const deletedLine = within(diffPane).getByText('before', { selector: '.diff-line-code' }).closest('.diff-line');
    expect(deletedLine).toHaveTextContent('2-before');

    fireEvent.click(screen.getByRole('button', { name: /Decision 2.*behavior/ }));
    expect(diffPane.querySelector('.diff-review-diff-block.active')).toHaveTextContent('@@ -10,3 +10,3 @@ secondBehavior');
    expect(selectedDecisionChip()).toHaveAccessibleName(/Changes behavior in src\/local\.ts\./);

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
      if (url.endsWith('/api/review-assist/lookup')) return json({ answer: null });
      if (url.endsWith('/api/review-assist/stream')) return sse([
        { type: 'delta', text: 'This decision only touches ' },
        { type: 'delta', text: 'local formatting.' },
        { type: 'done', answer: 'This decision only touches local formatting.' },
      ]);
      throw new Error(`Unexpected request: ${url} ${init?.method ?? ''}`);
    });
    renderView(fetchMock);

    await findSelectedDecision('Changes behavior in src/local.ts.');
    await openDecisionDetail(1);
    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));
    await screen.findByText('This decision only touches local formatting.');

    await openDecisionDetail(2);
    expect(screen.queryByText('This decision only touches local formatting.')).toBeNull();
  });

  it('persists exact hunk outcomes and auto-advances after each decision', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/reviewed.ts', previousPath: null, status: 'modified', additions: 3, deletions: 3, isBinary: false,
      patch: '@@ -1 +1 @@ firstBehavior\n-a\n+b\n@@ -10 +10 @@ secondBehavior\n-c\n+d\n@@ -20 +20 @@ thirdBehavior\n-e\n+f',
    };
    let reviews: DiffHunkReview[] = [{ id: 'review-3', revision: 'hunk-revision', filePath: file.path, hunkRange: '@@ -20 +20 @@ thirdBehavior', contentHash: contentHashOfLines(['-e', '+f']), state: 'commented', note: 'Existing context.', updatedAt: '2026-08-27T00:00:00.000Z' }];
    const putBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'hunk-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews });
      if (url.endsWith('/workspace-diff/hunk-reviews/batch') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { revision: string; hunks: Array<{ filePath: string; hunkRange: string; contentHash: string }>; state: DiffHunkReview['state']; note?: string };
        putBodies.push(body);
        const saved = body.hunks.map((hunk, index): DiffHunkReview => ({ id: `review-${reviews.length + index + 1}`, revision: body.revision, ...hunk, state: body.state, note: body.note ?? null, updatedAt: '2026-08-27T00:00:00.000Z' }));
        reviews = [...reviews.filter((review) => !body.hunks.some((hunk) => hunk.filePath === review.filePath && hunk.hunkRange === review.hunkRange)), ...saved];
        return json({ reviews: saved });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    await findSelectedDecision('Changes behavior in src/reviewed.ts.');
    await openDecisionDetail(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(selectedDecisionChip()).toHaveAccessibleName(/^Decision 2/));
    expect(putBodies[0]).toEqual({ revision: 'hunk-revision', hunks: [{ filePath: 'src/reviewed.ts', hunkRange: '@@ -1 +1 @@ firstBehavior', contentHash: contentHashOfLines(['-a', '+b']) }], state: 'reviewed' });

    await openDecisionDetail(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(selectedDecisionChip()).toHaveAccessibleName(/^Decision 3/));
    expect(within(screen.getByRole('navigation', { name: 'Review decision queue' })).getByRole('button', { name: /Decision 1.*Approved/ })).toBeInTheDocument();
    expect(putBodies[1]).toEqual({ revision: 'hunk-revision', hunks: [{ filePath: 'src/reviewed.ts', hunkRange: '@@ -10 +10 @@ secondBehavior', contentHash: contentHashOfLines(['-c', '+d']) }], state: 'reviewed' });
    expect(await screen.findByLabelText('3 decisions across 1 file, 3 completed')).toHaveTextContent('3 completed');
  });

  it('moves to the next change on skip without recording a verdict, and hands a change to the composer on fix', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/skipped.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false,
      patch: '@@ -1 +1 @@ firstBehavior\n-a\n+b\n@@ -10 +10 @@ secondBehavior\n-c\n+d',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'skip-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.endsWith('/workspace-diff/hunk-reviews/batch') && init?.method === 'PUT') throw new Error('Skip must not record a verdict');
      throw new Error(`Unexpected request: ${url}`);
    });
    const fixRequests: string[] = [];
    renderView(fetchMock, false, null, undefined, (prompt) => fixRequests.push(prompt));

    await findSelectedDecision('Changes behavior in src/skipped.ts.');
    await openDecisionDetail(1);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(selectedDecisionChip()).toHaveAccessibleName(/^Decision 2/));
    // Skipping leaves the work owed: nothing was persisted and the queue still
    // counts the skipped change as unreviewed.
    expect(await screen.findByLabelText('2 decisions across 1 file, 0 completed')).toBeInTheDocument();

    await openDecisionDetail(2);
    fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(fixRequests).toHaveLength(1);
    expect(fixRequests[0]).toContain('src/skipped.ts');
    expect(fixRequests[0]).toContain('@@ -10 +10 @@ secondBehavior');
    expect(fixRequests[0]).toContain('+d');
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

    await findSelectedDecision('Changes behavior in src/failure.ts.');
    await openDecisionDetail(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this decision. Database busy.');
    // The popover stays anchored to the failed decision so the reviewer can retry it in place.
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
    expect(selectedDecisionChip()).toHaveAccessibleName(/Adds behavior in src\/preserved\.ts\./);
  });
});

describe('WorkspaceDiffView pull-request source', () => {
  const pullRequestUrl = 'https://github.com/acme/web/pull/42';
  const pullRequestDiff = (page: number, nextPage: number | null) => ({
    url: pullRequestUrl, repository: 'acme/web', number: 42, title: 'Selectable scopes',
    baseRef: 'main', headRef: 'feature', headSha: 'sha-42', revision: 'sha-42',
    files: [{ path: `src/page-${page}.ts`, previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ scopeChange\n-before\n+after' }],
    changedFiles: 1, additions: 1, deletions: 1, nextPage,
  });

  it('offers a linked pull request as an explicit review source and records decisions against its head commit', async () => {
    const file: WorkspaceDiffFile = { path: 'src/local.ts', editorUrl: null, previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ localChange\n-before\n+after' };
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${String(init.body)}` : ''}`);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [{ path: '/tmp/workbench', label: 'workbench' }] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'local-revision') });
      if (url.includes('/hunk-reviews/batch')) return json({ reviews: [] });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.includes('/api/github/pull-request-diff')) return json({ diff: pullRequestDiff(1, null) });
      if (url.includes('/api/review-auto-score')) return json({ scores: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, false, null, [pullRequestUrl]);

    await findSelectedDecision('Changes behavior in src/local.ts.');
    fireEvent.click(screen.getByRole('button', { name: 'GitHub PR' }));
    const picker = await screen.findByLabelText('Pull request');
    expect(within(picker).getByRole('option', { name: 'acme/web #42' })).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: pullRequestUrl } });

    await findSelectedDecision('Changes behavior in src/page-1.ts.');
    expect(screen.getByRole('heading', { name: 'Selectable scopes' })).toBeInTheDocument();
    expect(selectedDecisionChip()).not.toHaveAccessibleName(/src\/local\.ts/);

    await openDecisionDetail(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));

    await waitFor(() => expect(requests.some((request) => request.startsWith('PUT') && request.includes('/hunk-reviews/batch') && request.includes('"revision":"sha-42"'))).toBe(true));
  });

  it('restores the selected repository and decision after the Changes view remounts', async () => {
    const persistedPullRequestDiff = {
      ...pullRequestDiff(1, null),
      files: [
        { path: 'src/page-one.ts', previousPath: null, status: 'modified' as const, additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ firstScopeChange\n-before\n+after' },
        { path: 'src/page-two.ts', previousPath: null, status: 'modified' as const, additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ secondScopeChange\n-before\n+after' },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [{ path: '/tmp/workbench', label: 'workbench' }] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([], 'clean-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.includes('/api/github/pull-request-diff')) return json({ diff: persistedPullRequestDiff });
      if (url.includes('/api/review-auto-score')) return json({ scores: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, false, null, [pullRequestUrl]);

    fireEvent.click(await screen.findByRole('button', { name: 'GitHub PR' }));
    const picker = await screen.findByLabelText('Pull request');
    fireEvent.change(picker, { target: { value: pullRequestUrl } });
    await findSelectedDecision('Changes behavior in src/page-one.ts.');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Review decision queue' })).getByRole('button', { name: /Decision 2/ }));

    cleanup();
    renderView(fetchMock, false, null, [pullRequestUrl]);

    expect(await screen.findByRole('heading', { name: 'Selectable scopes' })).toBeInTheDocument();
    expect(screen.getByLabelText('Pull request')).toHaveValue(pullRequestUrl);
    expect(within(screen.getByRole('navigation', { name: 'Review decision queue' })).getByRole('button', { name: /Decision 2/ })).toHaveAttribute('aria-current', 'step');
  });

  it('opens the linked pull request when the local checkout has nothing to review', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [{ path: '/tmp/workbench', label: 'workbench' }] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([], 'clean-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.includes('/api/github/pull-request-diff')) return json({ diff: pullRequestDiff(1, 2) });
      if (url.includes('/api/review-auto-score')) return json({ scores: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, false, null, [pullRequestUrl]);

    await findSelectedDecision('Changes behavior in src/page-1.ts.');
    // Paged pull requests keep their explicit load-more control in the queue.
    expect(screen.getByRole('button', { name: 'Load 100 more files' })).toBeInTheDocument();
  });

  it('accepts a pasted GitHub pull-request URL without a prior task reference', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([], 'clean-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.includes('/api/github/pull-request-diff')) return json({ diff: pullRequestDiff(1, null) });
      if (url.includes('/api/review-auto-score')) return json({ scores: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'GitHub PR' }));
    fireEvent.change(screen.getByLabelText('Pull request URL'), { target: { value: pullRequestUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Review PR' }));

    expect(await screen.findByRole('heading', { name: 'Selectable scopes' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open on GitHub/i })).toHaveAttribute('href', pullRequestUrl);
  });

  /** The diagram is popover content: it lived as a component with passing unit
   * tests while no caller mounted it, so this asserts it from the view. */
  it('opens the related-changes diagram beside the decision popover', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/related.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false,
      patch: '@@ -1 +1 @@ function render(scale)\n-const a = 1\n+const a = render(scale)\n@@ -10 +10 @@ function render(scale)\n-const b = 2\n+const b = render(scale)',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file]) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    await waitFor(() => expect(selectedDecisionChip()).toBeInTheDocument());
    await openDecisionDetail(1);
    const popover = await screen.findByRole('dialog', { name: /./ });
    expect(within(popover).getByRole('region', { name: 'Related changes for this decision' })).toBeInTheDocument();
  });
});

describe('WorkspaceDiffView readings and settled changes', () => {
  it('cycles the reading from the diff to the finished code to the whole file', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/reading.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false,
      patch: '@@ -1 +1 @@ readingChange\n-  return before()\n+  return after()',
    };
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'reading-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.includes('/workspace-diff/file?')) return json({ file: { path: file.path, revision: null, content: '  return after()\n', unavailable: null } });
      return json({}, 404);
    });
    renderView(fetchMock);

    // Changes keeps the unified diff as its default reading.
    expect(await screen.findByRole('button', { name: 'Diff' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'd' });
    expect(await screen.findByRole('button', { name: 'Final code' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'd' });
    expect(await screen.findByRole('button', { name: 'Whole file' })).toBeInTheDocument();
    await waitFor(() => expect(requested.some((url) => url.includes('/workspace-diff/file?path=src%2Freading.ts'))).toBe(true));
  });

  it('collapses a change that already carries a verdict and counts what is still owed', async () => {
    const file: WorkspaceDiffFile = {
      path: 'src/settled.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false,
      patch: '@@ -1 +1 @@ answeredChange\n-  return before()\n+  return after()\n@@ -20 +20 @@ owedChange\n-  send(old)\n+  send(next)',
    };
    const reviews: DiffHunkReview[] = [{
      id: 'review-1', revision: 'settled-revision', filePath: file.path, hunkRange: '@@ -1 +1 @@ answeredChange',
      contentHash: contentHashOfLines(['-  return before()', '+  return after()']), state: 'reviewed', note: null, updatedAt: '2026-08-30T00:00:00.000Z',
    }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file], 'settled-revision') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews });
      return json({}, 404);
    });
    renderView(fetchMock);

    // The answered change stops costing reading time: it collapses behind a
    // control that says why, and the counts still owe the other one.
    expect(await screen.findByRole('button', { name: /Show the diff for .* — Approved$/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/of 2 answered/)).toHaveTextContent('1 of 2 answered'));
  });
});

describe('WorkspaceDiffView cross-file decisions', () => {
  it('renders every file a single decision spans, not just the first', async () => {
    // Both files add the same identifier, so the subject grouping folds them
    // into one cross-file decision. Reading only `filePaths[0]` used to render
    // one diff under a header that counted all of them.
    const files: WorkspaceDiffFile[] = ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'].map((path) => ({
      path, previousPath: null, status: 'added' as const, additions: 1, deletions: 0, isBinary: false,
      patch: '@@ -0,0 +1 @@\n+export function sharedHelper() { return 1; }',
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff(files, 'cross-file') });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByLabelText('Full diff for src/alpha.ts')).toBeInTheDocument();
    expect(screen.getByLabelText('Full diff for src/beta.ts')).toBeInTheDocument();
    expect(screen.getByLabelText('Full diff for src/gamma.ts')).toBeInTheDocument();
    expect(await screen.findByLabelText(/1 decision across 3 files/)).toBeInTheDocument();
  });
});
