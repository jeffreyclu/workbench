// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightsView } from './insights';

afterEach(() => vi.unstubAllGlobals());

describe('InsightsView', () => {
  it('renders token totals grouped by provider and model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 1_200, outputTokens: 300,
      tokenUsageByModel: [{ provider: 'codex', model: 'gpt-5.6-terra', inputTokens: 1_200, outputTokens: 300 }],
      cursing: { total: 0, messagesAnalyzed: 1, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: /token usage/i })).toBeTruthy();
    expect(screen.getByText('gpt-5.6-terra')).toBeTruthy();
    expect(screen.getByText('codex')).toBeTruthy();
    expect(screen.getAllByText('1.5K')).toHaveLength(2);
  });

  it('censors curse terms in the Insights breakdown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 2, messagesAnalyzed: 1, messagesWithCurses: 1, instancesPer100Messages: 200, byTerm: [{ term: 'clusterfuck', count: 2 }], byDay: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect((await screen.findByLabelText('Censored curse term')).textContent).toBe('c**********');
    expect(screen.queryByText('clusterfuck')).toBeNull();
  });

  it('shows the day with the most curse instances, not simply the latest day', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      retryRate: null, fallbackRate: null, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 5, messagesAnalyzed: 2, messagesWithCurses: 2, instancesPer100Messages: 250, byTerm: [], byDay: [{ day: '2026-08-20', count: 4 }, { day: '2026-08-21', count: 1 }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByText('4 · 2026-08-20')).toBeTruthy();
  });
});
