import { AlertTriangle, BookOpenCheck, CheckCircle2, RefreshCw } from 'lucide-react';
import { knowledgeDriftCheckLabel, type KnowledgeDriftStatus, type KnowledgeDriftSummary } from '../../../shared/knowledge-drift';

const STATUS_COPY: Record<KnowledgeDriftStatus, string> = {
  healthy: 'Knowledge is in sync',
  degraded: 'Knowledge is drifting',
  failed: 'Knowledge needs repair',
};

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function KnowledgeDriftPanel({ data, loading, error, onRetry, onRecheck, rechecking, recheckFailed }: {
  data?: KnowledgeDriftSummary | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onRecheck: () => void;
  rechecking: boolean;
  recheckFailed: boolean;
}) {
  if (loading) {
    return <section className="knowledge-drift-panel" aria-label="Knowledge drift loading">
      <div className="skeleton-line wide" /><div className="skeleton-line" />
    </section>;
  }
  if (error) {
    return <section className="knowledge-drift-panel status-degraded" aria-labelledby="knowledge-drift-title">
      <header className="knowledge-drift-header">
        <div><span className="eyebrow"><BookOpenCheck size={12} /> Knowledge drift</span><h3 id="knowledge-drift-title"><AlertTriangle size={17} />Knowledge drift unavailable</h3><p>Workbench could not read the latest drift report.</p></div>
        <button className="button secondary compact" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
      </header>
    </section>;
  }

  const recheck = <button className="button secondary compact" onClick={onRecheck} disabled={rechecking}><RefreshCw size={12} /> {rechecking ? 'Re-checking…' : 'Re-check now'}</button>;
  if (!data) {
    return <section className="knowledge-drift-panel" aria-labelledby="knowledge-drift-title">
      <header className="knowledge-drift-header">
        <div><span className="eyebrow"><BookOpenCheck size={12} /> Knowledge drift</span><h3 id="knowledge-drift-title">First nightly check is pending</h3><p>Workbench checks the shared memory and knowledge files every night.</p></div>
        <div className="knowledge-drift-actions">{recheck}</div>
      </header>
      {recheckFailed && <p className="knowledge-drift-error" role="alert">The re-check did not finish. Try again.</p>}
    </section>;
  }

  const icon = data.status === 'healthy' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />;
  return <section className={`knowledge-drift-panel status-${data.status}`} aria-labelledby="knowledge-drift-title">
    <header className="knowledge-drift-header">
      <div>
        <span className="eyebrow"><BookOpenCheck size={12} /> Knowledge drift</span>
        <h3 id="knowledge-drift-title">{icon}{STATUS_COPY[data.status]}</h3>
        <p className="knowledge-drift-meta">Last checked {formatCheckedAt(data.checkedAt)} · runs automatically every night</p>
      </div>
      <div className="knowledge-drift-actions">{recheck}</div>
    </header>
    {recheckFailed && <p className="knowledge-drift-error" role="alert">The re-check did not finish. Showing the previous report.</p>}
    <ul className="knowledge-drift-checks" aria-label="Knowledge drift checks">
      {Object.entries(data.checks).map(([key, entry]) => <li key={key}>
        <strong>{knowledgeDriftCheckLabel(key)}</strong>
        <span className={`check-status status-${entry.status}`}>{entry.status}</span>
        <span>{entry.reason}</span>
      </li>)}
    </ul>
  </section>;
}
