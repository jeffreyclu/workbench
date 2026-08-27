// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffHunkReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
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

function renderView(fetchMock: ReturnType<typeof vi.fn>, isRunning = false) {
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={isRunning} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView decision queue', () => {
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

  it('replaces raw diff and AI scores with a risk-ordered queue and exact decision details', async () => {
    const files: WorkspaceDiffFile[] = [
      { path: 'src/local.ts', editorUrl: 'vscode://file/tmp/workbench/src/local.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, isBinary: false, patch: '@@ -1 +1 @@ localOne\n-before\n+after\n@@ -10 +10 @@ localTwo\n-old\n+new' },
      { path: 'src/server/auth/routes.ts', previousPath: null, status: 'modified', additions: 3, deletions: 1, isBinary: false, patch: '@@ -20 +20,3 @@ authorizeRequest\n-export function authorizeRequest() {}\n+export async function authorizeRequest() {\n+  await repository.update(session)\n+  throw new Error("denied")' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: '/tmp/workbench', workspaces: [{ path: '/tmp/workbench', label: 'workbench', selected: true }] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff(files) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.includes('/workspace-diff/status?')) return json({ changed: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock, true);

    expect(await screen.findByLabelText('3 decisions across 2 files, 0 completed')).toHaveTextContent('3 decisions across 2 files');
    expect(screen.getByRole('button', { name: /Decision 1.*authorizeRequest/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('src/server/auth/routes.ts', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('@@ -20 +20,3 @@ authorizeRequest', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('Public API')).toBeInTheDocument();
    expect(screen.getByText('Persistence')).toBeInTheDocument();
    expect(screen.getByText('Auth')).toBeInTheDocument();
    expect(screen.getByText('Cross-file')).toBeInTheDocument();
    expect(screen.getByText('Error path')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh changes' })).toHaveClass('workspace-diff-refresh-pending');
    expect(document.querySelector('.diff-line')).not.toBeInTheDocument();
    expect(screen.queryByText('-export function authorizeRequest() {}')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/diff-confidence');

    const fileRail = screen.getByRole('navigation', { name: 'Review files by queue priority' });
    const fileButtons = within(fileRail).getAllByRole('button');
    expect(fileButtons[0]).toHaveTextContent('src/server/auth/routes.ts');
    fireEvent.click(within(fileRail).getByRole('button', { name: /src\/local\.ts/ }));
    expect(await screen.findByRole('link', { name: 'Open src/local.ts in editor' })).toHaveAttribute('href', 'vscode://file/tmp/workbench/src/local.ts');
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
      if (url.endsWith('/workspace-diff/hunk-reviews') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { revision: string; filePath: string; hunkRange: string; state: DiffHunkReview['state']; note?: string };
        putBodies.push(body);
        const saved: DiffHunkReview = { id: `review-${reviews.length + 1}`, ...body, note: body.note ?? null, updatedAt: '2026-08-27T00:00:00.000Z' };
        reviews = [...reviews.filter((review) => review.hunkRange !== body.hunkRange), saved];
        return json({ review: saved });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByRole('heading', { name: 'Changes firstBehavior in src/reviewed.ts.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('heading', { name: 'Changes secondBehavior in src/reviewed.ts.' })).toBeInTheDocument();
    expect(putBodies[0]).toEqual({ revision: 'hunk-revision', filePath: 'src/reviewed.ts', hunkRange: '@@ -1 +1 @@ firstBehavior', state: 'reviewed' });

    fireEvent.change(screen.getByLabelText(/Review note/), { target: { value: 'Handle the rollback path.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Needs changes' }));
    expect(await screen.findByRole('heading', { name: 'Changes thirdBehavior in src/reviewed.ts.' })).toBeInTheDocument();
    expect(screen.getByText('Commented', { selector: '.diff-review-completion-state' })).toBeInTheDocument();
    expect(screen.getByText('Existing context.', { selector: '.diff-review-saved-note p' })).toBeInTheDocument();
    expect(putBodies[1]).toEqual({ revision: 'hunk-revision', filePath: 'src/reviewed.ts', hunkRange: '@@ -10 +10 @@ secondBehavior', state: 'needs_changes', note: 'Handle the rollback path.' });
    expect(await screen.findByLabelText('3 decisions across 1 file, 3 completed')).toHaveTextContent('1 need changes');
  });

  it('keeps the active decision in place and shows an actionable error when persistence fails', async () => {
    const file: WorkspaceDiffFile = { path: 'src/failure.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@ failureBehavior\n-before\n+after' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: workspaceDiff([file]) });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      if (url.endsWith('/workspace-diff/hunk-reviews') && init?.method === 'PUT') return json({ error: 'Database busy.' }, 503);
      throw new Error(`Unexpected request: ${url}`);
    });
    renderView(fetchMock);

    expect(await screen.findByRole('heading', { name: 'Changes failureBehavior in src/failure.ts.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this decision. Database busy.');
    expect(screen.getByRole('heading', { name: 'Changes failureBehavior in src/failure.ts.' })).toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: 'Changes preservedBehavior in src/preserved.ts.' })).toBeInTheDocument();
  });
});
