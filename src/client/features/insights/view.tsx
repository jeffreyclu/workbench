import { useQuery } from '@tanstack/react-query';
import { Info, LineChart } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../data/api';
import { InsightsSkeleton } from '../../components/skeleton/skeleton';
import type { InsightsTimeframe, RunInsights, RunInsightsAgentFit, RunInsightsByAgent, RunInsightsByKind, RunInsightsTokenUsage } from '../../../shared/contracts';

function InfoTooltip({ children }: { children: string }) {
  return (
    <span className="insight-info-tooltip" tabIndex={0} role="tooltip" aria-label={children}>
      <Info size={12} />
      <span className="insight-info-tooltip-bubble">{children}</span>
    </span>
  );
}

const kindLabels: Record<string, string> = {
  research: 'Research',
  analysis: 'Analysis',
  strategy: 'Strategy',
  execute: 'Execute',
  review: 'Review',
};

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  const percentage = value * 100;
  return `${percentage > 0 && percentage < 10 ? percentage.toFixed(1) : Math.round(percentage)}%`;
}

/** Lifecycle events can occur more than once per terminal run, so this is a frequency, not a percentage. */
function formatEventsPerHundredRuns(value: number | null): string {
  if (value === null) return '—';
  const perHundred = value * 100;
  return `${perHundred > 0 && perHundred < 10 ? perHundred.toFixed(1) : Math.round(perHundred)} per 100`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return ms < 10_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms / 1_000)}s`;
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
}

function RateBar({ label, value, count }: { label: string; value: number | null; count?: string }) {
  return (
    <div className="insight-bar-row">
      <span className="insight-bar-label">{label}</span>
      <div className="insight-bar-track">
        <div className="insight-bar-fill" style={{ width: value === null ? 0 : `${Math.round(value * 100)}%` }} />
      </div>
      <span className="insight-bar-value">{formatPercent(value)}</span>
      {count && <span className="insight-bar-count">{count}</span>}
    </div>
  );
}

function AgentInsightCard({ agent }: { agent: RunInsightsByAgent }) {
  return (
    <article className="insight-agent-card">
      <header>
        <strong>{agent.agent}</strong>
        <span className="insight-agent-total">{agent.total} run{agent.total === 1 ? '' : 's'}</span>
      </header>
      <RateBar label="Success" value={agent.successRate} count={`${agent.completed}/${agent.total}`} />
      <dl className="insight-agent-stats">
        <div><dt>Retry events</dt><dd>{formatEventsPerHundredRuns(agent.retryRate)}</dd></div>
        <div><dt>Agent handoffs</dt><dd>{formatEventsPerHundredRuns(agent.fallbackRate)}</dd></div>
        <div><dt>Median duration</dt><dd>{formatDuration(agent.medianDurationMs)}</dd></div>
        <div><dt>P90 duration</dt><dd>{formatDuration(agent.p90DurationMs)}</dd></div>
      </dl>
    </article>
  );
}

function KindInsightRow({ kind }: { kind: RunInsightsByKind }) {
  return <RateBar label={kindLabels[kind.kind] ?? kind.kind} value={kind.successRate} count={`${kind.completed}/${kind.completed + kind.failed + kind.canceled}`} />;
}

function AgentFitRows({ rows }: { rows: RunInsightsAgentFit[] }) {
  const kinds = [...new Set(rows.map((row) => row.kind))];
  return <div className="insight-fit-list">{kinds.map((kind) => {
    const agents = rows.filter((row) => row.kind === kind).sort((left, right) => (right.successRate ?? -1) - (left.successRate ?? -1));
    const hasWinner = agents.length > 1 && agents[0].successRate !== agents[1].successRate;
    return <div className="insight-fit-row" key={kind}>
      <strong>{kindLabels[kind] ?? kind}</strong>
      <div>{agents.map((agent, index) => <span className={index === 0 && hasWinner ? 'recommended' : ''} key={agent.agent}>
        <b>{agent.agent}</b><em>{formatPercent(agent.successRate)} success</em><small>{formatDuration(agent.medianDurationMs)} median · {agent.completed + agent.failed + agent.canceled} runs</small>
      </span>)}</div>
    </div>;
  })}</div>;
}

function TokenUsageRows({ rows }: { rows: RunInsightsTokenUsage[] }) {
  return <div className="insight-token-list">
    {rows.map((row) => <div className="insight-token-row" key={`${row.provider}:${row.model ?? 'unspecified'}`}>
      <div><strong>{row.model ?? 'Unspecified model'}</strong><small>{row.provider}</small></div>
      <dl>
        <div><dt>Fresh input</dt><dd>{formatTokenCount(row.inputTokens)}</dd></div>
        <div><dt>Cache write</dt><dd>{formatTokenCount(row.cacheCreationInputTokens)}</dd></div>
        <div><dt>Cache read</dt><dd>{formatTokenCount(row.cacheReadInputTokens)}</dd></div>
        <div><dt>Output</dt><dd>{formatTokenCount(row.outputTokens)}</dd></div>
        <div><dt>Total traffic</dt><dd>{formatTokenCount(row.inputTokens + row.cacheCreationInputTokens + row.cacheReadInputTokens + row.outputTokens)}</dd></div>
      </dl>
    </div>)}
  </div>;
}

function CursingInsight({ data }: { data: RunInsights['cursing'] }) {
  const censorTerm = (term: string) => {
    const characters = [...term];
    return characters.length < 2 ? '*' : `${characters[0]}${'*'.repeat(characters.length - 1)}`;
  };
  const cursedModels = data.byModel ?? [];
  return <div className="insight-section cursing-insight">
    <div className="cursing-insight-header">
      <div><h3>Jeffrey cursing <InfoTooltip>Scans Jeffrey’s submitted shared-room messages in this window for whole-word matches and common one-edit typos. Model attribution uses the most recent agent reply before each message, so it shows which model you were responding to. Frequency is instances per 100 attributed messages.</InfoTooltip></h3><p className="insight-section-intro">Submitted messages from Jeffrey in this window. Counts update as soon as a message is sent.</p></div>
      <strong aria-label={`${data.total} curse instances`}>{data.total}</strong>
    </div>
    <div className="cursing-insight-stats">
      <div><span>Messages with curses</span><b>{data.messagesWithCurses}/{data.messagesAnalyzed}</b></div>
      <div><span>Frequency</span><b>{data.instancesPer100Messages.toFixed(1)} per 100</b></div>
      <div><span>Angriest day</span><b>{data.angriestDay ? `${data.angriestDay.day} · ${data.angriestDay.count}` : '—'}</b></div>
    </div>
    {cursedModels.length > 0 && <div className="cursing-model-list" aria-label="Curse count by responding model">
      {cursedModels.map(({ model, count, instancesPer100Messages }) => <span key={model}><b>{model}</b><em>{count} · {instancesPer100Messages.toFixed(1)}/100</em></span>)}
    </div>}
    {data.byTerm.length === 0 ? <p className="insight-empty-note">No curse words found in this window.</p> : <div className="cursing-term-list" aria-label="Top three curse terms">
      {data.byTerm.slice(0, 3).map(({ term, count }) => <span key={term}><b aria-label="Censored curse term">{censorTerm(term)}</b><em>{count}</em></span>)}
    </div>}
  </div>;
}

export function InsightsView() {
  const [timeframe, setTimeframe] = useState<InsightsTimeframe>('all');
  const insights = useQuery({ queryKey: ['insights', timeframe], queryFn: () => api.getInsights(timeframe), refetchInterval: 10_000 });
  const data = insights.data;

  return (
    <section className="artifact-workspace">
      <header className="discovery-header">
        <div>
          <span className="eyebrow">Trends</span>
          <h2>Insights</h2>
          <p>How work moves through Workbench and which agent fits each task.</p>
        </div>
        <div className="insight-window-toggle" role="group" aria-label="Time window">
          <button className={timeframe === '15m' ? 'active' : ''} onClick={() => setTimeframe('15m')}>Last 15 minutes</button>
          <button className={timeframe === '1h' ? 'active' : ''} onClick={() => setTimeframe('1h')}>Last hour</button>
          <button className={timeframe === '1d' ? 'active' : ''} onClick={() => setTimeframe('1d')}>Last day</button>
          <button className={timeframe === 'all' ? 'active' : ''} onClick={() => setTimeframe('all')}>All Time</button>
        </div>
      </header>

      {insights.isLoading && <InsightsSkeleton />}
      {insights.isError && <div className="list-state error-message">Could not load insights. <button className="button secondary compact" onClick={() => insights.refetch()}>Retry</button></div>}

      {!insights.isLoading && !insights.isError && data && (
        <div className="insight-sections">
          {data.byAgent.length === 0 && data.byKind.length === 0 && data.agentFit.length === 0 && data.tokenUsageByModel.length === 0 && data.cursing.messagesAnalyzed === 0 && (data.incompleteTokenTelemetryRuns ?? 0) === 0 ? (
            <div className="discovery-empty">
              <LineChart size={26} />
              <h3>Nothing to show yet</h3>
              <p>Once runs complete in this window, trends will show up here.</p>
            </div>
          ) : (
            <>
              <div className="insight-overall-row">
                <div className="insight-overall-stat"><span className="eyebrow">Agent work completed <InfoTooltip>Count of agent runs that reached the completed status in this window, counted by completed time.</InfoTooltip></span><strong>{data.completedRuns ?? 0}</strong><small>Successful agent runs completed in this window.</small></div>
                <div className="insight-overall-stat"><span className="eyebrow">Tasks completed <InfoTooltip>Count of tasks with a completed_at timestamp inside this window. Not limited to tasks created in the window.</InfoTooltip></span><strong>{data.completedTasks ?? 0}</strong><small>Tasks you accepted and completed.</small></div>
                <div className="insight-overall-stat"><span className="eyebrow">Median active work time <InfoTooltip>Median, per task completed in this window, of the summed duration of that task's agent runs (each run's started_at to completed_at), excluding extreme durations outside Tukey’s outer fences. Idle time between runs — waiting on you, sitting untouched — is not counted.</InfoTooltip></span><strong>{formatDuration(data.medianTaskCycleMs ?? null)}</strong><small>Typical time agents actually spent working on a task.</small></div>
                <div className="insight-overall-stat"><span className="eyebrow">Follow-ups created <InfoTooltip>Count of tasks created in this window that have a parent task (i.e. were split out from existing work).</InfoTooltip></span><strong>{data.followUpsCreated ?? 0}</strong><small>Work split out from existing tasks.</small></div>
              </div>

              <CursingInsight data={data.cursing} />

              <div className="insight-section">
                <h3>Best agent by task type <InfoTooltip>For each task type, agents are ranked by success rate: completed runs ÷ all terminal runs (completed, failed, and canceled) for that agent. The agent with the higher rate is marked "recommended" only when both agents have run history to compare.</InfoTooltip></h3>
                <p className="insight-section-intro">Use this to improve automatic routing. The stronger result is highlighted when both agents have history.</p>
                {(data.agentFit ?? []).length === 0 ? <p className="insight-empty-note">Not enough task history yet.</p> : <AgentFitRows rows={data.agentFit} />}
              </div>

              <div className="insight-section">
                <h3>Success rate by agent <InfoTooltip>Per agent: success rate is completed runs ÷ all terminal runs, including canceled runs. Retries and handoffs are read from the lifecycle event ledger, including chat runs. Median and P90 duration are computed from each run's started_at to completed_at span.</InfoTooltip></h3>
                {data.byAgent.length === 0 ? <p className="insight-empty-note">No agent runs in this window.</p> : (
                  <div className="insight-agent-grid">
                    {data.byAgent.map((agent) => <AgentInsightCard key={agent.agent} agent={agent} />)}
                  </div>
                )}
              </div>

              <div className="insight-section">
                <h3>Success rate by task type <InfoTooltip>For each task type, success rate is completed runs ÷ all terminal runs, including canceled runs, completed in this window.</InfoTooltip></h3>
                {data.byKind.length === 0 ? <p className="insight-empty-note">No classified runs in this window.</p> : (
                  <div className="insight-bar-list">
                    {data.byKind.map((kind) => <KindInsightRow key={kind.kind} kind={kind} />)}
                  </div>
                )}
              </div>

              <div className="insight-section">
                <h3>Token usage <InfoTooltip>Only runs with a provider-reported cache split are included. Fresh input, cache writes, cache reads, and output stay separate so the source of traffic remains visible. Rows group usage by provider and model.</InfoTooltip></h3>
                {data.tokenUsageByModel.length === 0 ? <>
                  <p className="insight-empty-note">No token usage with a complete provider cache split was reported in this window.</p>
                  {(data.incompleteTokenTelemetryRuns ?? 0) > 0 && <p className="insight-empty-note">{data.incompleteTokenTelemetryRuns} run{data.incompleteTokenTelemetryRuns === 1 ? '' : 's'} lacked a cache split and are excluded rather than guessed.</p>}
                </> : <>
                  <div className="insight-token-summary">
                    <div><span>Total traffic</span><strong>{formatTokenCount(data.inputTokens + data.cacheCreationInputTokens + data.cacheReadInputTokens + data.outputTokens)}</strong></div>
                    <div><span>Fresh input</span><strong>{formatTokenCount(data.inputTokens)}</strong></div>
                    <div><span>Cache read</span><strong>{formatTokenCount(data.cacheReadInputTokens)}</strong></div>
                    <div><span>Cache write</span><strong>{formatTokenCount(data.cacheCreationInputTokens)}</strong></div>
                    <div><span>Output</span><strong>{formatTokenCount(data.outputTokens)}</strong></div>
                  </div>
                  <TokenUsageRows rows={data.tokenUsageByModel} />
                  {(data.incompleteTokenTelemetryRuns ?? 0) > 0 && <p className="insight-empty-note">{data.incompleteTokenTelemetryRuns} run{data.incompleteTokenTelemetryRuns === 1 ? '' : 's'} lacked a cache split and are excluded from token totals rather than guessed.</p>}
                </>}
              </div>

              <div className="insight-section insight-reliability">
                <h3>System reliability <InfoTooltip>Computed across every agent run in this window, regardless of agent or task type.</InfoTooltip></h3>
                <div className="insight-reliability-grid">
                  <div><span>Retry events <InfoTooltip>Retry events per 100 terminal agent runs. It includes canceled and failed runs; the event count comes from the lifecycle ledger, including chat-era history.</InfoTooltip></span><strong>{formatEventsPerHundredRuns(data.retryRate)}</strong><small>{data.retryCount} retry event{data.retryCount === 1 ? '' : 's'} recorded in this window.</small></div>
                  <div><span>Agent handoffs <InfoTooltip>Handoffs per 100 terminal agent runs. Events record when an agent switched to its counterpart after the first provider became unavailable, including chat-era history.</InfoTooltip></span><strong>{formatEventsPerHundredRuns(data.fallbackRate)}</strong><small>{data.handoffCount} handoff{data.handoffCount === 1 ? '' : 's'} recorded in this window.</small></div>
                </div>
              </div>

            </>
          )}
        </div>
      )}
    </section>
  );
}

export function InsightsNav({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <LineChart size={16} /> Insights
    </button>
  );
}
