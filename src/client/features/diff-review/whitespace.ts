import type { ReviewDiffHunk } from './logic.js';

/** A hunk is ignorable only when every removed line matches an added line after
 * whitespace is removed. Context is intentionally excluded because it already
 * exists on both sides of the change. */
export function isWhitespaceOnlyHunk(hunk: Pick<ReviewDiffHunk, 'lines'>): boolean {
  const changed = hunk.lines.filter((line) => line.kind !== 'context');
  if (changed.length === 0) return false;
  const normalize = (text: string) => text.slice(1).replace(/\s+/g, '');
  const before = changed.filter((line) => line.kind === 'deletion').map((line) => normalize(line.text));
  const after = changed.filter((line) => line.kind === 'addition').map((line) => normalize(line.text));
  return before.length === after.length && before.every((line, index) => line === after[index]);
}
