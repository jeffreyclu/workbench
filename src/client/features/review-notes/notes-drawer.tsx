import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsDown, NotebookPen, Trash2, X } from 'lucide-react';
import type { ReviewNoteAnchor, ReviewNoteFileGroup, ReviewNoteSummary, ResolvedReviewNote } from './notes-logic.js';

export interface PendingNote {
  anchor: ReviewNoteAnchor;
  /** Human label for the lines being noted, e.g. `src/a.ts · lines 4–6`. */
  label: string;
}

/** Local review notes: a composer for the line range just chosen in the diff,
 * and every draft listed by file and line with a jump back to the code. These
 * are Workbench drafts — nothing here is sent to GitHub or any other service. */
export const ReviewNotesDrawer = memo(function ReviewNotesDrawer({ outcome, groups, summary, pending, saveFailed, onSave, onCancelPending, onJump, onNextUnresolved, onToggleResolved, onRemove, onClose }: {
  /** The review outcome panel, shown above the notes. */
  outcome?: ReactNode;
  groups: ReviewNoteFileGroup[];
  summary: ReviewNoteSummary;
  pending: PendingNote | null;
  saveFailed: boolean;
  onSave: (body: string) => void;
  onCancelPending: () => void;
  onJump: (entry: ResolvedReviewNote) => void;
  onNextUnresolved: () => void;
  onToggleResolved: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const pendingId = pending ? `${pending.anchor.filePath}|${pending.anchor.hunkRange}|${pending.anchor.startIndex}|${pending.anchor.endIndex}` : null;

  // A new target starts a fresh draft and takes focus, so choosing lines then
  // typing needs no extra click.
  useEffect(() => {
    setBody('');
    if (pendingId) composer.current?.focus();
  }, [pendingId]);

  const submit = () => {
    if (!body.trim()) return;
    onSave(body);
    setBody('');
  };

  return <aside className="review-notes-drawer" role="complementary" aria-label="Review notes" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <header>
      <h3><NotebookPen size={14} aria-hidden="true" /> Review notes</h3>
      <button type="button" className="review-notes-close" aria-label="Close review notes" onClick={onClose}><X size={14} aria-hidden="true" /></button>
    </header>
    {outcome}
    <p className="review-notes-draft-label">Drafts saved in this browser. Not published to GitHub.</p>
    {saveFailed && <p className="review-notes-warning" role="alert">This browser would not store your notes; they will be lost on reload.</p>}
    <p className="review-notes-summary" role="status">
      {summary.total === 0
        ? 'No notes yet.'
        : `${summary.unresolved} open · ${summary.resolved} resolved · ${summary.total} in ${summary.files} ${summary.files === 1 ? 'file' : 'files'}${summary.outdated > 0 ? ` · ${summary.outdated} outdated` : ''}`}
    </p>
    {pending
      ? <form className="review-notes-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <label>
            <span>Note on {pending.label}</span>
            <textarea ref={composer} value={body} rows={3} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div>
            <button type="submit" className="button compact" disabled={!body.trim()}>Save draft note</button>
            <button type="button" className="button secondary compact" onClick={onCancelPending}>Cancel</button>
          </div>
        </form>
      : <p className="muted review-notes-hint">Highlight lines in the diff, then choose “Add note”.</p>}
    {summary.unresolved > 0 && <button type="button" className="button secondary compact review-notes-next" onClick={onNextUnresolved}><ChevronsDown size={13} aria-hidden="true" /> Next open note</button>}
    {groups.map((group) => <section key={group.filePath} aria-label={`Notes in ${group.filePath}`}>
      <h4>{group.filePath}</h4>
      <ul>
        {group.notes.map((entry) => <li key={entry.note.id} className={entry.note.resolved ? 'resolved' : undefined}>
          {entry.target
            ? <button type="button" className="review-notes-jump" onClick={() => onJump(entry)} aria-label={`Jump to ${group.filePath} ${lineLabel(entry)}`}>{lineLabel(entry)}</button>
            : <span className="review-notes-outdated" title="The code this note was written on has changed.">Outdated</span>}
          <p>{entry.note.body}</p>
          <div>
            <button type="button" aria-pressed={entry.note.resolved} onClick={() => onToggleResolved(entry.note.id)}><Check size={12} aria-hidden="true" /> {entry.note.resolved ? 'Reopen' : 'Resolve'}</button>
            <button type="button" aria-label={`Delete note on ${group.filePath} ${lineLabel(entry)}`} onClick={() => onRemove(entry.note.id)}><Trash2 size={12} aria-hidden="true" /></button>
          </div>
        </li>)}
      </ul>
    </section>)}
  </aside>;
});

function lineLabel(entry: ResolvedReviewNote): string {
  const { startIndex, endIndex } = entry.note.anchor;
  if (!entry.target) return `lines ${startIndex + 1}–${endIndex + 1} of an earlier hunk`;
  const span = endIndex - startIndex;
  return `line ${entry.target.lineNumber ?? '?'}${span > 0 ? ` (+${span})` : ''}`;
}
