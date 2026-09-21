// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { createReviewDirectorPlan } from '../../../shared/review-director.js';
import { useReviewDirectorEnrichment } from './use-review-director-enrichment.js';

function criticalPlan() {
  const file: WorkspaceDiffFile = {
    path: 'src/auth.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false,
    patch: '@@ -1 +1 @@ authorize\n-return deny(request);\n+return authorize(request);',
  };
  return createReviewDirectorPlan([file], []);
}

function Harness({ withTask = true }: { withTask?: boolean }) {
  const plan = criticalPlan();
  const progress = useReviewDirectorEnrichment({
    entries: plan.entries,
    decisions: plan.decisions,
    taskIntent: withTask ? { title: 'Protect authorization', description: 'Keep unauthorized callers out.' } : null,
    revision: 'pr-revision',
    enabled: true,
  });
  return <output data-score={[...progress.riskScores.values()][0] ?? ''}>{progress.completed}/{progress.total}/{progress.failed}</output>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('useReviewDirectorEnrichment', () => {
  it('prepares every critical field for a diff source the server cannot reconstruct', async () => {
    const requests: Array<{ url: string; taskIntent: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), taskIntent: (JSON.parse(String(init?.body)) as { taskIntent: unknown }).taskIntent });
      return new Response(JSON.stringify({ answers: { score_risk: 'prepared', explain: 'prepared', what_could_break: 'prepared', compare_task_intent: 'prepared' } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText('1/1/0')).toBeInTheDocument());
    expect(requests).toEqual([{ url: '/api/review-assist/critical', taskIntent: { title: 'Protect authorization', description: 'Keep unauthorized callers out.' } }]);
    expect(screen.getByText('1/1/0')).toHaveAttribute('data-score', 'prepared');
  });

  it('does not invent task alignment when no task is linked', async () => {
    const requests: Array<{ url: string; taskIntent: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), taskIntent: (JSON.parse(String(init?.body)) as { taskIntent: unknown }).taskIntent });
      return new Response(JSON.stringify({ answers: { score_risk: 'prepared', explain: 'prepared', what_could_break: 'prepared' } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><Harness withTask={false} /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText('1/1/0')).toBeInTheDocument());
    expect(requests).toEqual([{ url: '/api/review-assist/critical', taskIntent: null }]);
  });

  it('does not count a failed request as fully enriched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'provider unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText('0/1/1')).toBeInTheDocument());
  });
});
