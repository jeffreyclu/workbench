import type { ReviewDiffHunk, ReviewDiffLine } from '../diff-review/logic.js';

/** One row of the whole-file reading.
 *
 * A `line` row is a line that exists in the file after the change; a `removed`
 * row stands where a run of deleted lines used to be, so a reader scrolling
 * the finished file still sees that something was taken out here. */
export type FullFileRow =
  | { type: 'line'; key: string; lineNumber: number; text: string; changed: boolean; decisionId: string | null }
  | { type: 'removed'; key: string; lineNumber: number; lines: ReviewDiffLine[]; decisionId: string | null };

/** A changed region as a jump target. Whole-file reading trades the patch's
 * "only the changes" for real surroundings, so the changes have to become
 * navigable or they are simply lost in the file. */
export interface FullFileChange {
  decisionId: string;
  label: string;
  firstLine: number;
  lastLine: number;
}

export interface FullFileReading {
  rows: FullFileRow[];
  changes: FullFileChange[];
  /** Whether the patch's new side actually matches the file that was read. */
  aligned: boolean;
}

/** Which git revision holds a source's after-state, or null for the working tree.
 *
 * A recorded commit diff carries `commit:<sha>`, and that commit holds the
 * file. A branch diff carries `branch:<name>:<base>..<tip>`, and its tip is a
 * real commit that holds the file. A working-tree diff's revision is a content
 * hash of uncommitted work — no commit holds that text, so the file on disk is
 * the only after-state there is. */
export function fileSourceRevision(revision: string | null | undefined): string | null {
  if (!revision) return null;
  if (revision.startsWith('commit:')) return revision.slice('commit:'.length);
  if (revision.startsWith('branch:')) {
    // Git forbids `..` inside a ref name, so the last one is always the
    // separator this revision was built with.
    const separator = revision.lastIndexOf('..');
    const tip = separator === -1 ? '' : revision.slice(separator + 2);
    return tip || null;
  }
  return null;
}

function splitLines(content: string): string[] {
  const lines = content.split('\n');
  // A trailing newline is a terminator, not an empty final line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Whether the patch describes the file that was actually read.
 *
 * The diff and the file are fetched separately, so the file can have moved on
 * — an agent writing while the reviewer reads, or a working tree edited after
 * the diff was rendered. Marking changes at stale line numbers would point the
 * reviewer at innocent code and call it the change, which is worse than not
 * offering whole-file reading at all. */
/** A patch line's code, without the `+`/`-`/space column git writes in front
 * of it. The file being read has no such column, so the marker has to come off
 * before the two can be compared. */
function patchLineCode(line: ReviewDiffLine): string {
  const marker = line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' ';
  return line.text.startsWith(marker) ? line.text.slice(1) : line.text;
}

function patchMatchesFile(hunks: ReviewDiffHunk[], lines: string[]): boolean {
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      // Deletions have no line in the finished file, so a patch of pure
      // deletions has nothing to contradict and is allowed through.
      if (line.kind === 'deletion' || line.newLine === null) continue;
      const actual = lines[line.newLine - 1];
      if (actual === undefined || actual.trimEnd() !== patchLineCode(line).trimEnd()) return false;
    }
  }
  return true;
}

/** Reads a file whole, with the patch's changes marked in place.
 *
 * The patch window is three lines of context, which is enough to judge a fix
 * and not enough to judge a refactor: when the surrounding code *is* the
 * argument, the block boundary lies to you by cropping the evidence. This
 * keeps the file as the unit and the change as an annotation on it. */
export function toFullFileReading(content: string, hunks: ReviewDiffHunk[]): FullFileReading {
  const lines = splitLines(content);
  const aligned = patchMatchesFile(hunks, lines);
  if (!aligned) return { rows: [], changes: [], aligned: false };

  const changedAt = new Map<number, string>();
  const removedAt = new Map<number, { decisionId: string; lines: ReviewDiffLine[] }>();
  for (const hunk of hunks) {
    let pendingRemoval: ReviewDiffLine[] = [];
    let lastNewLine = 0;
    for (const line of hunk.lines) {
      if (line.kind === 'deletion') {
        pendingRemoval.push(line);
        continue;
      }
      if (line.newLine === null) continue;
      if (pendingRemoval.length > 0) {
        // Anchored to the line the removal now sits above, so the marker keeps
        // its position in the finished file rather than floating.
        const existing = removedAt.get(line.newLine);
        removedAt.set(line.newLine, { decisionId: hunk.decisionId, lines: [...(existing?.lines ?? []), ...pendingRemoval] });
        pendingRemoval = [];
      }
      if (line.kind === 'addition') changedAt.set(line.newLine, hunk.decisionId);
      lastNewLine = line.newLine;
    }
    if (pendingRemoval.length > 0) {
      const anchor = lastNewLine + 1;
      const existing = removedAt.get(anchor);
      removedAt.set(anchor, { decisionId: hunk.decisionId, lines: [...(existing?.lines ?? []), ...pendingRemoval] });
    }
  }

  const rows: FullFileRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const removal = removedAt.get(lineNumber);
    if (removal) rows.push({ type: 'removed', key: `removed-${lineNumber}`, lineNumber, lines: removal.lines, decisionId: removal.decisionId });
    const decisionId = changedAt.get(lineNumber) ?? null;
    rows.push({ type: 'line', key: `line-${lineNumber}`, lineNumber, text: lines[index], changed: decisionId !== null, decisionId });
  }
  // A removal past the end of the file has no line to sit above; it belongs
  // after the last one rather than being dropped.
  for (const [lineNumber, removal] of removedAt) {
    if (lineNumber <= lines.length) continue;
    rows.push({ type: 'removed', key: `removed-${lineNumber}`, lineNumber, lines: removal.lines, decisionId: removal.decisionId });
  }

  return { rows, changes: toFullFileChanges(hunks, removedAt, changedAt), aligned: true };
}

function toFullFileChanges(
  hunks: ReviewDiffHunk[],
  removedAt: Map<number, { decisionId: string; lines: ReviewDiffLine[] }>,
  changedAt: Map<number, string>,
): FullFileChange[] {
  const changes: FullFileChange[] = [];
  for (const hunk of hunks) {
    const touched: number[] = [];
    for (const [lineNumber, decisionId] of changedAt) if (decisionId === hunk.decisionId) touched.push(lineNumber);
    for (const [lineNumber, removal] of removedAt) if (removal.decisionId === hunk.decisionId) touched.push(lineNumber);
    if (touched.length === 0) continue;
    const existing = changes.find((change) => change.decisionId === hunk.decisionId);
    const firstLine = Math.min(...touched);
    const lastLine = Math.max(...touched);
    if (existing) {
      existing.firstLine = Math.min(existing.firstLine, firstLine);
      existing.lastLine = Math.max(existing.lastLine, lastLine);
      continue;
    }
    changes.push({ decisionId: hunk.decisionId, label: hunk.enclosing?.trim() || hunk.location, firstLine, lastLine });
  }
  return changes.sort((left, right) => left.firstLine - right.firstLine);
}
