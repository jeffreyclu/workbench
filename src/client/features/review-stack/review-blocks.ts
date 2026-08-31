import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { splitPatchHunks } from '../../../shared/review-decisions.js';
import { splitHunkIntoLogicBlocks, type BlockAnalysis, type LogicBlock } from './logic-blocks.js';

/** The reviewable blocks of a file: its hunks, each cut into the individual
 * logic blocks inside it.
 *
 * This lives in the Review surface and nowhere else. Changes addresses a
 * change by `(revision, file_path, hunk_range)` and has rows recorded against
 * those ranges; splitting a hunk changes the range, so a shared splitter would
 * silently orphan review state Jeffrey already recorded. Review keeps its own
 * splitter, its own ids and its own table, and shared derivation stays at hunk
 * granularity. */
export function splitPatchBlocks(file: Pick<WorkspaceDiffFile, 'patch' | 'isBinary' | 'logicBlocks'>): LogicBlock[] {
  return splitPatchHunks(file).flatMap((hunk) => splitHunkIntoLogicBlocks(hunk, file.logicBlocks));
}

/** FNV-1a. Not a security hash — it exists so a block's recorded verdict is
 * invalidated when the lines under it change, even if the `@@` range happens
 * to land identically after an edit above it. `crypto.subtle` is async and
 * this is read during render, so a small synchronous hash is the right tool. */
export function blockContentHash(lines: string[]): string {
  let hash = 0x811c9dc5;
  const text = lines.join('\n');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** How Review addresses one block. `decisionId` is what the reused queue and
 * diff components already speak (`path::range`); `storageKey` is what the
 * `diff_block_reviews` row is keyed on, and carries the content hash so a
 * rewritten block asks its question again instead of inheriting an answer
 * given about different code. */
export interface ReviewBlockIdentity {
  decisionId: string;
  filePath: string;
  range: string;
  contentHash: string;
  storageKey: string;
  /** What the compiler read inside this block, or null when it could not read
   * the file. This is how priority reaches the queue: the identity index is
   * already built per block from the same split the blocks came from, so the
   * reading travels on the address instead of on a second parallel map. */
  analysis: BlockAnalysis | null;
}

export function reviewBlockStorageKey(filePath: string, range: string, contentHash: string): string {
  return `${filePath}::${range}::${contentHash}`;
}

/** Re-emit each file's patch with its logic blocks as the `@@` boundaries, so
 * every downstream consumer that splits on `@@` sees blocks without any of
 * them learning a second granularity.
 *
 * A patch whose blocks are not all real `@@` hunks — a binary file, a
 * whole-file placeholder — is passed through untouched: reconstructing it
 * would turn a truthful placeholder into a fake hunk header. */
export function toBlockLevelFiles(files: WorkspaceDiffFile[]): WorkspaceDiffFile[] {
  return files.map((file) => {
    if (!file.patch) return file;
    const blocks = splitPatchBlocks(file);
    if (!blocks.every((block) => block.range.startsWith('@@'))) return file;
    const patch = blocks.map((block) => [block.range, ...block.lines].join('\n')).join('\n');
    return patch === file.patch ? file : { ...file, patch };
  });
}

/** Match stored verdicts onto the blocks currently on screen by *content*,
 * falling back to content only when it is unambiguous.
 *
 * A stored row remembers the range it was answered at, but a range is a line
 * number: insert a function above an untouched block and every range below it
 * moves, even though nothing about that code changed. Matching on the range
 * alone made the reviewer answer those blocks again. An exact
 * (range, hash) hit still wins, so nothing about same-revision reading
 * changes; a moved block is recognised by its hash; and a file that repeats
 * the same block content at two ranges is left unmatched rather than guessed
 * at, because carrying a verdict to the wrong block is worse than asking
 * again.
 *
 * Returned in the order given, duplicates included: the caller decides what
 * first-wins means for a verdict and for a note. */
export function resolveCarriedBlockReviews<Review extends { filePath: string; blockRange: string; contentHash: string }>(
  blocks: Map<string, ReviewBlockIdentity>,
  reviews: readonly Review[],
): Array<{ identity: ReviewBlockIdentity; review: Review }> {
  const byContent = new Map<string, ReviewBlockIdentity[]>();
  for (const identity of blocks.values()) {
    const key = `${identity.filePath}\u0000${identity.contentHash}`;
    const held = byContent.get(key);
    if (held) held.push(identity);
    else byContent.set(key, [identity]);
  }
  const matches: Array<{ identity: ReviewBlockIdentity; review: Review }> = [];
  for (const review of reviews) {
    const candidates = byContent.get(`${review.filePath}\u0000${review.contentHash}`) ?? [];
    const identity = candidates.find((candidate) => candidate.range === review.blockRange)
      ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (identity) matches.push({ identity, review });
  }
  return matches;
}

/** Content hashes for every block of every file, keyed by the decision-hunk id
 * the reused components address. Built from the same split the block-level
 * files came from, so the two can never disagree. */
export function indexReviewBlocks(files: WorkspaceDiffFile[]): Map<string, ReviewBlockIdentity> {
  const index = new Map<string, ReviewBlockIdentity>();
  for (const file of files) {
    for (const block of splitPatchBlocks(file)) {
      const decisionId = `${file.path}::${block.range}`;
      const contentHash = blockContentHash(block.lines);
      index.set(decisionId, {
        decisionId, filePath: file.path, range: block.range, contentHash,
        storageKey: reviewBlockStorageKey(file.path, block.range, contentHash),
        analysis: block.analysis,
      });
    }
  }
  return index;
}
