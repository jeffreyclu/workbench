import { AlertTriangle, CheckCircle2, PlugZap, RefreshCw } from 'lucide-react';
import type { McpQualityHistory } from '../../../shared/contracts';

function duration(value: number): string {
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function checkedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function automationCopy(data: McpQualityHistory): string {
  if (data.automation.running) return 'Automatic isolated check is running now.';
  if (!data.automation.enabled) return 'Automatic checking starts with the live Workbench runtime.';
  if (!data.automation.nextRunAt) return 'Automatic daily check is waiting for Workbench to become idle.';
  return `Next automatic check ${checkedAt(data.automation.nextRunAt)}.`;
}

export function McpQualityPanel({ data, loading, error, onRetry }: {
  data?: McpQualityHistory;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (loading) return <section className="mcp-quality-panel mcp-quality-loading" aria-label="MCP quality loading"><div className="skeleton-line wide" /><div className="skeleton-line" /></section>;
  if (error || !data) return <section className="mcp-quality-panel status-degraded"><AlertTriangle size={18} /><div><h3>MCP quality unavailable</h3><p>Workbench could not read the local check history.</p></div><button className="button secondary compact" onClick={onRetry}><RefreshCw size={12} /> Retry</button></section>;
  if (!data.latest) return <section className="mcp-quality-panel status-empty"><header><span className="eyebrow"><PlugZap size={12} /> MCP quality</span><h3>First automatic check is pending</h3><p>{automationCopy(data)} Checks run in an isolated database and never call a model.</p></header></section>;

  const latest = data.latest;
  const passed = latest.status === 'passed';
  return <section className={`mcp-quality-panel status-${data.status}`} aria-labelledby="mcp-quality-title">
    <header className="mcp-quality-header">
      <div>
        <span className="eyebrow"><PlugZap size={12} /> MCP quality</span>
        <h3 id="mcp-quality-title">{passed ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}{passed ? 'Latest check passed' : 'Latest check failed'}</h3>
        <p>{automationCopy(data)} Isolated database; no model calls.</p>
      </div>
      <span>{checkedAt(latest.checkedAt)} · {latest.source} · {latest.revision ?? 'unknown revision'}</span>
    </header>
    <div className="mcp-quality-metrics">
      <div><span>Protocol</span><strong>{latest.protocolScore ?? '—'}</strong><small>conformance score</small></div>
      <div><span>Clients</span><strong>{latest.compatibleHosts ?? '—'}</strong><small>compatible hosts</small></div>
      <div><span>Tools</span><strong>{latest.toolProbes === null ? '—' : `${latest.toolProbes}/${latest.totalTools}`}</strong><small>probes passed</small></div>
      <div><span>Breaking</span><strong>{latest.breakingChanges ?? '—'}</strong><small>contract changes</small></div>
    </div>
    {latest.failure && <p className="mcp-quality-failure">{latest.failure}</p>}
    {data.automation.lastError && <p className="mcp-quality-failure">{data.automation.lastError}</p>}
    <div className="mcp-quality-async">
      <span><b>Tasks</b>{latest.tasksWire ? `${latest.tasksWire} wire · ${latest.taskScore ?? '—'} conformance` : 'not measured'}</span>
      <span><b>Subscriptions</b>{latest.subscriptionChecks ? `${latest.subscriptionChecks.passed}/${latest.subscriptionChecks.total} active · ${latest.subscriptionChecks.notApplicable} not applicable` : 'not measured'}</span>
    </div>
    <div className="mcp-quality-details">
      <details><summary>Clients <b>{data.details.hosts.length}</b></summary><div className="mcp-quality-detail-grid">
        {data.details.hosts.map((host) => <div key={host.id}><span>{host.label}</span><small className={`status-${host.verdict}`}>{host.verdict}</small></div>)}
      </div></details>
      <details><summary>Tools <b>{data.details.tools.length}</b></summary><div className="mcp-quality-detail-grid">
        {data.details.tools.map((tool) => <div key={tool.name}><span>{tool.name}</span><small className={tool.passed ? 'status-works' : 'status-blocked'}>{tool.passed ? 'passed' : 'failed'} · {duration(tool.durationMs)}</small></div>)}
      </div></details>
      <details><summary>Protocol checks <b>{data.details.checks.length}</b></summary><div className="mcp-quality-detail-grid">
        {data.details.checks.map((check) => <div key={check.id}><span>{check.title}</span><small className={`status-${check.status}`}>{check.status}</small></div>)}
      </div></details>
      <details><summary>Recent automatic checks <b>{data.runs.length}</b></summary><div className="mcp-quality-runs" aria-label="Recent MCP quality checks">
        {data.runs.slice(0, 6).map((run) => <div key={run.id} className={`status-${run.status}`}>
          <span>{run.status === 'passed' ? 'Passed' : 'Failed'}</span>
          <time dateTime={run.checkedAt}>{checkedAt(run.checkedAt)}</time>
          <small>{run.source}</small><small>{run.revision ?? 'unknown'}</small><small>{duration(run.durationMs)}</small>
        </div>)}
      </div></details>
    </div>
  </section>;
}
