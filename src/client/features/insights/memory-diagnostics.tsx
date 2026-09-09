import { AlertTriangle, CheckCircle2, Database, GitBranch, RefreshCw } from 'lucide-react';
import type { MemoryDiagnostics } from '../../../shared/contracts';

function statusCopy(status: MemoryDiagnostics['status']): string {
  if (status === 'healthy') return 'Working';
  if (status === 'ready') return 'Ready — awaiting linked memories';
  return 'Needs attention';
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function MemoryDiagnosticsPanel({ data, loading, error, onRetry }: {
  data?: MemoryDiagnostics;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return <section className="memory-diagnostics-panel memory-diagnostics-loading" aria-label="Memory diagnostics loading">
      <div className="skeleton-line wide" /><div className="skeleton-line" />
    </section>;
  }
  if (error || !data) {
    return <section className="memory-diagnostics-panel memory-diagnostics-error">
      <AlertTriangle size={18} />
      <div><h3>Memory diagnostics unavailable</h3><p>Workbench could not read the graph health check.</p></div>
      <button className="button secondary compact" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
    </section>;
  }

  const statusIcon = data.status === 'degraded' ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />;
  const hasRecentGraphExpansion = data.retrievals.recent.some((retrieval) => retrieval.graphExpandedCount > 0);
  return <section className={`memory-diagnostics-panel status-${data.status}`} aria-labelledby="memory-diagnostics-title">
    <header className="memory-diagnostics-header">
      <div>
        <span className="eyebrow"><Database size={12} /> Memory diagnostics</span>
        <h3 id="memory-diagnostics-title">{statusIcon}{statusCopy(data.status)}</h3>
        <p>{data.summary}</p>
      </div>
      <span className="memory-diagnostics-checked">Checked {formatCheckedAt(data.checkedAt)}</span>
    </header>

    <div className="memory-diagnostics-metrics">
      <div><span>Graph nodes</span><strong>{data.graph.nodeCount.toLocaleString()}</strong><small>{data.graph.missingNodeCount === 0 && data.graph.staleNodeCount === 0 ? 'Matches source records' : `${data.graph.missingNodeCount} missing · ${data.graph.staleNodeCount} stale`}</small></div>
      <div><span>Relationships</span><strong>{data.graph.edgeCount.toLocaleString()}</strong><small>{data.graph.danglingEdgeCount === 0 ? 'No broken links' : `${data.graph.danglingEdgeCount} broken links`}</small></div>
      <div><span>Sync triggers</span><strong>{data.graph.triggerCount}/{data.graph.requiredTriggerCount}</strong><small>{data.graph.triggerCount === data.graph.requiredTriggerCount ? 'Writes stay synchronized' : 'Sync trigger missing'}</small></div>
      <div><span>Replies with retrieval</span><strong>{data.retrievals.totalReplies.toLocaleString()}</strong><small>{data.retrievals.graphExpandedReplies.toLocaleString()} used graph expansion</small></div>
    </div>

    <div className={`memory-traversal-check status-${data.traversalCanary.status}`}>
      <GitBranch size={16} />
      <div>
        <strong>{data.traversalCanary.status === 'passed' ? 'Live traversal passed' : data.traversalCanary.status === 'no_data' ? 'Live traversal waiting for data' : 'Live traversal failed'}</strong>
        <p>{data.traversalCanary.detail}</p>
        {data.traversalCanary.path.length > 0 && <div className="memory-path" aria-label="Live traversal path">{data.traversalCanary.path.map((part) => <span key={part}>{part}</span>)}</div>}
      </div>
    </div>

    <div className="memory-retrieval-evidence">
      <h4>Recent reply evidence</h4>
      {data.retrievals.recent.length === 0 ? <p className="insight-empty-note">No replies have recorded memory retrieval yet.</p> : <div className="memory-retrieval-list">
        {data.retrievals.recent.map((retrieval) => <article key={retrieval.messageId}>
          <div>
            <strong>{retrieval.conversationTitle}</strong>
            <small>{retrieval.author} · {retrieval.retrievedCount} retrieved · {retrieval.graphExpandedCount} via graph</small>
          </div>
          {retrieval.paths.length > 0 && <div className="memory-retrieval-paths">{retrieval.paths.map((path) => <div className="memory-path" key={path.join(':')}>{path.map((part) => <span key={part}>{part}</span>)}</div>)}</div>}
          <a href={`/conversations/${retrieval.conversationId}`}>Open conversation</a>
        </article>)}
      </div>}
      {data.traversalCanary.status === 'passed' && !hasRecentGraphExpansion && <p className="memory-evidence-note">Live traversal passed. No recent reply has kept a graph-expanded result yet.</p>}
    </div>
  </section>;
}
