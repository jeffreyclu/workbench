// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDiffView } from './view.js';
import type { DiffHunkReview } from '../../../shared/contracts.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView', () => {
  it('shows a retry action instead of an empty-diff state when loading the workspace diff fails', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspace-diff/snapshots')) return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/workspace-diff')) {
        attempts += 1;
        if (attempts === 1) throw new Error('Network unavailable');
        return new Response(JSON.stringify({ diff: { workspacePath: '/tmp/workbench', branch: 'review', revision: 'retry', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [] } }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByText('Could not load local workspace changes.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No uncommitted changes to review.')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('offers an orange refresh action when a newer workspace revision is detected without replacing the open patch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/diff-confidence') {
        const keys = (JSON.parse(String(init?.body)) as { blocks: Array<{ key: string }> }).blocks.map((block) => block.key);
        return new Response(JSON.stringify({ assessments: Object.fromEntries(keys.map((key) => [key, { risk: 42, reasoning: 'The changed call has no visible error handling.' }])) }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') {
        return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items/work-item-1/workspace-diff') {
        return new Response(JSON.stringify({
          diff: {
            workspacePath: '/tmp/workbench', branch: 'review', revision: 'initial-revision', changedFiles: 1, additions: 1, deletions: 1,
            publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
            files: [{ path: 'src/old.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }],
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('/api/work-items/work-item-1/workspace-diff/status')) {
        return new Response(JSON.stringify({ changed: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Refresh changes' })).toHaveClass('workspace-diff-refresh-pending');
    expect(document.querySelector('.diff-line.addition')?.textContent).toContain('+after');
    expect(screen.getByRole('button', { name: /src\/old\.ts/ })).toBeInTheDocument();
    expect(document.querySelector('.diff-review-layout > .diff-file-list')).toBeInTheDocument();
    expect(await screen.findByLabelText('AI risk assessment: 42 out of 100')).toBeInTheDocument();
  });

  it('adds the selected logical block and its reasoning to a follow-up', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/diff-confidence') {
        const keys = (JSON.parse(String(init?.body)) as { blocks: Array<{ key: string }> }).blocks.map((block) => block.key);
        return new Response(JSON.stringify({ assessments: Object.fromEntries(keys.map((key) => [key, { risk: 42, reasoning: 'The changed call has no visible error handling.' }])) }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/workspace-diff/snapshots')) return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/workspace-diff')) return new Response(JSON.stringify({ diff: {
        workspacePath: '/tmp/workbench', branch: 'review', revision: 'follow-up', changedFiles: 1, additions: 1, deletions: 1,
        publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
        files: [{ path: 'src/follow-up.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }],
      } }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const onFollowUp = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} onFollowUp={onFollowUp} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'AI risk assessment: 42 out of 100' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    expect(onFollowUp).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'src/follow-up.ts', assessment: { risk: 42, reasoning: 'The changed call has no visible error handling.' }, lines: expect.arrayContaining([expect.objectContaining({ text: '+after', kind: 'addition' })]) }));
  });

  it('commits and pushes reviewed changes, then refreshes the snapshot', async () => {
    let diffCalls = 0;
    let resolvePublish: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/work-items/work-item-1/workspace-diff') {
        diffCalls += 1;
        return new Response(JSON.stringify({ diff: {
          workspacePath: '/tmp/workbench', branch: 'review', revision: `revision-${diffCalls}`, changedFiles: diffCalls === 1 ? 1 : 0, additions: 1, deletions: 0,
          publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: diffCalls === 1, reason: null },
          files: diffCalls === 1 ? [{ path: 'src/new.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+new' }] : [],
        } }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items/work-item-1/workspace-diff/commit-and-push' && init?.method === 'POST') return new Promise<Response>((resolve) => { resolvePublish = resolve; });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Commit & push' }));
    expect(await screen.findByRole('button', { name: 'Publishing…' })).toBeDisabled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/work-items/work-item-1/workspace-diff/commit-and-push', expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 'revision-1', message: 'chore: update' }) })));
    resolvePublish!(new Response(JSON.stringify({ result: { committed: true, pushed: true, commit: 'abc1234' } }), { headers: { 'Content-Type': 'application/json' } }));
    expect(await screen.findByText('Committed and pushed abc1234.')).toBeInTheDocument();
    expect(await screen.findByText('No uncommitted changes to review.')).toBeInTheDocument();
  });

  it('uses disabled and retry-push states when publishing is not currently safe', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const workItemId = String(input).includes('work-item-running') ? 'running' : String(input).includes('work-item-ahead') ? 'ahead' : 'clean';
      if (String(input).endsWith('/workspace-diff/snapshots')) return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      const diff = workItemId === 'ahead'
        ? { workspacePath: '/tmp/workbench', branch: 'review', revision: 'ahead', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'review', hasOrigin: true, ahead: 2, hasChanges: false, reason: null }, files: [] }
        : { workspacePath: '/tmp/workbench', branch: 'review', revision: workItemId, changedFiles: workItemId === 'running' ? 1 : 0, additions: 0, deletions: 0, publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: workItemId === 'running', reason: null }, files: [] };
      return new Response(JSON.stringify({ diff }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { rerender } = render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-running' }} isRunning /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: 'Agent running' })).toBeDisabled();
    rerender(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-clean' }} isRunning={false} /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: 'No changes to commit' })).toBeDisabled();
    rerender(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-ahead' }} isRunning={false} /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: 'Push 2 commits' })).toBeEnabled();
  });

  it('shows a preserved diff version after commit leaves the current workspace clean', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/work-items/work-item-1/workspace-diff') return new Response(JSON.stringify({ diff: {
        workspacePath: '/tmp/workbench', branch: 'main', revision: 'clean', changedFiles: 0, additions: 0, deletions: 0,
        publish: { branch: 'main', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [],
      } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') return new Response(JSON.stringify({ snapshots: [{
        id: 'recorded-version', revision: 'before-push', capturedAt: '2026-08-26T12:00:00.000Z', diff: {
          workspacePath: '/tmp/workbench', branch: 'main', revision: 'before-push', changedFiles: 1, additions: 1, deletions: 0,
          publish: { branch: 'main', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
          files: [{ path: 'src/preserved.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+preserved' }],
        },
      }] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/diff-confidence') return new Response(JSON.stringify({ assessments: {} }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    const version = await screen.findByLabelText('Workspace diff version');
    fireEvent.change(version, { target: { value: 'recorded-version' } });
    expect(await screen.findByRole('heading', { name: 'Workspace diff record' })).toBeInTheDocument();
    expect(document.querySelector('.diff-line.addition')?.textContent).toContain('+preserved');
    expect(screen.getByText(/This record is preserved after commit and push/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No changes to commit' })).toBeDisabled();
  });

  it('compares two immutable snapshots and shows their recorded provenance', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/work-items/work-item-1/workspace-diff') return new Response(JSON.stringify({ diff: {
        workspacePath: '/tmp/workbench', branch: 'main', revision: 'clean', changedFiles: 0, additions: 0, deletions: 0,
        publish: { branch: 'main', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [],
      } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') return new Response(JSON.stringify({ snapshots: [
        { id: 'after-run', revision: 'after', capturedAt: '2026-08-26T13:00:00.000Z', originatingAgentRunId: 'run-after-123456', commitHash: 'abcdef0123456789', diff: {
          workspacePath: '/tmp/workbench', branch: 'main', revision: 'after', changedFiles: 2, additions: 2, deletions: 0, publish: { branch: 'main', hasOrigin: false, ahead: 0, hasChanges: false, reason: null },
          files: [{ path: 'src/unchanged.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+same' }, { path: 'src/new.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+new' }],
        } },
        { id: 'before-run', revision: 'before', capturedAt: '2026-08-26T12:00:00.000Z', originatingAgentRunId: 'run-before-1234', commitHash: '0123456789abcdef', diff: {
          workspacePath: '/tmp/workbench', branch: 'main', revision: 'before', changedFiles: 1, additions: 1, deletions: 0, publish: { branch: 'main', hasOrigin: false, ahead: 0, hasChanges: false, reason: null },
          files: [{ path: 'src/unchanged.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+same' }],
        } },
      ] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items/work-item-1/workspace-diff/hunk-reviews')) return new Response(JSON.stringify({ reviews: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/diff-confidence') return new Response(JSON.stringify({ assessments: {} }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByText(/Agent run run-after-123456/)).toBeInTheDocument();
    expect(screen.getByText(/Commit abcdef012345/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Compare snapshot against'), { target: { value: 'before-run' } });
    expect(await screen.findByRole('heading', { name: 'Changes between snapshots' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /src\/new\.ts/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /src\/unchanged\.ts/ })).not.toBeInTheDocument();
  });

  it('shows hunk review badges and saves a new review state on click', async () => {
    let putBody: unknown;
    let savedReview: DiffHunkReview | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/diff-confidence') return new Response(JSON.stringify({ assessments: {} }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff') return new Response(JSON.stringify({ diff: {
        workspacePath: '/tmp/workbench', branch: 'review', revision: 'hunk-revision', changedFiles: 1, additions: 1, deletions: 1,
        publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
        files: [{ path: 'src/reviewed.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }],
      } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items/work-item-1/workspace-diff/hunk-reviews') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ reviews: savedReview ? [savedReview] : [] }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items/work-item-1/workspace-diff/hunk-reviews' && init?.method === 'PUT') {
        putBody = JSON.parse(String(init.body));
        savedReview = { id: 'review-1', revision: 'hunk-revision', filePath: 'src/reviewed.ts', hunkRange: '@@ -1 +1 @@', state: 'reviewed', note: null, updatedAt: '2026-08-26T00:00:00.000Z' };
        return new Response(JSON.stringify({ review: savedReview }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Reviewed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));

    await waitFor(() => expect(putBody).toEqual({ filePath: 'src/reviewed.ts', hunkRange: '@@ -1 +1 @@', state: 'reviewed', revision: 'hunk-revision' }));
    await waitFor(async () => expect(await screen.findByRole('button', { name: 'Reviewed' })).toHaveClass('diff-hunk-review-badge', 'diff-hunk-review-badge-reviewed', 'active'));
    expect(await screen.findByPlaceholderText('Add a note…')).toBeInTheDocument();
  });

  it('opens the latest preserved version automatically when current Git changes are clean', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/work-items/work-item-1/workspace-diff') return new Response(JSON.stringify({ diff: {
        workspacePath: '/tmp/workbench', branch: 'main', revision: 'clean', changedFiles: 0, additions: 0, deletions: 0,
        publish: { branch: 'main', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [],
      } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') return new Response(JSON.stringify({ snapshots: [{
        id: 'recorded-version', revision: 'commit:abc1234', capturedAt: '2026-08-26T12:00:00.000Z', diff: {
          workspacePath: '/tmp/workbench', branch: 'main', revision: 'commit:abc1234', changedFiles: 1, additions: 1, deletions: 0,
          publish: { branch: 'main', hasOrigin: false, ahead: 0, hasChanges: false, reason: null },
          files: [{ path: 'src/preserved.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+preserved' }],
        },
      }] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/diff-confidence') return new Response(JSON.stringify({ assessments: {} }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Workspace diff record' })).toBeInTheDocument();
    expect(document.querySelector('.diff-line.addition')?.textContent).toContain('+preserved');
    expect(screen.getByLabelText('Workspace diff version')).toHaveValue('recorded-version');
  });

  it('expands hunk context on request and suppresses hunk review controls while it is active', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/diff-confidence') return new Response(JSON.stringify({ assessments: {} }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items/work-item-1/workspace-diff/hunk-reviews')) return new Response(JSON.stringify({ reviews: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff') return new Response(JSON.stringify({ diff: {
        workspacePath: '/tmp/workbench', branch: 'review', revision: 'context-revision', changedFiles: 1, additions: 1, deletions: 1,
        publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
        files: [{ path: 'src/context.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }],
      } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items/work-item-1/workspace-diff/file')) {
        expect(url).toContain('filePath=src%2Fcontext.ts');
        expect(url).toContain('context=8');
        return new Response(JSON.stringify({ patch: '@@ -1,5 +1,5 @@\n context line\n-before\n+after\n more context\n' }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Reviewed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+5 lines' }));

    expect(await screen.findByText('context line')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reviewed' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Default context' }));
    expect(await screen.findByRole('button', { name: 'Reviewed' })).toBeInTheDocument();
  });
});
