import type { ReviewDiffLine } from './logic.js';

/** One row of the side-by-side reading of a block. Either side is null where
 * the other has no counterpart: a pure deletion has no right, a pure addition
 * no left. */
export interface SplitRow {
  key: string;
  left: ReviewDiffLine | null;
  right: ReviewDiffLine | null;
}

/** Lays a block's unified lines out as before/after pairs.
 *
 * Context appears on both sides. A run of deletions followed by a run of
 * additions is a rewrite, so its lines are paired in order; the longer run
 * leaves blanks opposite its surplus. Every input line lands in exactly one
 * cell, so nothing a reviewer could search for or select is lost. */
export function toSplitRows(lines: ReviewDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === 'context') {
      rows.push({ key: line.key, left: line, right: line });
      index += 1;
      continue;
    }
    const deletions: ReviewDiffLine[] = [];
    const additions: ReviewDiffLine[] = [];
    while (lines[index]?.kind === 'deletion') deletions.push(lines[index++]!);
    while (lines[index]?.kind === 'addition') additions.push(lines[index++]!);
    for (let pair = 0; pair < Math.max(deletions.length, additions.length); pair += 1) {
      const left = deletions[pair] ?? null;
      const right = additions[pair] ?? null;
      rows.push({ key: (left ?? right)!.key, left, right });
    }
  }
  return rows;
}
