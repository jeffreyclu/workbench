// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDiffView } from './view.js';

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
            files: [{ path: 'src/old.ts', editorUrl: 'vscode://file/tmp/workbench/src/old.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }],
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
    expect(screen.getByRole('link', { name: 'Open src/old.ts in editor' })).toHaveAttribute('href', 'vscode://file/tmp/workbench/src/old.ts');
    expect(document.querySelector('.diff-review-layout > .diff-file-list')).toBeInTheDocument();
    expect(screen.getByLabelText('1 changed files, 1 additions, 1 deletions')).toBeInTheDocument();
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

    const version = await screen.findByLabelText('Workspace diff history');
    fireEvent.change(version, { target: { value: 'recorded-version' } });
    expect(await screen.findByRole('heading', { name: 'Workspace diff record' })).toBeInTheDocument();
    expect(document.querySelector('.diff-line.addition')?.textContent).toContain('+preserved');
    expect(screen.getByText(/This record is preserved in the history/)).toBeInTheDocument();
  });

  it('selects a recorded history entry and shows its provenance', async () => {
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
      if (url === '/api/diff-confidence') return new Response(JSON.stringify({ assessments: {} }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByText(/Agent run run-after-123456/)).toBeInTheDocument();
    expect(screen.getByText(/Commit abcdef012345/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Workspace diff history'), { target: { value: 'before-run' } });
    expect(await screen.findByRole('heading', { name: 'Workspace diff record' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Compare snapshot against')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /src\/unchanged\.ts/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /src\/new\.ts/ })).not.toBeInTheDocument();
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
    expect(screen.getByLabelText('Workspace diff history')).toHaveValue('recorded-version');
  });

  it('sorts the file nav by max block risk descending and shows a risk badge per file', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/diff-confidence') {
        const keys = (JSON.parse(String(init?.body)) as { blocks: Array<{ key: string }> }).blocks.map((block) => block.key);
        return new Response(JSON.stringify({ assessments: Object.fromEntries(keys.map((key) => [key, { risk: key.startsWith('src/low-risk.ts') ? 5 : 90, reasoning: 'Assessed.' }])) }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff') return new Response(JSON.stringify({
        diff: {
          workspacePath: '/tmp/workbench', branch: 'review', revision: 'risk-sort', changedFiles: 2, additions: 2, deletions: 2,
          publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
          files: [
            { path: 'src/low-risk.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' },
            { path: 'src/high-risk.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' },
          ],
        },
      }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByLabelText('File AI risk assessment: 90 out of 100')).toBeInTheDocument();
    expect(screen.getByLabelText('File AI risk assessment: 5 out of 100')).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: /src\/(low|high)-risk\.ts/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('src/high-risk.ts'),
      expect.stringContaining('src/low-risk.ts'),
    ]);
  });

  it('shows a diff-level flagged-block count and jumps into the flagged file on click', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/diff-confidence') {
        const keys = (JSON.parse(String(init?.body)) as { blocks: Array<{ key: string }> }).blocks.map((block) => block.key);
        return new Response(JSON.stringify({ assessments: Object.fromEntries(keys.map((key) => [key, { risk: key.startsWith('src/flagged.ts') ? 90 : 5, reasoning: 'Assessed.' }])) }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items/work-item-1/workspace-diff/snapshots') return new Response(JSON.stringify({ snapshots: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/work-item-1/workspace-diff') return new Response(JSON.stringify({
        diff: {
          workspacePath: '/tmp/workbench', branch: 'review', revision: 'flag-jump', changedFiles: 2, additions: 2, deletions: 2,
          publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
          files: [
            { path: 'src/safe.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' },
            { path: 'src/flagged.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' },
          ],
        },
      }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);

    expect(await screen.findByLabelText('2 changed files, 2 additions, 2 deletions, 1 block flagged high-risk')).toBeInTheDocument();
    // The risk-sorted nav opens on src/flagged.ts by default; switch to src/safe.ts so the jump has to change files.
    fireEvent.click(screen.getByRole('button', { name: /src\/safe\.ts/ }));
    expect(await screen.findByRole('heading', { name: 'Current workspace changes' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next flagged block' }));

    expect(await screen.findByRole('button', { name: /src\/flagged\.ts/ })).toHaveClass('selected');
  });
});
