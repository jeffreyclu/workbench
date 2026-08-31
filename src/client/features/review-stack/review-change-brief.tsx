import { memo } from 'react';
import { Check } from 'lucide-react';
import { REVIEW_TIER_LABELS } from './review-routing.js';
import type { ReviewQueueEntry } from './review-queue.js';

/** Hazard and effect names arrive as compiler slugs. They are read here, not
 * matched, so they are spelled as words. */
function words(slug: string): string {
  return slug.replace(/_/g, ' ');
}

/**
 * What a handle press opens.
 *
 * The gutter marker and the canvas node both name one change, so pressing
 * either has to produce the thing a reviewer is missing while looking at that
 * change: why it was put in front of them, what has to be true for it to be
 * fine, and the verdict. It expands in flow directly under the block header
 * rather than floating over the code — the card is two scrolling panes, and
 * anything absolute inside the code pane is clipped at its edge.
 */
export const ReviewChangeBrief = memo(function ReviewChangeBrief({ entry, saving, error, onMarkReviewed, onClose }: {
  entry: ReviewQueueEntry;
  saving: boolean;
  error: string | null;
  onMarkReviewed: () => void;
  onClose: () => void;
}) {
  const { routing, analysis, obligations, decision } = entry;
  const settled = decision.state === 'reviewed';
  return <section className="review-change-brief" aria-label={`Change ${decision.ordinal} — what to check`}>
    <p className="review-change-brief-routing">
      <b>{REVIEW_TIER_LABELS[routing.tier]}</b>
      <span>{routing.reason}</span>
      <button type="button" className="review-change-brief-close" onClick={onClose} aria-label="Close this change">Close</button>
    </p>
    {analysis && <p className="review-change-brief-effect">
      <span>{words(analysis.effect)}</span>
      {analysis.hazards.map((hazard) => <em key={hazard}>{words(hazard)}</em>)}
    </p>}
    {obligations.length > 0 && <ul className="review-change-brief-obligations">
      {obligations.map((obligation) => <li key={obligation.id} className={`outcome-${obligation.outcome}`}>
        <span>{obligation.question}</span>
        {obligation.evidence && <small>{obligation.evidence}</small>}
      </li>)}
    </ul>}
    <div className="review-change-brief-actions">
      {error && <p role="alert">Could not save this decision. {error}</p>}
      <button type="button" className="review-approve" disabled={saving || settled} onClick={onMarkReviewed}>
        <Check size={14} aria-hidden="true" />{settled ? 'Reviewed' : 'Mark reviewed'}
      </button>
      {saving && <span role="status">Saving…</span>}
    </div>
  </section>;
});
