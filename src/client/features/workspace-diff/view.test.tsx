// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDiffView } from './view.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView', () => {
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
    expect(screen.getByText('+after')).toBeInTheDocument();
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/work-items/work-item-1/workspace-diff/commit-and-push', expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 'revision-1' }) })));
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
    expect(screen.getByText('+preserved')).toBeInTheDocument();
    expect(screen.getByText(/This record is preserved after commit and push/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No changes to commit' })).toBeDisabled();
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
    expect(screen.getByText('+preserved')).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace diff version')).toHaveValue('recorded-version');
  });
});
