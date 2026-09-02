import { memo } from 'react';
import { Check, MessageSquareText, SkipForward } from 'lucide-react';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';

/** The three ways out of a change: accept it, hand it to the agent to discuss, or
 * leave it owed and read the next one. Fix and Skip are optional because they
 * need a surface that can receive them — a composer to write into, a queue to
 * advance. Where neither exists, this stays the single accept button it was. */
export const DiffReviewActions = memo(function DiffReviewActions({ saving, error, onSave, onFix, onSkip }: {
  saving: boolean;
  error: string | null;
  onSave: (state: DiffHunkReviewState) => void;
  /** Writes this change into the conversation composer, where the reviewer
   * finishes the sentence and sends it to the agent. */
  onFix?: () => void;
  /** Moves to the next change without recording anything. The decision stays
   * pending, so the queue and the counts still owe it. */
  onSkip?: () => void;
}) {
  return <section className="diff-review-actions" aria-label="Review actions">
    {error && <p role="alert">Could not save this decision. {error}</p>}
    <div>
      <button type="button" className="review-approve" disabled={saving} onClick={() => onSave('reviewed')}><Check size={15} aria-hidden="true" />Reviewed</button>
      {onFix && <button type="button" className="review-fix" disabled={saving} onClick={onFix} title="Send this change to the composer to ask a question or request a fix"><MessageSquareText size={15} aria-hidden="true" />Ask</button>}
      {onSkip && <button type="button" className="review-skip" onClick={onSkip} title="Leave this change unreviewed and read the next one"><SkipForward size={15} aria-hidden="true" />Skip</button>}
    </div>
    {saving && <span className="diff-review-saving" role="status">Saving decision…</span>}
  </section>;
});
