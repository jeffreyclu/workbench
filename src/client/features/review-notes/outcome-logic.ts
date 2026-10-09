import { AGENT_REVIEW_NOTE_PREFIX } from '../../../shared/review-harness.js';
import type { ReviewDecision, ReviewDiffHunk } from '../diff-review/logic.js';
import { isWhitespaceOnlyHunk } from '../diff-review/whitespace.js';
import type { ResolvedReviewNote } from './notes-logic.js';

/** The visible outcome of a review, separate from the per-hunk decisions that
 * feed it (GitHub's model: Approved / Changes requested / Commented, or still
 * pending while any decision is unanswered). */
export type ReviewOutcomeStatus = 'pending' | 'needs_changes' | 'commented' | 'approved';

export interface OutcomeQueueItem {
  /** `decision:<id>` or `note:<id>`; stable across renders so next/previous can find its place. */
  key: string;
  kind: 'decision' | 'note';
  filePath: string;
  label: string;
  decisionId?: string;
  note?: ResolvedReviewNote;
}

export interface LedgerVerdict {
  decisionId: string;
  ordinal: number;
  behavior: string;
  severity: 'blocking' | 'non-blocking';
}

export interface ReviewOutcome {
  status: ReviewOutcomeStatus;
  decisions: { total: number; approved: number; needsChanges: number; commented: number; pending: number };
  notes: { open: number; resolved: number; outdated: number };
  /** Needs-changes decisions plus open notes: what still blocks closing the review. */
  unresolvedFeedback: number;
  fixRequests: number;
  whitespaceOnlyFiles: string[];
  ledgerVerdicts: LedgerVerdict[];
  queue: OutcomeQueueItem[];
}

export function whitespaceOnlyFiles(hunksByFile: ReadonlyMap<string, ReviewDiffHunk[]>): string[] {
  return [...hunksByFile].filter(([, hunks]) => hunks.length > 0 && hunks.every(isWhitespaceOnlyHunk)).map(([path]) => path);
}

export function reviewOutcomeStatus(counts: ReviewOutcome['decisions'], openNotes: number): ReviewOutcomeStatus {
  if (counts.needsChanges > 0) return 'needs_changes';
  if (counts.pending > 0) return 'pending';
  if (counts.commented > 0 || openNotes > 0) return 'commented';
  return 'approved';
}

/** Verdicts the review agent's ledger recorded. They are identified by the note
 * the harness writes, since a ledger verdict is stored as an ordinary decision
 * state: blocking became Needs changes, non-blocking became Commented. */
export function ledgerVerdictsOf(decisions: ReviewDecision[]): LedgerVerdict[] {
  return decisions.flatMap((decision) => {
    if (!decision.note?.startsWith(AGENT_REVIEW_NOTE_PREFIX)) return [];
    if (decision.state !== 'needs_changes' && decision.state !== 'commented') return [];
    return [{ decisionId: decision.id, ordinal: decision.ordinal, behavior: decision.behavior, severity: decision.state === 'needs_changes' ? 'blocking' as const : 'non-blocking' as const }];
  });
}

/** Unresolved items across files in reading order: files as the diff lists
 * them, a file's needs-changes decisions first, then its open notes by line.
 * Outdated notes have nowhere to jump, so they are counted but not queued. */
export function buildOutcomeQueue(decisions: ReviewDecision[], noteGroups: { filePath: string; notes: ResolvedReviewNote[] }[], fileOrder: string[]): OutcomeQueueItem[] {
  const items: OutcomeQueueItem[] = [];
  const rank = (filePath: string) => { const at = fileOrder.indexOf(filePath); return at === -1 ? fileOrder.length : at; };
  for (const decision of decisions) {
    if (decision.state !== 'needs_changes') continue;
    items.push({ key: `decision:${decision.id}`, kind: 'decision', filePath: decision.filePaths[0] ?? '', label: `Decision ${decision.ordinal} needs changes — ${decision.behavior}`, decisionId: decision.id });
  }
  const fileNotes = noteGroups.flatMap((group) => group.notes
    .filter((entry) => !entry.note.resolved && entry.target)
    .map((entry) => ({ filePath: group.filePath, entry })));
  for (const { filePath, entry } of fileNotes) {
    items.push({ key: `note:${entry.note.id}`, kind: 'note', filePath, label: entry.note.body, note: entry });
  }
  // Array sort is stable, so within a file decisions stay ahead of notes and
  // notes keep the drawer's line order.
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => rank(a.item.filePath) - rank(b.item.filePath) || a.order - b.order)
    .map(({ item }) => item);
}

/** Steps through the queue with wrap-around. With no current item, next is the
 * first and previous is the last. */
export function stepOutcomeQueue(queue: OutcomeQueueItem[], currentKey: string | null, direction: 1 | -1): OutcomeQueueItem | null {
  if (queue.length === 0) return null;
  const at = queue.findIndex((item) => item.key === currentKey);
  if (at === -1) return direction === 1 ? queue[0]! : queue[queue.length - 1]!;
  return queue[(at + direction + queue.length) % queue.length]!;
}

export function buildReviewOutcome(input: {
  decisions: ReviewDecision[];
  noteGroups: { filePath: string; notes: ResolvedReviewNote[] }[];
  noteSummary: { unresolved: number; resolved: number; outdated: number };
  hunksByFile: ReadonlyMap<string, ReviewDiffHunk[]>;
  fixRequests: number;
}): ReviewOutcome {
  const { decisions } = input;
  const counts = {
    total: decisions.length,
    approved: decisions.filter((d) => d.state === 'reviewed').length,
    needsChanges: decisions.filter((d) => d.state === 'needs_changes').length,
    commented: decisions.filter((d) => d.state === 'commented').length,
    pending: decisions.filter((d) => d.state === null).length,
  };
  return {
    status: reviewOutcomeStatus(counts, input.noteSummary.unresolved),
    decisions: counts,
    notes: { open: input.noteSummary.unresolved, resolved: input.noteSummary.resolved, outdated: input.noteSummary.outdated },
    unresolvedFeedback: counts.needsChanges + input.noteSummary.unresolved,
    fixRequests: input.fixRequests,
    whitespaceOnlyFiles: whitespaceOnlyFiles(input.hunksByFile),
    ledgerVerdicts: ledgerVerdictsOf(decisions),
    queue: buildOutcomeQueue(decisions, input.noteGroups, [...input.hunksByFile.keys()]),
  };
}
