import type { DiffHunkReviewState, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { splitPatchHunks } from '../../../shared/review-decisions.js';
import { splitHunkIntoLogicBlocks } from './logic-blocks.js';
import { blockContentHash, reviewBlockStorageKey } from './review-blocks.js';

/** A hunk-granularity verdict derived from the block verdicts inside it. */
export interface ProjectedHunkVerdict {
  filePath: string;
  hunkRange: string;
  state: DiffHunkReviewState;
}

/** Worst verdict wins. A hunk whose blocks disagree must not report the
 * gentler answer: one block asking for changes is a hunk asking for changes,
 * and a comment outranks a clean read for the same reason. */
const STATE_SEVERITY: Record<DiffHunkReviewState, number> = { reviewed: 0, commented: 1, needs_changes: 2 };

export function projectedHunkKey(filePath: string, hunkRange: string): string {
  return filePath + '::' + hunkRange;
}

/**
 * Roll the Review surface's block verdicts up to the hunk ranges Changes
 * addresses.
 *
 * A hunk appears here only when every block inside it has been answered.
 * Partial coverage is deliberately silent: a hunk marked reviewed in Changes
 * claims the reviewer read all of it, so projecting a half-answered hunk would
 * turn reconciliation into a lie.
 *
 * The split is the one Review already reads from (splitPatchHunks, then
 * splitHunkIntoLogicBlocks), so the parent range returned here is exactly the
 * range Changes keys its rows on, and the block keys are exactly the ones
 * diff_block_reviews is keyed on. A verdict recorded against content that has
 * since changed fails to match its block, so its hunk stays unanswered rather
 * than inheriting a stale answer.
 */
export function projectHunkVerdicts(files: WorkspaceDiffFile[], blockVerdicts: ReadonlyMap<string, DiffHunkReviewState>): ProjectedHunkVerdict[] {
  const projected: ProjectedHunkVerdict[] = [];
  for (const file of files) {
    for (const hunk of splitPatchHunks(file)) {
      let state: DiffHunkReviewState | null = null;
      let complete = true;
      for (const block of splitHunkIntoLogicBlocks(hunk, file.logicBlocks)) {
        const verdict = blockVerdicts.get(reviewBlockStorageKey(file.path, block.range, blockContentHash(block.lines)));
        if (!verdict) { complete = false; break; }
        if (!state || STATE_SEVERITY[verdict] > STATE_SEVERITY[state]) state = verdict;
      }
      if (complete && state) projected.push({ filePath: file.path, hunkRange: hunk.range, state });
    }
  }
  return projected;
}

/** What changed between two projections: hunks that just became fully answered,
 * and hunks whose rolled-up verdict moved. Writing only the delta keeps one
 * block verdict from rewriting every hunk already reconciled. */
export function newlyProjectedHunkVerdicts(before: ProjectedHunkVerdict[], after: ProjectedHunkVerdict[]): ProjectedHunkVerdict[] {
  const previous = new Map(before.map((entry) => [projectedHunkKey(entry.filePath, entry.hunkRange), entry.state]));
  return after.filter((entry) => previous.get(projectedHunkKey(entry.filePath, entry.hunkRange)) !== entry.state);
}

/** Group a delta into the shape the hunk-review batch route takes: one request
 * per distinct state, since that route records a single state for a list of
 * hunks. */
export function groupHunkVerdictsByState(verdicts: ProjectedHunkVerdict[]): Array<{ state: DiffHunkReviewState; hunks: Array<{ filePath: string; hunkRange: string }> }> {
  const groups = new Map<DiffHunkReviewState, Array<{ filePath: string; hunkRange: string }>>();
  for (const verdict of verdicts) {
    const hunks = groups.get(verdict.state) ?? [];
    hunks.push({ filePath: verdict.filePath, hunkRange: verdict.hunkRange });
    groups.set(verdict.state, hunks);
  }
  return [...groups].map(([state, hunks]) => ({ state, hunks }));
}
