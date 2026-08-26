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
});
