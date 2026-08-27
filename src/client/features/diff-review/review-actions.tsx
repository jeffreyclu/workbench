import { memo, useState } from 'react';
import { AlertTriangle, Check, MessageSquare } from 'lucide-react';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';

export const DiffReviewActions = memo(function DiffReviewActions({ initialNote, saving, error, onSave }: {
  initialNote: string | null;
  saving: boolean;
  error: string | null;
  onSave: (state: DiffHunkReviewState, note: string | undefined) => void;
}) {
  const [note, setNote] = useState(initialNote ?? '');
  const save = (state: DiffHunkReviewState) => onSave(state, note.trim() || undefined);
  return <section className="diff-review-actions" aria-label="Review actions">
    <label htmlFor="diff-review-note">Review note <span>Optional</span></label>
    <textarea id="diff-review-note" value={note} onChange={(event) => setNote(event.target.value)} disabled={saving} placeholder="What should the author know?" rows={3} />
    {error && <p role="alert">Could not save this decision. {error}</p>}
    <div>
      <button type="button" className="review-approve" disabled={saving} onClick={() => save('reviewed')}><Check size={15} aria-hidden="true" />Approve</button>
      <button type="button" className="review-needs-changes" disabled={saving} onClick={() => save('needs_changes')}><AlertTriangle size={15} aria-hidden="true" />Needs changes</button>
      <button type="button" className="review-comment" disabled={saving} onClick={() => save('commented')}><MessageSquare size={15} aria-hidden="true" />Commented</button>
    </div>
    {saving && <span className="diff-review-saving" role="status">Saving decision…</span>}
  </section>;
});
