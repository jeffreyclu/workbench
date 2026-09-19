// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightsView } from './view';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const healthyMemoryDiagnostics = {
  status: 'healthy', summary: 'The memory graph is synced and live traversal passed.', checkedAt: '2026-09-09T12:00:00.000Z', migrationApplied: true,
  graph: { nodeCount: 119097, edgeCount: 50760, canonicalNodeCount: 119097, missingNodeCount: 0, staleNodeCount: 0, danglingEdgeCount: 0, triggerCount: 20, requiredTriggerCount: 20 },
  traversalCanary: { status: 'passed', path: ['Matched request', 'Same conversation'], detail: 'A live read followed the graph to a related memory.' },
  retrievals: { totalReplies: 8, graphExpandedReplies: 1, lastRetrievedAt: '2026-09-09T12:00:00.000Z', recent: [] },
};

const healthyMcpQuality = {
  status: 'healthy',
  latest: { id: 'check-2', checkedAt: '2026-09-18T12:00:00.000Z', status: 'passed', source: 'promotion', revision: 'abc1234', durationMs: 12_400, protocolScore: 100, compatibleHosts: 18, toolProbes: 50, totalTools: 50, breakingChanges: 0, failure: null, tasksWire: 'none', taskScore: 100, subscriptionChecks: { passed: 0, notApplicable: 3, total: 3 } },
  runs: [
    { id: 'check-2', checkedAt: '2026-09-18T12:00:00.000Z', status: 'passed', source: 'promotion', revision: 'abc1234', durationMs: 12_400, protocolScore: 100, compatibleHosts: 18, toolProbes: 50, totalTools: 50, breakingChanges: 0, failure: null, tasksWire: 'none', taskScore: 100, subscriptionChecks: { passed: 0, notApplicable: 3, total: 3 } },
    { id: 'check-1', checkedAt: '2026-09-18T11:00:00.000Z', status: 'failed', source: 'local', revision: 'def5678', durationMs: 2_500, protocolScore: 100, compatibleHosts: 2, toolProbes: null, totalTools: 50, breakingChanges: 0, failure: 'Tool probe failed.' },
  ],
};

function stubInsightsFetch(insightsPayload: unknown, memoryPayload: unknown = healthyMemoryDiagnostics, mcpPayload: unknown = healthyMcpQuality) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const payload = url.includes('/api/insights/memory') ? memoryPayload
      : url.includes('/api/insights/mcp-quality') ? mcpPayload
        : insightsPayload;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

  it('keeps memory health visible even when there are no run insights', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Working' })).toBeTruthy();
    expect(screen.getByText('Live traversal passed')).toBeTruthy();
    expect(screen.getByText('20/20')).toBeTruthy();
    expect(screen.getByText('Nothing to show yet')).toBeTruthy();
  });

  it('shows the latest MCP quality result and recent regression history', async () => {
    stubInsightsFetch({
      retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0,
      medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [],
      cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Latest check passed' })).toBeTruthy();
    expect(screen.getByText('50/50')).toBeTruthy();
    expect(screen.getByText(/No model calls\./)).toBeTruthy();
    expect(screen.getByText('none wire · 100 conformance')).toBeTruthy();
    expect(screen.getByText('0/3 active · 3 not applicable')).toBeTruthy();
    expect(screen.getByLabelText('Recent MCP quality checks').textContent).toContain('Failed');
  });

  it('links recent graph-expanded retrieval evidence to its conversation', async () => {
    const memoryPayload = {
      ...healthyMemoryDiagnostics,
      retrievals: { totalReplies: 1, graphExpandedReplies: 1, lastRetrievedAt: '2026-09-09T12:00:00.000Z', recent: [{
        messageId: 'message-1', conversationId: 'conversation-1', conversationTitle: 'Staff promotion history', author: 'palmyra', createdAt: '2026-09-09T12:00:00.000Z', query: 'promotion evidence', retrievedCount: 2, directCount: 1, graphExpandedCount: 1,
        paths: [['Matched request'], ['Matched request', 'Same task']],
      }] },
    };
    stubInsightsFetch({ retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0, medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [], cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] } }, memoryPayload);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByText('Staff promotion history')).toBeTruthy();
    expect(screen.getByText('palmyra · 2 retrieved · 1 via graph')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open conversation' }).getAttribute('href')).toBe('/conversations/conversation-1');
  });

  it('shows graph failures plainly', async () => {
    const degraded = { ...healthyMemoryDiagnostics, status: 'degraded', summary: 'The memory graph needs attention. See the failed checks below.', graph: { ...healthyMemoryDiagnostics.graph, triggerCount: 19 }, traversalCanary: { status: 'failed', path: [], detail: 'Graph traversal did not return a linked memory.' } };
    stubInsightsFetch({ retryRate: null, fallbackRate: null, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0, medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], inputTokens: 0, outputTokens: 0, tokenUsageByModel: [], cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] } }, degraded);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><InsightsView /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeTruthy();
    expect(screen.getByText('19/20')).toBeTruthy();
    expect(screen.getByText('Live traversal failed')).toBeTruthy();
  });
});
