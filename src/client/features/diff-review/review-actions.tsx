import { memo, useState } from 'react';
import { Check } from 'lucide-react';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';

export const DiffReviewActions = memo(function DiffReviewActions({ initialNote, saving, error, onSave }: {
  initialNote: string | null;
  saving: boolean;
  error: string | null;
  onSave: (state: DiffHunkReviewState, note: string | undefined) => void;
}) {
  const [note, setNote] = useState(initialNote ?? '');
  return <section className="diff-review-actions" aria-label="Review actions">
    <label htmlFor="diff-review-note">Note <span>Optional</span></label>
    <textarea id="diff-review-note" value={note} onChange={(event) => setNote(event.target.value)} disabled={saving} placeholder="What should the author know?" rows={3} />
    {error && <p role="alert">Could not save this decision. {error}</p>}
    <div>
      <button type="button" className="review-approve" disabled={saving} onClick={() => onSave('reviewed', note.trim() || undefined)}><Check size={15} aria-hidden="true" />Reviewed</button>
    </div>
    {saving && <span className="diff-review-saving" role="status">Saving decision…</span>}
  </section>;
});
