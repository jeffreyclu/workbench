import { memo, useEffect, useState } from 'react';
import { MessageSquare, Pencil, TriangleAlert } from 'lucide-react';
import type { DiffHunkReviewState } from '../../../shared/contracts.js';
import { MarkdownComposer } from '../../components/markdown/markdown-composer.js';

/** The composer, pointed at a review block instead of at an agent.
 *
 * Review already stored a note per block and already drew the `commented` and
 * `needs_changes` glyphs in the queue, but nothing could ever write either one:
 * the only action was "Reviewed". This is that missing half. It is deliberately
 * the same composer the conversation uses — a reviewer writing markdown should
 * not meet a second, lesser text box — but what it produces is a verdict on a
 * block, not a message to anyone.
 *
 * It stays closed behind the pencil until asked for. An open editor under every
 * block invites line-by-line commentary, which is the reading order this
 * surface exists to break. */
export const ReviewBlockNote = memo(function ReviewBlockNote({ blockId, note, saving, error, onSave }: {
  blockId: string;
  /** The note already saved against this block, if any. */
  note: string | null;
  saving: boolean;
  error: string | null;
  onSave: (state: DiffHunkReviewState, note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  // A new block is a new question. Carrying a half-written note across the
  // selection would attach it to code it was never about.
  useEffect(() => { setOpen(false); setDraft(''); }, [blockId]);

  const body = draft.trim();
  const submit = (state: DiffHunkReviewState) => {
    if (!body) return;
    onSave(state, body);
    setOpen(false);
    setDraft('');
  };

  return <section className="review-block-note" aria-label="Comment on this block">
    {note && !open && <blockquote className="review-block-note-saved">
      <MessageSquare size={11} aria-hidden="true" />
      <p>{note}</p>
    </blockquote>}

    {open
      ? <>
        <MarkdownComposer
          conversationId={`review-block-${blockId}`}
          value={draft}
          onChange={setDraft}
          autoFocus
          placeholder="What is wrong here, or what did you check?"
          ariaLabel="Comment on this block"
          className="review-block-note-composer"
          disabled={saving}
        />
        {error && <p role="alert">Could not save this comment. {error}</p>}
        <div className="review-block-note-actions">
          <button type="button" className="button secondary compact" disabled={saving} onClick={() => { setOpen(false); setDraft(''); }}>Cancel</button>
          {/* Two verdicts, because a note that only observes and a note that
              blocks the change are not the same answer to the queue. */}
          <button type="button" className="button secondary compact" disabled={!body || saving} onClick={() => submit('commented')}>
            <MessageSquare size={13} aria-hidden="true" /> Comment
          </button>
          <button type="button" className="button primary compact review-request-changes" disabled={!body || saving} onClick={() => submit('needs_changes')}>
            <TriangleAlert size={13} aria-hidden="true" /> Request changes
          </button>
        </div>
      </>
      : <button type="button" className="icon-button review-block-note-open" onClick={() => setOpen(true)} aria-label={note ? 'Edit the comment on this block' : 'Comment on this block'} title={note ? 'Edit the comment on this block' : 'Comment on this block'}>
        <Pencil size={13} aria-hidden="true" />
      </button>}
  </section>;
});
