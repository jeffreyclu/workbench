// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubDiffView } from './view.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GitHubDiffView', () => {
  it('uses the shared compact file-picker structure that leaves the patch as the primary mobile pane', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      diff: {
        repository: 'writer/workbench', number: 42, title: 'Mobile diff review', url: 'https://github.com/writer/workbench/pull/42',
        baseRef: 'main', headRef: 'mobile-diff', changedFiles: 1, additions: 1, deletions: 1,
        files: [{ path: 'src/mobile.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }],
      },
    }), { headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><GitHubDiffView sourceUrl="https://github.com/writer/workbench/pull/42" references={[]} /></QueryClientProvider>);

    expect(await screen.findByText('+after')).toBeInTheDocument();
    expect(document.querySelector('.diff-review-layout > .diff-file-list')).toBeInTheDocument();
    expect(document.querySelector('.github-diff-file')).toBeInTheDocument();
  });
});
