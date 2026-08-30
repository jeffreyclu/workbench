import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { splitPatchHunks, type PatchHunk } from '../../../shared/review-decisions.js';
import { splitHunkIntoLogicBlocks } from './logic-blocks.js';

/** The reviewable blocks of a file: its hunks, each cut into the individual
 * logic blocks inside it.
 *
 * This lives in the Review surface and nowhere else. Changes addresses a
 * change by `(revision, file_path, hunk_range)` and has rows recorded against
 * those ranges; splitting a hunk changes the range, so a shared splitter would
 * silently orphan review state Jeffrey already recorded. Review keeps its own
 * splitter, its own ids and its own table, and shared derivation stays at hunk
 * granularity. */
export function splitPatchBlocks(file: Pick<WorkspaceDiffFile, 'patch' | 'isBinary' | 'logicBlocks'>): PatchHunk[] {
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
      });
    }
  }
  return index;
}
