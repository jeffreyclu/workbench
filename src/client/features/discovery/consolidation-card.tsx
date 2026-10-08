import { useState } from 'react';
import { Check, LoaderCircle, Library, X } from 'lucide-react';
import type { ConsolidationApplyResult, ConsolidationProposal, ConsolidationProposalItem } from '../../../shared/contracts';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton';
import { summarizeConsolidation } from './logic';

const VERDICT_LABELS: Record<ConsolidationProposalItem['verdict'], string> = { promote: 'Promote', keep: 'Keep', archive_then_remove: 'Archive then remove' };
const RESULT_LABELS: Record<ConsolidationApplyResult['status'], string> = { applied: 'Applied', failed: 'Failed', not_attempted: 'Not attempted' };

function labelOf(item: ConsolidationProposalItem): string {
  return item.verdict === 'promote' ? item.title : item.provenanceId;
}

function reasonOf(item: ConsolidationProposalItem): string {
  if (item.verdict === 'promote') return `To ${item.targetFile}: ${item.text}`;
  if (item.verdict === 'keep') return item.coveredBy ? `Covered by ${item.coveredBy}` : 'No change';
  return item.reason;
}

function ItemRow({ item, result }: { item: ConsolidationProposalItem; result: ConsolidationApplyResult | undefined }) {
  return <li>
    <em className={`verdict-${item.verdict}`}>{VERDICT_LABELS[item.verdict]}</em>
    <small>{item.provenance.source}</small>
    <strong>{labelOf(item)}</strong>
    <span>{reasonOf(item)}</span>
    {result && <em className={`result-${result.status}`} title={result.detail || undefined}>{RESULT_LABELS[result.status]}</em>}
  </li>;
}

export function ConsolidationProposalCard({ proposal, pendingResolution, onResolve }: {
  proposal: ConsolidationProposal;
  pendingResolution: 'accepted' | 'rejected' | null;
  onResolve: (resolution: 'accepted' | 'rejected') => void;
}) {
  // Keep rows mount only while the disclosure is open, so hundreds of no-op entries cost nothing by default.
  const [keepsOpen, setKeepsOpen] = useState(false);
  const { actionable, keeps, archiveCount, promoteCount, total } = summarizeConsolidation(proposal.items);
  const results = new Map((proposal.applyResults ?? []).map((result) => [result.provenanceId, result]));
  const applied = proposal.applyResults?.filter((result) => result.status === 'applied') ?? [];
  const failed = proposal.applyResults?.filter((result) => result.status === 'failed') ?? [];
  const isPending = proposal.status === 'pending';
  const busy = pendingResolution !== null;
  const entries = `${total} entr${total === 1 ? 'y' : 'ies'}`;
  return <section className="consolidation-proposal" aria-label="Consolidation proposal">
    <header>
      <Library size={15} />
      <strong>Consolidation proposal</strong>
      <small>{isPending ? new Date(proposal.createdAt).toLocaleDateString() : `Partially applied · ${applied.length} applied, ${failed.length} failed`}</small>
    </header>
    <p className="consolidation-summary">{actionable.length
      ? `${entries} reviewed: ${archiveCount} to archive, ${promoteCount} to promote, ${keeps.length} unchanged`
      : `${entries} reviewed and none need promoting or archiving.`}</p>
    {proposal.status === 'partially_applied' && <div className="consolidation-outcome" role="status">
      <p><strong>Applied:</strong> {applied.length ? applied.map((result) => result.provenanceId).join(', ') : 'none'}</p>
      <p><strong>Failed:</strong> {failed.map((result) => `${result.provenanceId} (${result.detail})`).join(', ')}</p>
    </div>}
    {actionable.length > 0 && <ol className="consolidation-items" aria-label="Items to act on">
      {actionable.map((item) => <ItemRow key={item.provenanceId} item={item} result={results.get(item.provenanceId)} />)}
    </ol>}
    {keeps.length > 0 && <details className="consolidation-keeps" open={keepsOpen} onToggle={(event) => setKeepsOpen(event.currentTarget.open)}>
      <summary>{keeps.length} unchanged (keep)</summary>
      {keepsOpen && <ol className="consolidation-items">
        {keeps.map((item) => <ItemRow key={item.provenanceId} item={item} result={results.get(item.provenanceId)} />)}
      </ol>}
    </details>}
    {isPending && <div className="consolidation-actions">
      <button className="button secondary compact" disabled={busy} onClick={() => onResolve('rejected')}>{pendingResolution === 'rejected' ? <><LoaderCircle className="spin" size={13} /> Rejecting…</> : <><X size={13} /> Reject</>}</button>
      {actionable.length > 0 && <button className="button primary compact" disabled={busy} onClick={() => onResolve('accepted')}>{pendingResolution === 'accepted' ? <><LoaderCircle className="spin" size={13} /> Accepting…</> : <><Check size={13} /> Accept: archive {archiveCount}, promote {promoteCount}</>}</button>}
    </div>}
  </section>;
}

export function ConsolidationProposalSkeleton() {
  return <section className="consolidation-proposal consolidation-proposal-skeleton" aria-hidden="true">
    <header><Skeleton width="15px" height="15px" radius="3px" /><Skeleton width="150px" height="11px" /></header>
    <SkeletonText lines={3} />
    <div className="consolidation-actions"><Skeleton width="72px" height="28px" radius="6px" /><Skeleton width="80px" height="28px" radius="6px" /></div>
  </section>;
}
