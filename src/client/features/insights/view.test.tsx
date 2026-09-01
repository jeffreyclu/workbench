// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightsView } from './view';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubInsightsFetch(insightsPayload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    return new Response(JSON.stringify(insightsPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('InsightsView', () => {
  it('offers the six approved timeframes and requests the selected one', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    await screen.findByRole('heading', { name: /insights/i });
    expect(screen.getAllByRole('button', { name: /last 15 minutes|last hour|last day|all time/i })).toHaveLength(4);
    expect(screen.getByRole('button', { name: '7 days' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '30 days' })).toBeTruthy();
    const mobileTimeframe = screen.getByRole('combobox', { name: 'Time window' });
    expect(screen.getAllByRole('option')).toHaveLength(6);
    expect((mobileTimeframe as HTMLSelectElement).value).toBe('all');
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/insights?timeframe=all'))).toBe(true);

    fireEvent.change(mobileTimeframe, { target: { value: '15m' } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/insights?timeframe=15m'))).toBe(true));
  });

  it('renders token totals grouped by provider and model', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
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
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 1, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 1_700, cacheCreationInputTokens: 2_000_000, cacheReadInputTokens: 57_500_000, outputTokens: 184_400,
      tokenUsageByModel: [{ provider: 'claude', model: 'claude-opus-5', inputTokens: 1_700, cacheCreationInputTokens: 2_000_000, cacheReadInputTokens: 57_500_000, outputTokens: 184_400, runs: 1 }],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findAllByText('Cache read')).toHaveLength(2);
    expect(screen.getAllByText('57.5M')).toHaveLength(2);
    expect(screen.getAllByText('Fresh input')).toHaveLength(2);
    expect(screen.getAllByText('1.7K')).toHaveLength(2);
  });

  it('does not recommend an agent when task-type success rates are tied', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 2, completedTasks: 0,
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

  it('renders bugfix tasks as Bug fix in task-kind reports', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], completedRuns: 2, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      byKind: [{ kind: 'bugfix', completed: 1, failed: 1, canceled: 0, successRate: 0.5 }],
      agentFit: [{ kind: 'bugfix', agent: 'codex', completed: 1, failed: 1, canceled: 0, successRate: 0.5, medianDurationMs: 1_000 }],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findAllByText('Bug fix')).toHaveLength(2);
    expect(screen.queryByText('bugfix')).toBeNull();
  });

  it('reports retry and handoff lifecycle events as a per-run frequency, including values above 100 per 100 runs', async () => {
    stubInsightsFetch({
      retryRate: 2.5, retryCount: 5, fallbackRate: 1.5, handoffCount: 3, byKind: [], completedRuns: 2, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [], byAgent: [
        { agent: 'codex', total: 2, completed: 2, failed: 0, canceled: 0, successRate: 1, retryRate: 2.5, fallbackRate: 1.5, medianDurationMs: 1_000, p90DurationMs: 1_000 },
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
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
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

  it('shows the calendar day with the most curses for angriest day', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 5, angriestDay: { day: '2026-08-20', count: 4 }, messagesAnalyzed: 2, messagesWithCurses: 2, instancesPer100Messages: 250, byTerm: [], byDay: [{ day: '2026-08-20', count: 4 }, { day: '2026-08-21', count: 1 }] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByText('2026-08-20 · 4')).toBeTruthy();
  });

  it('does not request or render the retired weekly usage section', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);
    await screen.findByRole('heading', { name: /insights/i });
    expect(screen.queryByRole('heading', { name: /weekly usage/i })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/usage/weekly'))).toBe(false);
  });
});
