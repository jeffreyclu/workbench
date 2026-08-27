// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubDiffView } from './view.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GitHubDiffView', () => {
  it('renders the shared summary strip for pull-request totals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ diff: {
      repository: 'writer/workbench', number: 42, title: 'Summary', url: 'https://github.com/writer/workbench/pull/42', baseRef: 'main', headRef: 'summary', changedFiles: 3, additions: 21, deletions: 8, files: [],
    } }), { headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><GitHubDiffView sourceUrl="https://github.com/writer/workbench/pull/42" references={[]} /></QueryClientProvider>);

    expect(await screen.findByLabelText('3 changed files, 21 additions, 8 deletions')).toBeInTheDocument();
  });

  it('shows a retry action instead of an empty-diff state when loading the pull-request diff fails', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Network unavailable');
      return new Response(JSON.stringify({ diff: { repository: 'writer/workbench', number: 42, title: 'Retry', url: 'https://github.com/writer/workbench/pull/42', baseRef: 'main', headRef: 'retry', changedFiles: 0, additions: 0, deletions: 0, files: [] } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><GitHubDiffView sourceUrl="https://github.com/writer/workbench/pull/42" references={[]} /></QueryClientProvider>);

    expect(await screen.findByText('Could not load this pull-request diff.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('GitHub reports no changed files for this pull request.')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('uses the shared compact file-picker structure that leaves the patch as the primary mobile pane', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/diff-confidence') {
        const keys = (JSON.parse(String(init?.body)) as { blocks: Array<{ key: string }> }).blocks.map((block) => block.key);
        return new Response(JSON.stringify({ assessments: Object.fromEntries(keys.map((key) => [key, { risk: 42, reasoning: 'The changed call has no visible error handling.' }])) }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        diff: {
          repository: 'writer/workbench', number: 42, title: 'Mobile diff review', url: 'https://github.com/writer/workbench/pull/42',
          baseRef: 'main', headRef: 'mobile-diff', changedFiles: 1, additions: 1, deletions: 1,
          files: [{ path: 'src/mobile.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }],
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><GitHubDiffView sourceUrl="https://github.com/writer/workbench/pull/42" references={[]} /></QueryClientProvider>);

    expect(await screen.findByLabelText('AI risk assessment: 42 out of 100')).toBeInTheDocument();
    expect(document.querySelector('.diff-line.addition')?.textContent).toContain('+after');
    expect(document.querySelector('.diff-review-layout > .diff-file-list')).toBeInTheDocument();
    expect(document.querySelector('.github-diff-file')).toBeInTheDocument();
  });

  it('switches between each linked pull request without showing a picker for one PR', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const pullRequest = new URL(String(input), 'http://localhost').searchParams.get('url')!.match(/pull\/(\d+)/)![1];
      return new Response(JSON.stringify({ diff: { repository: 'writer/workbench', number: Number(pullRequest), title: `Pull request ${pullRequest}`, url: `https://github.com/writer/workbench/pull/${pullRequest}`, baseRef: 'main', headRef: `branch-${pullRequest}`, changedFiles: 0, additions: 0, deletions: 0, files: [] } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { rerender } = render(<QueryClientProvider client={client}><GitHubDiffView sourceUrl="https://github.com/writer/workbench/pull/42" references={[]} /></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'Pull request 42' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Pull request')).not.toBeInTheDocument();

    rerender(<QueryClientProvider client={client}><GitHubDiffView sourceUrl="https://github.com/writer/workbench/pull/42" references={[{ id: 'reference-43', workItemId: 'work-item-1', type: 'pull_request', url: 'https://github.com/writer/workbench/pull/43', title: 'Related PR', createdAt: '2026-08-27T00:00:00.000Z' }]} /></QueryClientProvider>);
    fireEvent.change(await screen.findByLabelText('Pull request'), { target: { value: 'https://github.com/writer/workbench/pull/43' } });
    expect(await screen.findByRole('heading', { name: 'Pull request 43' })).toBeInTheDocument();
  });

  it('loads later file pages and provides image and GitHub fallbacks when GitHub omits a patch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const page = new URL(url, 'http://localhost').searchParams.get('page');
      const files = page === '2'
        ? [{ path: 'assets/second.png', previousPath: null, status: 'modified', additions: 0, deletions: 0, isBinary: true, patch: null }]
        : Array.from({ length: 100 }, (_, index) => ({ path: index === 0 ? 'assets/first.png' : `src/${index}.ts`, previousPath: null, status: 'modified', additions: 0, deletions: 0, isBinary: index === 0, patch: null }));
      return new Response(JSON.stringify({ diff: { repository: 'writer/workbench', number: 42, title: 'Large binary review', url: 'https://github.com/writer/workbench/pull/42', baseRef: 'main', headRef: 'large', changedFiles: 101, additions: 0, deletions: 0, nextPage: page === '2' ? null : 2, files } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><GitHubDiffView sourceUrl="https://github.com/writer/workbench/pull/42" references={[]} /></QueryClientProvider>);

    expect(await screen.findByRole('img', { name: 'Preview of assets/first.png' })).toHaveAttribute('src', expect.stringContaining('/api/github/pull-request-image?'));
    expect(screen.getByRole('link', { name: /View on GitHub/i })).toHaveAttribute('href', 'https://github.com/writer/workbench/pull/42/files');
    fireEvent.click(screen.getByRole('button', { name: 'Load 100 more files' }));
    expect(await screen.findByRole('button', { name: /assets\/second\.png/ })).toBeInTheDocument();
  });
});
