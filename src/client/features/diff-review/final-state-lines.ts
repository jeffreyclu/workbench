import type { ReviewDiffLine } from './logic.js';

/** One row of the final-state reading of a block.
 *
 * A `line` row is code that exists after the change; a `removed` row stands in
 * for a run of lines that do not. */
export type FinalStateRow =
  | { type: 'line'; line: ReviewDiffLine }
  | { type: 'removed'; key: string; count: number };

/** Re-reads a block's diff lines as the code that will exist after the change.
 *
 * A unified diff interleaves two versions of a file, so the text under the
 * reader's eye is a program that never ran. For a one-line fix that is fine;
 * for a rewritten block it means executing an interleaving in your head before
 * you can start reviewing. This drops the old side and keeps the new one, so
 * the block reads as the whole legal construct it will be.
 *
 * Deletions are collapsed rather than dropped: a block that only removes code
 * would otherwise render as nothing at all, and a replacement would silently
 * lose the fact that something used to be there. One marker per contiguous run
 * keeps that visible without reintroducing the old side as text. */
export function toFinalStateRows(lines: ReviewDiffLine[]): FinalStateRow[] {
  const rows: FinalStateRow[] = [];
  let removed: ReviewDiffLine[] = [];
  const flush = () => {
    if (removed.length === 0) return;
    rows.push({ type: 'removed', key: `${removed[0].key}-removed`, count: removed.length });
    removed = [];
  };
  for (const line of lines) {
    if (line.kind === 'deletion') {
      removed.push(line);
      continue;
    }
    flush();
    rows.push({ type: 'line', line });
  }
  flush();
  return rows;
}
