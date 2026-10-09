import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewDiffHunk } from '../diff-review/logic.js';
import {
  createReviewNote, groupReviewNotes, loadReviewNotes, resolveReviewNote, saveReviewNotes, summarizeReviewNotes,
  type ReviewNote, type ReviewNoteAnchor,
} from './notes-logic.js';

let noteCounter = 0;
/** `crypto.randomUUID` is absent on plain-http origins, which a LAN-served
 * Workbench is, so ids come from the clock plus a per-page counter. */
const newNoteId = () => `note-${Date.now().toString(36)}-${(noteCounter += 1).toString(36)}`;

/** The scope's local draft notes. Storage is the source of truth: state is
 * reloaded when the scope changes and written back on every edit, so a note
 * survives a reload and never leaks into another review. */
export function useReviewNotes(scopeKey: string, hunksByFile: ReadonlyMap<string, ReviewDiffHunk[]>) {
  const [state, setState] = useState(() => ({ scopeKey, notes: loadReviewNotes(window.localStorage, scopeKey) }));
  const [saveFailed, setSaveFailed] = useState(false);
  // Derived during render rather than in an effect, so a scope switch never
  // paints the previous scope's notes for a frame.
  const notes = useMemo(() => state.scopeKey === scopeKey ? state.notes : loadReviewNotes(window.localStorage, scopeKey), [scopeKey, state]);

  useEffect(() => {
    if (state.scopeKey !== scopeKey) setState({ scopeKey, notes });
  }, [notes, scopeKey, state.scopeKey]);

  const update = useCallback((change: (current: ReviewNote[]) => ReviewNote[]) => {
    const next = change(notes);
    setSaveFailed(!saveReviewNotes(window.localStorage, scopeKey, next));
    setState({ scopeKey, notes: next });
  }, [notes, scopeKey]);

  const addNote = useCallback((anchor: ReviewNoteAnchor, body: string) => {
    if (!body.trim()) return;
    update((current) => [...current, createReviewNote(anchor, body, newNoteId(), new Date().toISOString())]);
  }, [update]);
  const toggleResolved = useCallback((id: string) => update((current) => current.map((note) => note.id === id ? { ...note, resolved: !note.resolved } : note)), [update]);
  const removeNote = useCallback((id: string) => update((current) => current.filter((note) => note.id !== id)), [update]);

  const resolved = useMemo(() => notes.map((note) => resolveReviewNote(note, hunksByFile)), [notes, hunksByFile]);
  const groups = useMemo(() => groupReviewNotes(resolved), [resolved]);
  const summary = useMemo(() => summarizeReviewNotes(resolved), [resolved]);
  return { groups, summary, saveFailed, addNote, toggleResolved, removeNote };
}
