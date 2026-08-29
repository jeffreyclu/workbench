import { memo } from 'react';
import { Check } from 'lucide-react';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';

/** Accepting a decision is the only action this surface takes. Handing work
 * back to the agent belongs in the conversation with it, where it can be
 * answered and acted on — not as a second button on every hunk. */
export const DiffReviewActions = memo(function DiffReviewActions({ saving, error, onSave }: {
  saving: boolean;
  error: string | null;
  onSave: (state: DiffHunkReviewState) => void;
}) {
  return <section className="diff-review-actions" aria-label="Review actions">
    {error && <p role="alert">Could not save this decision. {error}</p>}
    <div>
      <button type="button" className="review-approve" disabled={saving} onClick={() => onSave('reviewed')}><Check size={15} aria-hidden="true" />Reviewed</button>
    </div>
    {saving && <span className="diff-review-saving" role="status">Saving decision…</span>}
  </section>;
});
