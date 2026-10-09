import type { ReviewDiffHunk, ReviewDiffLine } from '../diff-review/logic.js';

/** Where a note sits: a run of lines inside one hunk of one file. Line indexes
 * are positions in the hunk's `lines`, the same coordinates the diff pane's
 * `data-line-key` uses, so a note can be drawn on and jumped to without
 * re-deriving line numbers. */
export interface ReviewNoteAnchor {
  filePath: string;
  hunkRange: string;
  startIndex: number;
  endIndex: number;
  /** The first anchored line's text, kept so a note whose code has changed
   * underneath it is reported as outdated rather than pointing at other code. */
  excerpt: string;
}

/** A line-anchored review comment. Notes are Workbench drafts: they live in
 * this browser and are never published to GitHub or any other service. */
export interface ReviewNote {
  id: string;
  anchor: ReviewNoteAnchor;
  body: string;
  resolved: boolean;
  createdAt: string;
}

export interface ResolvedReviewNote {
  note: ReviewNote;
  /** Null when the anchored code is gone from the current diff. `hunkId` is the
   * hunk's id (what a review decision lists), not a decision id. */
  target: { hunkId: string; lineKey: string; lineNumber: number | null; kind: ReviewDiffLine['kind'] } | null;
}

export interface ReviewNoteFileGroup {
  filePath: string;
  notes: ResolvedReviewNote[];
}

export interface ReviewNoteSummary {
  total: number;
  unresolved: number;
  resolved: number;
  outdated: number;
  files: number;
}

const STORAGE_PREFIX = 'workbench.review-notes.v1:';
export const storageKeyForScope = (scopeKey: string) => `${STORAGE_PREFIX}${scopeKey}`;

function isNote(value: unknown): value is ReviewNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<ReviewNote>;
  const anchor = note.anchor as Partial<ReviewNoteAnchor> | undefined;
  return typeof note.id === 'string' && typeof note.body === 'string' && typeof note.resolved === 'boolean'
    && typeof note.createdAt === 'string' && Boolean(anchor)
    && typeof anchor?.filePath === 'string' && typeof anchor.hunkRange === 'string' && typeof anchor.excerpt === 'string'
    && Number.isInteger(anchor.startIndex) && Number.isInteger(anchor.endIndex);
}

/** Reads a scope's drafts. Unreadable or hand-edited storage yields no notes
 * rather than throwing: losing drafts is recoverable, a crashed review is not. */
export function loadReviewNotes(storage: Pick<Storage, 'getItem'>, scopeKey: string): ReviewNote[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKeyForScope(scopeKey)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isNote) : [];
  } catch {
    return [];
  }
}

/** Returns whether the write stuck, so the drawer can say a draft is not saved
 * (private mode and full quotas both throw). */
export function saveReviewNotes(storage: Pick<Storage, 'setItem' | 'removeItem'>, scopeKey: string, notes: ReviewNote[]): boolean {
  try {
    if (notes.length === 0) storage.removeItem(storageKeyForScope(scopeKey));
    else storage.setItem(storageKeyForScope(scopeKey), JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

export function createReviewNote(anchor: ReviewNoteAnchor, body: string, id: string, createdAt: string): ReviewNote {
  return { id, anchor, body: body.trim(), resolved: false, createdAt };
}

/** Finds a note's current home. A note resolves only while the hunk still
 * exists and the line at its index still reads the same; the diff changes
 * between revisions and a stale pointer must not jump to unrelated code. */
export function resolveReviewNote(note: ReviewNote, hunksByFile: ReadonlyMap<string, ReviewDiffHunk[]>): ResolvedReviewNote {
  const { filePath, hunkRange, startIndex, excerpt } = note.anchor;
  const hunk = hunksByFile.get(filePath)?.find((candidate) => candidate.range === hunkRange);
  const line = hunk?.lines[startIndex];
  if (!hunk || !line || line.text !== excerpt) return { note, target: null };
  return { note, target: { hunkId: hunk.decisionId, lineKey: line.key, lineNumber: line.newLine ?? line.oldLine, kind: line.kind } };
}

/** Groups by file in first-note order, each file's notes in reading order
 * (live notes by line, outdated ones last in the order they were written). */
export function groupReviewNotes(resolved: ResolvedReviewNote[]): ReviewNoteFileGroup[] {
  const groups = new Map<string, ResolvedReviewNote[]>();
  for (const entry of resolved) groups.set(entry.note.anchor.filePath, [...(groups.get(entry.note.anchor.filePath) ?? []), entry]);
  const position = (entry: ResolvedReviewNote) => entry.target ? entry.target.lineNumber ?? entry.note.anchor.startIndex : Number.POSITIVE_INFINITY;
  return [...groups].map(([filePath, notes]) => ({
    filePath,
    notes: notes
      .map((entry, order) => ({ entry, order }))
      .sort((a, b) => position(a.entry) - position(b.entry) || a.order - b.order)
      .map(({ entry }) => entry),
  }));
}

export function summarizeReviewNotes(resolved: ResolvedReviewNote[]): ReviewNoteSummary {
  const resolvedCount = resolved.filter((entry) => entry.note.resolved).length;
  return {
    total: resolved.length,
    unresolved: resolved.length - resolvedCount,
    resolved: resolvedCount,
    outdated: resolved.filter((entry) => !entry.target).length,
    files: new Set(resolved.map((entry) => entry.note.anchor.filePath)).size,
  };
}

/** The next unresolved, still-jumpable note after `afterId` in drawer order,
 * wrapping around; the first one when `afterId` is null or no longer listed. */
export function nextUnresolvedNote(groups: ReviewNoteFileGroup[], afterId: string | null): ResolvedReviewNote | null {
  const queue = groups.flatMap((group) => group.notes).filter((entry) => !entry.note.resolved && entry.target);
  if (queue.length === 0) return null;
  const at = queue.findIndex((entry) => entry.note.id === afterId);
  return queue[(at + 1) % queue.length] ?? null;
}

/** Turns a highlighted run of lines into a note target, or null when the
 * hunk or lines are not in the given hunks. */
export function anchorForLines(filePath: string, hunks: ReviewDiffHunk[], lines: { hunkRange: string; startIndex: number; endIndex: number }): { anchor: ReviewNoteAnchor; label: string } | null {
  const hunk = hunks.find((candidate) => candidate.range === lines.hunkRange);
  const first = hunk?.lines[lines.startIndex];
  const last = hunk?.lines[lines.endIndex];
  if (!hunk || !first || !last) return null;
  const from = first.newLine ?? first.oldLine;
  const to = last.newLine ?? last.oldLine;
  const span = lines.endIndex === lines.startIndex || from === to ? `line ${from ?? '?'}` : `lines ${from ?? '?'}–${to ?? '?'}`;
  return { anchor: { filePath, hunkRange: lines.hunkRange, startIndex: lines.startIndex, endIndex: lines.endIndex, excerpt: first.text }, label: `${filePath} · ${span}` };
}
