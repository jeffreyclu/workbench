import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildFileDiffHunks, type ReviewDecision, type ReviewDiffLine } from './logic.js';

/** Past this the list stops being a navigator and becomes a second diff. The
 * reviewer is told the search was cut short rather than shown a silent cap. */
export const DIFF_SEARCH_LIMIT = 500;

/** One line of the changeset that contains the query, addressed well enough to
 * select the change it belongs to and land on the line inside that change. */
export interface DiffSearchMatch {
  /** Unique across the changeset: line keys alone repeat between files. */
  id: string;
  filePath: string;
  decisionId: string;
  /** The `data-line-key` the diff pane gives the row. */
  lineKey: string;
  kind: ReviewDiffLine['kind'];
  /** The line number a reviewer would quote: the new side, else the old. */
  lineNumber: number | null;
  /** The line without its `+`/`-`/space marker. */
  text: string;
  /** Where the query sits in `text`, so the row can mark it. */
  start: number;
}

export interface DiffSearchResult {
  matches: DiffSearchMatch[];
  /** True when more lines matched than `DIFF_SEARCH_LIMIT` kept. */
  truncated: boolean;
}

/** One searchable line of the changeset, built once per diff so each keystroke
 * only scans text instead of re-splitting every patch. */
export interface DiffSearchLine {
  filePath: string;
  decisionId: string;
  line: ReviewDiffLine;
}

/** Flattens every file's hunks to their lines, each tied to the decision that
 * owns its hunk. Hunks no decision owns are left out: a result the reviewer
 * cannot jump to is noise. */
export function buildDiffSearchIndex(files: Pick<WorkspaceDiffFile, 'path' | 'patch' | 'isBinary'>[], decisions: ReviewDecision[]): DiffSearchLine[] {
  const decisionByHunkId = new Map(decisions.flatMap((decision) => decision.hunks.map((hunk) => [hunk.id, decision.id] as const)));
  return files.flatMap((file) => buildFileDiffHunks(file).flatMap((hunk) => {
    const decisionId = decisionByHunkId.get(hunk.decisionId);
    return decisionId ? hunk.lines.map((line) => ({ filePath: file.path, decisionId, line })) : [];
  }));
}

/** Case-insensitive substring search over every changed and context line of the
 * changeset, in file then line order. A blank query matches nothing. */
export function searchDiffIndex(index: DiffSearchLine[], query: string): DiffSearchResult {
  const needle = query.trim().toLowerCase();
  if (!needle) return { matches: [], truncated: false };
  const matches: DiffSearchMatch[] = [];
  for (const { filePath, decisionId, line } of index) {
    const text = line.text.slice(1);
    const start = text.toLowerCase().indexOf(needle);
    if (start === -1) continue;
    if (matches.length === DIFF_SEARCH_LIMIT) return { matches, truncated: true };
    matches.push({ id: `${filePath}::${line.key}`, filePath, decisionId, lineKey: line.key, kind: line.kind, lineNumber: line.newLine ?? line.oldLine, text, start });
  }
  return { matches, truncated: false };
}

/** Wraps stepping past either end back around, like every find bar. A `current`
 * of -1 means nothing has been visited yet, so forward starts at the first
 * match and backward at the last. */
export function stepMatchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return 0;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
