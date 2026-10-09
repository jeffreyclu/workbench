import { memo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { LedgerVerdict, OutcomeQueueItem, ReviewOutcome, ReviewOutcomeStatus } from './outcome-logic.js';

const STATUS_LABEL: Record<ReviewOutcomeStatus, string> = {
  pending: 'Review in progress',
  needs_changes: 'Changes requested',
  commented: 'Commented',
  approved: 'Approved',
};

/** The review's visible outcome: overall status, decision totals, unresolved
 * feedback and the ordered queue of what is left, each with a jump. */
export const ReviewOutcomePanel = memo(function ReviewOutcomePanel({ outcome, activeKey, onJumpItem, onStep, onJumpDecision, onJumpFile }: {
  outcome: ReviewOutcome;
  activeKey: string | null;
  onJumpItem: (item: OutcomeQueueItem) => void;
  onStep: (direction: 1 | -1) => void;
  onJumpDecision: (verdict: LedgerVerdict) => void;
  onJumpFile: (filePath: string) => void;
}) {
  const { decisions, notes } = outcome;
  const position = outcome.queue.findIndex((item) => item.key === activeKey);
  return <section className="review-outcome" aria-label="Review outcome">
    <p className={`review-outcome-status is-${outcome.status}`}><strong>{STATUS_LABEL[outcome.status]}</strong></p>
    <dl className="review-outcome-counts">
      <div><dt>Approved</dt><dd>{decisions.approved}</dd></div>
      <div><dt>Needs changes</dt><dd>{decisions.needsChanges}</dd></div>
      <div><dt>Commented</dt><dd>{decisions.commented}</dd></div>
      <div><dt>Pending</dt><dd>{decisions.pending}</dd></div>
      <div><dt>Open notes</dt><dd>{notes.open}</dd></div>
      <div><dt>Resolved notes</dt><dd>{notes.resolved}</dd></div>
    </dl>
    <p className="review-outcome-line">{outcome.unresolvedFeedback} unresolved {outcome.unresolvedFeedback === 1 ? 'item' : 'items'} · {outcome.fixRequests} fix {outcome.fixRequests === 1 ? 'request' : 'requests'} sent</p>
    {outcome.ledgerVerdicts.length > 0 && <div className="review-outcome-block">
      <h4>Review ledger</h4>
      <ul>{outcome.ledgerVerdicts.map((verdict) => <li key={verdict.decisionId}>
        <button type="button" onClick={() => onJumpDecision(verdict)} aria-label={`Jump to decision ${verdict.ordinal}`}>D{verdict.ordinal} · {verdict.severity}</button>
        <span>{verdict.behavior}</span>
      </li>)}</ul>
    </div>}
    {outcome.whitespaceOnlyFiles.length > 0 && <div className="review-outcome-block">
      <h4>Whitespace-only files ({outcome.whitespaceOnlyFiles.length})</h4>
      <ul>{outcome.whitespaceOnlyFiles.map((path) => <li key={path}><button type="button" onClick={() => onJumpFile(path)} aria-label={`Jump to whitespace-only file ${path}`}>{path}</button></li>)}</ul>
    </div>}
    <div className="review-outcome-block">
      <h4>Unresolved queue{outcome.queue.length > 0 ? ` (${position === -1 ? '' : `${position + 1} of `}${outcome.queue.length})` : ''}</h4>
      {outcome.queue.length === 0
        ? <p className="muted">Nothing unresolved.</p>
        : <>
            <div className="review-outcome-step">
              <button type="button" className="button secondary compact" onClick={() => onStep(-1)}><ChevronUp size={13} aria-hidden="true" /> Previous unresolved</button>
              <button type="button" className="button secondary compact" onClick={() => onStep(1)}><ChevronDown size={13} aria-hidden="true" /> Next unresolved</button>
            </div>
            <ol>{outcome.queue.map((item) => <li key={item.key} className={item.key === activeKey ? 'is-active' : undefined}>
              <button type="button" onClick={() => onJumpItem(item)} aria-current={item.key === activeKey ? 'true' : undefined} aria-label={`Jump to ${item.kind} in ${item.filePath}: ${item.label}`}>{item.filePath}</button>
              <span>{item.label}</span>
            </li>)}</ol>
          </>}
    </div>
  </section>;
});
