// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightsView } from './insights';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function emptyTotals() { return { inputTokens: 0, outputTokens: 0, setTokens: 0, runCount: 0 }; }
const emptyWeeklyUsage = {
  weekStart: '2026-08-17T00:00:00.000Z', weekEnd: '2026-08-24T00:00:00.000Z', autonomousSliceFraction: 0.2, autonomousTargetFraction: 0.16,
  claude: { workbench: { manual: emptyTotals(), autonomous: emptyTotals() }, interactive: { setTokens: 0, scannedFiles: 0, unreadableFiles: 0 }, ceilingSet: 333_000_000, calibration: null },
  codex: { workbench: { manual: emptyTotals(), autonomous: emptyTotals() }, rateLimit: null, ceilingSet: null, calibration: null },
};

/** Routes the stubbed fetch by URL so the weekly-usage dial's own request doesn't get the insights payload by mistake. */
function stubInsightsFetch(insightsPayload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    const body = url.includes('/api/usage/weekly') ? emptyWeeklyUsage : insightsPayload;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('InsightsView', () => {
  it('renders token totals grouped by provider and model', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 1_200, outputTokens: 300,
      tokenUsageByModel: [{ provider: 'codex', model: 'gpt-5.6-terra', inputTokens: 1_200, outputTokens: 300 }],
      cursing: { total: 0, messagesAnalyzed: 1, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: /token usage/i })).toBeTruthy();
    expect(screen.getByText('gpt-5.6-terra')).toBeTruthy();
    expect(screen.getByText('codex')).toBeTruthy();
    expect(screen.getAllByText('1.5K')).toHaveLength(2);
  });

  it('shows the estimated total, the trend against the previous window, and the per-agent split', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byKind: [], completedRuns: 3, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      costUsd: 12.5, previousCostUsd: 10, pricedRuns: 3, unpricedRuns: 2,
      costByDay: [{ day: '2026-08-20', costUsd: 4.5 }, { day: '2026-08-21', costUsd: 8 }],
      byAgent: [
        { agent: 'codex', total: 1, completed: 1, failed: 0, successRate: 1, retryRate: 0, fallbackRate: 0, medianDurationMs: 1_000, p90DurationMs: 1_000, costUsd: 2.5 },
        { agent: 'claude', total: 2, completed: 2, failed: 0, successRate: 1, retryRate: 0, fallbackRate: 0, medianDurationMs: 1_000, p90DurationMs: 1_000, costUsd: 10 },
      ],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByText('Estimated total')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
    // 12.50 against 10.00 in the window before it.
    expect(screen.getByText(/25% higher than the previous window \(\$10\.00\)/)).toBeTruthy();
    // Claude is the expensive agent: $10 of $12.50.
    // Once in the cost split, once in Claude's per-agent card.
    expect(screen.getAllByText('$10.00')).toHaveLength(2);
    expect(screen.getByText('80% of spend')).toBeTruthy();
    expect(screen.getByText(/2 runs reported tokens but had no rate/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /estimated cost by day/i })).toBeTruthy();
  });

  it('censors curse terms in the Insights breakdown', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 5, messagesAnalyzed: 1, messagesWithCurses: 1, instancesPer100Messages: 500, byTerm: [{ term: 'clusterfuck', count: 2 }, { term: 'fuck', count: 1 }, { term: 'shit', count: 1 }, { term: 'damn', count: 1 }], byDay: [], byModel: [{ model: 'sonnet', count: 5, messagesWithCurses: 1, messagesAnalyzed: 1, instancesPer100Messages: 500 }] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect((await screen.findAllByLabelText('Censored curse term'))[0].textContent).toBe('c**********');
    expect(screen.queryByText('clusterfuck')).toBeNull();
    expect(screen.getAllByLabelText('Censored curse term')).toHaveLength(3);
    expect(screen.getByText('sonnet')).toBeTruthy();
  });

  it('shows the day with the most curse instances, not simply the latest day', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 5, messagesAnalyzed: 2, messagesWithCurses: 2, instancesPer100Messages: 250, byTerm: [], byDay: [{ day: '2026-08-20', count: 4 }, { day: '2026-08-21', count: 1 }] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByText('4 · 2026-08-20')).toBeTruthy();
  });

  it('shows the weekly usage dial with the manual/autonomous split and the 20% autonomous slice', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 1, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/api/usage/weekly')) {
        return new Response(JSON.stringify({
          weekStart: '2026-08-17T00:00:00.000Z', weekEnd: '2026-08-24T00:00:00.000Z', autonomousSliceFraction: 0.2, autonomousTargetFraction: 0.16,
          claude: {
            workbench: { manual: { inputTokens: 1_000, outputTokens: 100, setTokens: 30_000_000, runCount: 5 }, autonomous: { inputTokens: 200, outputTokens: 20, setTokens: 3_000_000, runCount: 1 } },
            interactive: { setTokens: 300_000, scannedFiles: 2, unreadableFiles: 0 },
            ceilingSet: 333_000_000,
            calibration: null,
          },
          codex: { workbench: { manual: { inputTokens: 500, outputTokens: 50, setTokens: 1_000_000, runCount: 2 }, autonomous: emptyTotals() }, rateLimit: null, ceilingSet: null, calibration: null },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 1, completedTasks: 0,
        medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
        cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: /weekly usage/i })).toBeTruthy();
    // (30M manual + 3M autonomous + 0.3M interactive) / 333M ceiling = 10%.
    expect(screen.getByText('10% of weekly ceiling')).toBeTruthy();
    expect(screen.getByText('30M SET')).toBeTruthy();
    expect(screen.getByText('3M SET')).toBeTruthy();
    // Codex has no ceiling estimate yet.
    expect(screen.getByText(/No Codex ceiling estimate yet/)).toBeTruthy();
  });
});
