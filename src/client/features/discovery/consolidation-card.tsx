import { Check, LoaderCircle, Library, X } from 'lucide-react';
import type { ConsolidationApplyResult, ConsolidationProposal, ConsolidationProposalItem } from '../../../shared/contracts';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton';

const VERDICT_LABELS: Record<ConsolidationProposalItem['verdict'], string> = { promote: 'Promote', keep: 'Keep', archive_then_remove: 'Archive then remove' };
const RESULT_LABELS: Record<ConsolidationApplyResult['status'], string> = { applied: 'Applied', failed: 'Failed', not_attempted: 'Not attempted' };

function targetOf(item: ConsolidationProposalItem): string {
  if (item.verdict === 'promote') return `To ${item.targetFile}`;
  if (item.verdict === 'keep') return item.coveredBy ? `Covered by ${item.coveredBy}` : 'No change';
  return 'To discard-log.md';
}

function reasonOf(item: ConsolidationProposalItem): string {
  if (item.verdict === 'promote') return `${item.title}: ${item.text}`;
  if (item.verdict === 'keep') return item.coveredBy ? 'Already covered by an existing entry.' : 'Leave as it is.';
  return item.reason;
}

export function ConsolidationProposalCard({ proposal, pendingResolution, onResolve }: {
  proposal: ConsolidationProposal;
  pendingResolution: 'accepted' | 'rejected' | null;
  onResolve: (resolution: 'accepted' | 'rejected') => void;
}) {
  const results = new Map((proposal.applyResults ?? []).map((result) => [result.provenanceId, result]));
  const applied = proposal.applyResults?.filter((result) => result.status === 'applied') ?? [];
  const failed = proposal.applyResults?.filter((result) => result.status === 'failed') ?? [];
  const isPending = proposal.status === 'pending';
  const busy = pendingResolution !== null;
  return <section className="consolidation-proposal" aria-label="Consolidation proposal">
    <header>
      <Library size={15} />
      <strong>Consolidation proposal</strong>
      <small>{isPending ? `${proposal.items.length} item${proposal.items.length === 1 ? '' : 's'} · ${new Date(proposal.createdAt).toLocaleDateString()}` : `Partially applied · ${applied.length} applied, ${failed.length} failed`}</small>
    </header>
    {proposal.status === 'partially_applied' && <div className="consolidation-outcome" role="status">
      <p><strong>Applied:</strong> {applied.length ? applied.map((result) => result.provenanceId).join(', ') : 'none'}</p>
      <p><strong>Failed:</strong> {failed.map((result) => `${result.provenanceId} (${result.detail})`).join(', ')}</p>
    </div>}
    <ol>
      {proposal.items.map((item) => {
        const result = results.get(item.provenanceId);
        return <li key={item.provenanceId}>
          <div><em className={`verdict-${item.verdict}`}>{VERDICT_LABELS[item.verdict]}</em><span>{targetOf(item)}</span>{result && <em className={`result-${result.status}`}>{RESULT_LABELS[result.status]}</em>}</div>
          <p>{reasonOf(item)}</p>
          <small>{item.provenanceId}</small>
          {result && result.status !== 'not_attempted' && <small>{result.detail}</small>}
        </li>;
      })}
    </ol>
    {isPending && <div className="consolidation-actions">
      <button className="button secondary compact" disabled={busy} onClick={() => onResolve('rejected')}>{pendingResolution === 'rejected' ? <><LoaderCircle className="spin" size={13} /> Rejecting…</> : <><X size={13} /> Reject</>}</button>
      <button className="button primary compact" disabled={busy} onClick={() => onResolve('accepted')}>{pendingResolution === 'accepted' ? <><LoaderCircle className="spin" size={13} /> Accepting…</> : <><Check size={13} /> Accept</>}</button>
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
