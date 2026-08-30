import { memo, useState } from 'react';
import { Check, ChevronRight, MessageSquare, TriangleAlert } from 'lucide-react';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';
import { changeTypeLabel } from '../../../shared/change-type.js';
import type { ReviewQueueEntry } from './review-queue.js';

function StateGlyph({ state }: { state: DiffHunkReviewState | null }) {
  if (state === 'reviewed') return <Check size={11} aria-hidden="true" />;
  if (state === 'needs_changes') return <TriangleAlert size={10} aria-hidden="true" />;
  if (state === 'commented') return <MessageSquare size={10} aria-hidden="true" />;
  return null;
}

function QueueRow({ entry, isActive, onSelect }: { entry: ReviewQueueEntry; isActive: boolean; onSelect: (id: string) => void }) {
  const { decision, routing, relationships } = entry;
  return <li className={`review-queue-row tier-${routing.tier.toLowerCase()}${isActive ? ' is-active' : ''}${decision.state ? ' is-judged' : ''}`}>
    <button type="button" aria-current={isActive} onClick={() => onSelect(decision.id)}>
      <span className="review-queue-tier" title={routing.reason}>{routing.tier}</span>
      <span className="review-queue-body">
        <strong>{decision.subject ?? decision.behavior}</strong>
        {/* The reason, not the score: a queue that sorts without saying why
            gets overridden or ignored. */}
        <em>{routing.reason}</em>
        <small>
          {changeTypeLabel(decision.changeType)} · +{decision.additions}/−{decision.deletions}
          {relationships.degree > 0 && ` · ${relationships.degree} related`}
          {entry.showsMap && ' · map'}
        </small>
      </span>
      <span className="review-queue-state"><StateGlyph state={decision.state} /></span>
    </button>
  </li>;
}

/** The spine of the review stack: what deserves attention, in that order.
 *
 * Auto-settled blocks are collapsed behind a disclosure rather than hidden.
 * They were settled by proof, so they should not cost a queue position — but
 * a reviewer who wants to see what was decided for them must be able to. */
export const ReviewQueueList = memo(function ReviewQueueList({ queue, activeId, onSelect }: {
  queue: ReviewQueueEntry[];
  activeId: string | null;
  onSelect: (decisionId: string) => void;
}) {
  const [showSettled, setShowSettled] = useState(false);
  const open = queue.filter((entry) => !entry.routing.autoSettled);
  const settled = queue.filter((entry) => entry.routing.autoSettled);

  return <nav className="review-queue" aria-label="Review queue">
    <ol>
      {open.map((entry) => <QueueRow key={entry.decision.id} entry={entry} isActive={entry.decision.id === activeId} onSelect={onSelect} />)}
    </ol>
    {open.length === 0 && <p className="review-queue-empty">Nothing here needs a judgment call.</p>}
    {settled.length > 0 && <div className="review-queue-settled">
      <button type="button" aria-expanded={showSettled} onClick={() => setShowSettled((value) => !value)}>
        <ChevronRight size={12} aria-hidden="true" className={showSettled ? 'is-open' : undefined} />
        {settled.length} settled automatically
      </button>
      {showSettled && <ol>
        {settled.map((entry) => <QueueRow key={entry.decision.id} entry={entry} isActive={entry.decision.id === activeId} onSelect={onSelect} />)}
      </ol>}
    </div>}
  </nav>;
});
