// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightsView } from './insights';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function emptyTotals() { return { inputTokens: 0, outputTokens: 0, setTokens: 0, runCount: 0 }; }
const emptyWeeklyUsage = {
  weekStart: '2026-08-17T00:00:00.000Z', weekEnd: '2026-08-24T00:00:00.000Z', autonomousSliceFraction: 0.2, autonomousTargetFraction: 0.16,
  claude: { workbench: { manual: emptyTotals(), autonomous: emptyTotals() }, interactive: { setTokens: 0, scannedFiles: 0, error: null }, ceilingSet: 333_000_000, calibration: null },
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
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 1_200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 300,
      tokenUsageByModel: [{ provider: 'codex', model: 'gpt-5.6-terra', inputTokens: 1_200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 300 }],
      cursing: { total: 0, messagesAnalyzed: 1, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: /token usage/i })).toBeTruthy();
    expect(screen.getByText('gpt-5.6-terra')).toBeTruthy();
    expect(screen.getByText('codex')).toBeTruthy();
    expect(screen.getAllByText('1.5K')).toHaveLength(2);
  });

  it('keeps massive cache traffic visible instead of folding it into fresh input', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 1, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 1_700, cacheCreationInputTokens: 2_000_000, cacheReadInputTokens: 57_500_000, outputTokens: 184_400,
      tokenUsageByModel: [{ provider: 'claude', model: 'claude-opus-5', inputTokens: 1_700, cacheCreationInputTokens: 2_000_000, cacheReadInputTokens: 57_500_000, outputTokens: 184_400, costUsd: 53.08, rateSource: 'default', runs: 1 }],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findAllByText('Cache read')).toHaveLength(2);
    expect(screen.getAllByText('57.5M')).toHaveLength(2);
    expect(screen.getAllByText('Fresh input')).toHaveLength(2);
    expect(screen.getAllByText('1.7K')).toHaveLength(2);
  });

  it('keeps provider billing separate from token-based estimates', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byKind: [], completedRuns: 3, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      providerCostUsd: 10, previousProviderCostUsd: 8, providerPricedRuns: 2,
      estimatedCostUsd: 2.5, previousEstimatedCostUsd: 2, estimatedPricedRuns: 1, unverifiedCostRuns: 3, unpricedRuns: 2,
      costByDay: [{ day: '2026-08-20', costUsd: 4.5 }, { day: '2026-08-21', costUsd: 8 }],
      byAgent: [
        { agent: 'codex', total: 1, completed: 1, failed: 0, canceled: 0, successRate: 1, retryRate: 0, fallbackRate: 0, medianDurationMs: 1_000, p90DurationMs: 1_000, providerCostUsd: 0, providerPricedRuns: 0, estimatedCostUsd: 2.5, estimatedPricedRuns: 1 },
        { agent: 'claude', total: 2, completed: 2, failed: 0, canceled: 0, successRate: 1, retryRate: 0, fallbackRate: 0, medianDurationMs: 1_000, p90DurationMs: 1_000, providerCostUsd: 10, providerPricedRuns: 2, estimatedCostUsd: 0, estimatedPricedRuns: 0 },
      ],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect((await screen.findAllByText('Provider billed')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('List-price estimate')).toHaveLength(3);
    expect(screen.getAllByText('$10.00')).toHaveLength(2);
    expect(screen.getByText(/25% higher than the previous window \(\$8\.00\)/)).toBeTruthy();
    expect(screen.getByText(/3 runs had a stored cost without provenance/)).toBeTruthy();
    expect(screen.getByText(/2 runs reported tokens but had no rate/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /list-price estimate by day/i })).toBeTruthy();
  });

  it('keeps cost-only shared-room activity visible and attributed in the cost split', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      providerCostUsd: 4.25, previousProviderCostUsd: null, providerPricedRuns: 1,
      estimatedCostUsd: 0, previousEstimatedCostUsd: null, estimatedPricedRuns: 0, unverifiedCostRuns: 0, unpricedRuns: 0,
      byAgent: [{ agent: 'claude', total: 0, completed: 0, failed: 0, canceled: 0, successRate: null, retryRate: null, fallbackRate: null, medianDurationMs: null, p90DurationMs: null, providerCostUsd: 4.25, providerPricedRuns: 1, estimatedCostUsd: 0, estimatedPricedRuns: 0 }],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: /cost/i })).toBeTruthy();
    expect(screen.getAllByText('claude')).toHaveLength(2);
    expect(screen.getAllByText('$4.25')).toHaveLength(2);
  });

  it('shows an em dash instead of a zero cost when that cost source was not measured', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byKind: [], completedRuns: 1, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 100,
      providerCostUsd: 0, previousProviderCostUsd: null, providerPricedRuns: 0,
      estimatedCostUsd: 2.5, previousEstimatedCostUsd: null, estimatedPricedRuns: 1, unverifiedCostRuns: 0, unpricedRuns: 0,
      tokenUsageByModel: [{ provider: 'codex', model: 'gpt-5.6-terra', inputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 100, costUsd: 0, estimatedPricedRuns: 0, rateSource: 'default', runs: 1 }],
      byAgent: [{ agent: 'codex', total: 1, completed: 1, failed: 0, canceled: 0, successRate: 1, retryRate: 0, fallbackRate: 0, medianDurationMs: 1_000, p90DurationMs: 1_000, providerCostUsd: 0, providerPricedRuns: 0, estimatedCostUsd: 2.5, estimatedPricedRuns: 1 }],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: /cost/i })).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('does not recommend an agent when task-type success rates are tied', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 2, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      agentFit: [
        { kind: 'execute', agent: 'claude', completed: 1, failed: 0, canceled: 0, successRate: 1, medianDurationMs: 1_000 },
        { kind: 'execute', agent: 'codex', completed: 1, failed: 0, canceled: 0, successRate: 1, medianDurationMs: 1_000 },
      ],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    await screen.findByRole('heading', { name: /best agent by task type/i });
    expect(container.querySelector('.insight-fit-row .recommended')).toBeNull();
  });

  it('reports retry and handoff lifecycle events as a per-run frequency, including values above 100 per 100 runs', async () => {
    stubInsightsFetch({
      retryRate: 2.5, retryCount: 5, fallbackRate: 1.5, handoffCount: 3, costByDay: [], byKind: [], completedRuns: 2, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [], byAgent: [
        { agent: 'codex', total: 2, completed: 2, failed: 0, canceled: 0, successRate: 1, retryRate: 2.5, fallbackRate: 1.5, medianDurationMs: 1_000, p90DurationMs: 1_000, providerCostUsd: 0, estimatedCostUsd: 0 },
      ],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findAllByText('Retry events')).toHaveLength(2);
    expect(screen.getAllByText('250 per 100')).toHaveLength(2);
    expect(screen.getAllByText('150 per 100')).toHaveLength(2);
    expect(screen.getByText('5 retry events recorded in this window.')).toBeTruthy();
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

  it('shows only the rolling 24-hour curse count for angriest day', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 5, last24Hours: 1, messagesAnalyzed: 2, messagesWithCurses: 2, instancesPer100Messages: 250, byTerm: [], byDay: [{ day: '2026-08-20', count: 4 }, { day: '2026-08-21', count: 1 }] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByText('1 · last 24h')).toBeTruthy();
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
            interactive: { setTokens: 300_000, scannedFiles: 2, error: null },
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
    // Calibration is agent-owned; the usage view does not expose manual controls for either provider.
    expect(screen.queryByRole('button', { name: 'Calibrate' })).toBeNull();
    expect(screen.queryByText('Calibration history')).toBeNull();
  });

  it('labels the ceiling as an uncalibrated estimate until a /usage observation is recorded', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect((await screen.findAllByText('Estimate — not yet calibrated')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Calibrated /)).toBeNull();
  });

  it('switches the ceiling label to a calibrated date once a /usage observation is recorded', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/api/usage/weekly')) {
        return new Response(JSON.stringify({
          weekStart: '2026-08-17T00:00:00.000Z', weekEnd: '2026-08-24T00:00:00.000Z', autonomousSliceFraction: 0.2, autonomousTargetFraction: 0.16,
          claude: {
            workbench: { manual: emptyTotals(), autonomous: emptyTotals() },
            interactive: { setTokens: 0, scannedFiles: 0, error: null },
            ceilingSet: 400_000_000,
            calibration: { provider: 'claude', observedAt: '2026-08-19T15:00:00.000Z', observedPercentage: 12, workbenchSet: 30_000_000, interactiveSet: 300_000, computedCeilingSet: 400_000_000 },
          },
          codex: { workbench: { manual: emptyTotals(), autonomous: emptyTotals() }, rateLimit: null, ceilingSet: null, calibration: null },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
        medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
        cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByText(/^Calibrated /)).toBeTruthy();
    // Codex is still uncalibrated in this fixture, so the estimate label must still show for it.
    expect(screen.getByText('Estimate — not yet calibrated')).toBeTruthy();
  });

  it('keeps the weekly usage dial content reachable at a narrow, phone-width viewport', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    window.dispatchEvent(new Event('resize'));
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    // Content that must stay reachable without horizontal scroll: both provider
    // cards, the manual/autonomous breakdown, and the reset/legend text. None of
    // this is gated behind a wide-viewport-only element, matching the CSS rule
    // (styles.css `.usage-dial-grid` at the narrow breakpoint) that collapses the
    // two-provider grid to a single column instead of hiding either card.
    expect(await screen.findByRole('heading', { name: /weekly usage/i })).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getAllByText('Manual').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Autonomous').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Target 16%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Alarm 20%/).length).toBeGreaterThan(0);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });
});
