// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDiffView } from './view.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkspaceDiffView', () => {
  it('offers an orange refresh action when a newer workspace revision is detected without replacing the open patch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/work-items/work-item-1/workspace-diff') {
        return new Response(JSON.stringify({
          diff: {
            workspacePath: '/tmp/workbench', branch: 'review', revision: 'initial-revision', changedFiles: 1, additions: 1, deletions: 1,
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

    render(<QueryClientProvider client={client}><WorkspaceDiffView workItemId="work-item-1" isRunning /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Refresh changes' })).toHaveClass('workspace-diff-refresh-pending');
    expect(screen.getByText('+after')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /src\/old\.ts/ })).toBeInTheDocument();
  });
});
