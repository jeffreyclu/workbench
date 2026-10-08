import { AlertTriangle, Library, RefreshCw } from 'lucide-react';
import type { KnowledgeEntryRank, KnowledgeGap, KnowledgeUsageReport } from '../../../shared/knowledge-usage';

function entryLabel(entry: KnowledgeEntryRank): string {
  const number = entry.entryId.split('#')[1];
  return number ? `${entry.file} #${number}` : entry.file;
}

function gapNote(gap: KnowledgeGap): string {
  const runs = `${gap.runs} run${gap.runs === 1 ? '' : 's'}`;
  return gap.file
    ? `${runs}, but ${gap.file} was never retrieved. It needs a learning or is not being found.`
    : `${runs}, but no knowledge file matches. It needs a learning or is not being found.`;
}

export function KnowledgeUsagePanel({ data, loading, error, onRetry }: {
  data?: KnowledgeUsageReport | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return <section className="knowledge-usage-panel" aria-label="Knowledge use loading"><div className="skeleton-line wide" /><div className="skeleton-line" /></section>;
  }
  if (error || !data) {
    return <section className="knowledge-usage-panel" aria-labelledby="knowledge-usage-title">
      <header className="knowledge-usage-header">
        <div><span className="eyebrow"><Library size={12} /> Knowledge use</span><h3 id="knowledge-usage-title">Knowledge use unavailable</h3><p>Workbench could not read the usage counts.</p></div>
        <button className="button secondary compact" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
      </header>
    </section>;
  }

  const group = (title: string, rows: KnowledgeEntryRank[]) => <tbody aria-label={title}>
    <tr className="knowledge-usage-group"><th colSpan={3} scope="colgroup">{title}</th></tr>
    {rows.length === 0 && <tr><td colSpan={3}>Nothing yet.</td></tr>}
    {rows.map((row) => <tr key={`${title}:${row.entryId}`}><td>{entryLabel(row)}</td><td>{row.retrievals}</td><td>{row.citations}</td></tr>)}
  </tbody>;

  return <section className="knowledge-usage-panel" aria-labelledby="knowledge-usage-title">
    <header className="knowledge-usage-header">
      <div>
        <span className="eyebrow"><Library size={12} /> Knowledge use</span>
        <h3 id="knowledge-usage-title">What agents read and cite</h3>
        <p className="knowledge-usage-notice">{data.notice}</p>
      </div>
    </header>
    <table className="knowledge-usage-table" aria-label="Knowledge use">
      <thead><tr><th scope="col">Entry or project</th><th scope="col">Retrieved</th><th scope="col">Cited</th></tr></thead>
      {group('Most retrieved', data.topRetrieved)}
      {group('Most cited', data.topCited)}
      <tbody aria-label="Gaps">
        <tr className="knowledge-usage-group"><th colSpan={3} scope="colgroup">Gaps · active in the last {data.windowDays} days</th></tr>
        {data.gaps.length === 0 && <tr><td colSpan={3}>No gaps. Every active project was found in its knowledge.</td></tr>}
        {data.gaps.map((gap) => <tr key={gap.project} className="knowledge-usage-gap">
          <td><AlertTriangle size={12} /> {gap.project}</td>
          <td colSpan={2}>{gapNote(gap)}</td>
        </tr>)}
      </tbody>
    </table>
  </section>;
}
