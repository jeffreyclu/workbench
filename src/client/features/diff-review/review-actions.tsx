import { memo } from 'react';
import { Check, MessageSquarePlus } from 'lucide-react';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';

/** The two things a reviewer can do with a decision: accept it, or hand it back
 * to the agent. There is no free-text note here — a concern belongs in the
 * conversation with the agent, where it can be answered and acted on. */
export const DiffReviewActions = memo(function DiffReviewActions({ saving, error, onSave, onFollowUp }: {
  saving: boolean;
  error: string | null;
  onSave: (state: DiffHunkReviewState) => void;
  onFollowUp: (() => void) | undefined;
}) {
  return <section className="diff-review-actions" aria-label="Review actions">
    {error && <p role="alert">Could not save this decision. {error}</p>}
    <div>
      <button type="button" className="review-approve" disabled={saving} onClick={() => onSave('reviewed')}><Check size={15} aria-hidden="true" />Reviewed</button>
      {onFollowUp && <button type="button" className="review-follow-up" disabled={saving} onClick={onFollowUp} title="Attach this decision, its hunks and its risk to the composer">
        <MessageSquarePlus size={15} aria-hidden="true" />Follow up
      </button>}
    </div>
    {saving && <span className="diff-review-saving" role="status">Saving decision…</span>}
  </section>;
});
