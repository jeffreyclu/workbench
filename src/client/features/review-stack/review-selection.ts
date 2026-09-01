/**
 * What the reviewer is looking at, and who is allowed to change it.
 *
 * The queue owns `blockId`. It is the only thing that decides which block is
 * being judged, because the queue's order *is* the product: a map that could
 * re-select would let a drawing overrule the ranking that put a block at the
 * top, and the reviewer would end up walking the graph instead of the queue.
 *
 * The map owns the other two. Highlighting a place or a relationship is how a
 * reviewer reads context around the block they are already on, and none of it
 * moves the block under them.
 */
export interface ReviewSelection {
  blockId: string;
  /** A place highlighted inside the drawing. Map-local. */
  nodeId: string | null;
  /** A relationship highlighted inside the drawing. Map-local. */
  relationshipId: string | null;
}

export function selectReviewBlock(blockId: string): ReviewSelection {
  // A new block is a new neighbourhood: carrying the old place or edge over
  // would highlight something that is not in the picture any more.
  return { blockId, nodeId: null, relationshipId: null };
}

/** The map following the reviewer's eye. `blockId` is untouched by
 * construction — this is where "never the reverse" is actually enforced. */
export function highlightReviewPlace(selection: ReviewSelection, nodeId: string | null): ReviewSelection {
  return { ...selection, nodeId: selection.nodeId === nodeId ? null : nodeId };
}

export function highlightReviewRelationship(selection: ReviewSelection, relationshipId: string | null): ReviewSelection {
  return { ...selection, relationshipId };
}
