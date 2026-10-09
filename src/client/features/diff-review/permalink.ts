import type { ReviewDecision, ReviewDiffHunk, ReviewDiffLine } from './logic.js';

/**
 * A link to one place in a changeset: a file, optionally a hunk of it, and
 * optionally one line of that hunk.
 *
 * The link rides in the URL fragment (`#diff=src/a.ts&line=n42`) so it never
 * reaches the server and never disturbs the pathname the router reads. The
 * page URL it is appended to already names the task or conversation.
 *
 * Lines are addressed by file line number and side, not by the pane's
 * `hunkRange:index` row key: the key is an index into one rendering of one
 * patch, while `n42` still names the same line when the link is opened in a
 * session that reads the diff in a different mode.
 */
export interface DiffPermalink {
  filePath: string;
  /** `${oldStart},${newStart}` of the hunk header — unique within a file. */
  hunk: string | null;
  /** `n<N>` is line N of the file after the change, `o<N>` line N before it
   * (only deleted lines have no place on the new side). */
  line: { side: 'new' | 'old'; number: number } | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The stable, short name of a hunk: the two start lines of its header. */
export function hunkAnchor(range: string): string | null {
  const match = range.match(HUNK_HEADER);
  return match ? `${match[1]},${match[2]}` : null;
}

/** The address of a line as a reviewer would quote it. Deleted lines live only
 * on the old side; every other line is addressed by its new-side number. */
export function lineAddress(line: Pick<ReviewDiffLine, 'kind' | 'oldLine' | 'newLine'>): DiffPermalink['line'] {
  if (line.kind === 'deletion') return line.oldLine === null ? null : { side: 'old', number: line.oldLine };
  return line.newLine === null ? null : { side: 'new', number: line.newLine };
}

export function permalinkHash(target: DiffPermalink): string {
  const params = new URLSearchParams({ diff: target.filePath });
  if (target.hunk) params.set('hunk', target.hunk);
  if (target.line) params.set('line', `${target.line.side === 'new' ? 'n' : 'o'}${target.line.number}`);
  return `#${params.toString()}`;
}

/** The page the reviewer is on, plus the fragment that names the place. */
export function permalinkUrl(location: Pick<Location, 'origin' | 'pathname' | 'search'>, target: DiffPermalink): string {
  return `${location.origin}${location.pathname}${location.search}${permalinkHash(target)}`;
}

/** Null for any fragment that is not a diff link, including a malformed one,
 * so unrelated anchors on the page are left alone. */
export function parsePermalinkHash(hash: string): DiffPermalink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const filePath = params.get('diff');
  if (!filePath) return null;
  const hunk = params.get('hunk');
  const line = params.get('line')?.match(/^([no])(\d+)$/);
  return {
    filePath,
    hunk: hunk && /^\d+,\d+$/.test(hunk) ? hunk : null,
    line: line ? { side: line[1] === 'n' ? 'new' : 'old', number: Number(line[2]) } : null,
  };
}

export interface ResolvedPermalink {
  filePath: string;
  decisionId: string;
  /** The `data-line-key` to highlight; null when the link names a hunk, or a
   * line the patch does not contain. */
  lineKey: string | null;
  kind: ReviewDiffLine['kind'] | null;
  /** The new-side line whole-file reading should land on, when there is one. */
  newLine: number | null;
}

/** Finds what a link points at in the diff now being read. A line that has
 * since left the patch degrades to its hunk, and a hunk that has since moved
 * degrades to the file's first change — a stale link still lands somewhere
 * useful. Null only when the file itself is not in this diff. */
export function resolvePermalink(
  target: DiffPermalink,
  hunksByFile: ReadonlyMap<string, ReviewDiffHunk[]>,
  decisions: ReviewDecision[],
): ResolvedPermalink | null {
  const hunks = hunksByFile.get(target.filePath);
  if (!hunks || hunks.length === 0) return null;
  const decisionByHunkId = new Map(decisions.flatMap((decision) => decision.hunks.map((hunk) => [hunk.id, decision.id] as const)));
  const owned = hunks.filter((hunk) => decisionByHunkId.has(hunk.decisionId));
  const named = target.hunk ? owned.filter((hunk) => hunkAnchor(hunk.range) === target.hunk) : [];
  // Without a hunk the line is searched for in the whole file; with one, only
  // in that hunk, because old-side numbers repeat across a file's hunks.
  const searched = named.length > 0 ? named : owned;
  if (target.line) {
    for (const hunk of searched) {
      const line = hunk.lines.find((candidate) => {
        const address = lineAddress(candidate);
        return address?.side === target.line!.side && address.number === target.line!.number;
      });
      if (line) return { filePath: target.filePath, decisionId: decisionByHunkId.get(hunk.decisionId)!, lineKey: line.key, kind: line.kind, newLine: line.newLine };
    }
  }
  // A line outside every hunk (plain context in whole-file reading) lands on
  // the nearest change, and whole-file reading still goes to the line itself.
  const newStart = (hunk: ReviewDiffHunk) => Number(hunk.range.match(HUNK_HEADER)?.[2] ?? 0);
  const wanted = target.line?.side === 'new' ? target.line.number : null;
  const nearest = wanted === null ? undefined : [...owned].sort((a, b) => Math.abs(newStart(a) - wanted) - Math.abs(newStart(b) - wanted))[0];
  const hunk = named[0] ?? nearest ?? owned[0];
  if (!hunk) return null;
  const start = hunk.range.match(HUNK_HEADER)?.[2];
  return { filePath: target.filePath, decisionId: decisionByHunkId.get(hunk.decisionId)!, lineKey: null, kind: null, newLine: wanted ?? (start ? Number(start) : null) };
}
