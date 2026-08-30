import type { ReviewDiffLine } from './logic.js';

/** One row of the final-state reading of a block.
 *
 * A `line` row is code that exists after the change; a `removed` row stands in
 * for a run of lines that do not. */
export type FinalStateRow =
  | { type: 'anchor'; key: string; text: string }
  | { type: 'line'; line: ReviewDiffLine }
  | { type: 'removed'; key: string; count: number };

/** Whether the block already opens with the construct git named.
 *
 * Git truncates the header declaration, so neither string is reliably the
 * longer one; either being a prefix of the other means the reader can already
 * see the construct and an anchor would just repeat the next line. */
function showsConstruct(code: string, heading: string): boolean {
  const shown = code.trim();
  const named = heading.trim();
  if (shown.length < 3 || named.length < 3) return false;
  return shown.startsWith(named) || named.startsWith(shown);
}

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
export function toFinalStateRows(lines: ReviewDiffLine[], enclosing?: string | null): FinalStateRow[] {
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
  // A hunk carries three lines of context, which is enough to see that code
  // changed and not enough to see what it is part of. Naming the enclosing
  // construct is the cheapest way to read the fragment as code rather than as
  // a diff, and costs nothing: git already put it in the hunk header. Skipped
  // when the block is the construct, so the declaration is never doubled.
  if (rows.length > 0 && enclosing && enclosing.trim()
    && !rows.some((row) => row.type === 'line' && showsConstruct(row.line.text.slice(1), enclosing))) {
    rows.unshift({ type: 'anchor', key: `${rows[0].type === 'line' ? rows[0].line.key : rows[0].key}-anchor`, text: enclosing.trim() });
  }
  return rows;
}
