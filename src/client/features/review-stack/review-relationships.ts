import type { ChangeMap, ChangeMapNode } from '../../../shared/change-map.js';
import { isTestPath } from '../../../shared/change-type.js';
import { selectChangeConnections } from '../diff-review/change-map-logic.js';
import type { ReviewRouting } from './review-routing.js';

/** What a block reaches. Grouped the way the question is actually asked while
 * reading one change — who calls this, what moved because of it, and is any
 * of it a test — rather than as an undifferentiated edge list. */
export interface ReviewRelationships {
  /** Changes this one exists because of. */
  callers: ChangeMapNode[];
  /** Changes that had to move because of this one. */
  effects: ChangeMapNode[];
  /** Files in this neighbourhood that are tests, which is the cheapest proxy
   * for "something would fail if this broke". */
  tests: string[];
  /** Files touched anywhere in the neighbourhood, including the block's own. */
  files: string[];
  degree: number;
}

export const EMPTY_REVIEW_RELATIONSHIPS: ReviewRelationships = { callers: [], effects: [], tests: [], files: [], degree: 0 };

export function blockRelationships(map: ChangeMap, decisionId: string): ReviewRelationships {
  const { selected, upstream, downstream } = selectChangeConnections(map, decisionId);
  if (!selected) return EMPTY_REVIEW_RELATIONSHIPS;
  const callers = upstream.map((connection) => connection.related);
  const effects = downstream.map((connection) => connection.related);
  const files = [...new Set([...selected.filePaths, ...callers.flatMap((node) => node.filePaths), ...effects.flatMap((node) => node.filePaths)])];
  return { callers, effects, tests: files.filter(isTestPath), files, degree: selected.degree };
}

/** The map is a surgeon's camera, not a dashboard: drawing it for a block
 * nobody has to think about spends analysis and render budget on a change that
 * was already settled. It is warranted when the block is Jeffrey's to judge
 * *and* there is a neighbourhood to show. */
export function warrantsRelationshipMap(routing: ReviewRouting, relationships: ReviewRelationships): boolean {
  if (routing.autoSettled) return false;
  if (routing.tier === 'T3') return relationships.degree > 0;
  return routing.tier === 'T2' && relationships.degree > 1;
}

/** A block whose neighbourhood turned out to be wider than its own edit —
 * cross-file effects a size- or type-based route could not have seen. */
export function relationshipEscalation(relationships: ReviewRelationships): string | null {
  if (relationships.effects.length >= 3) return `Reaches ${relationships.effects.length} other changes.`;
  const otherFiles = relationships.files.length;
  return otherFiles >= 4 ? `Its neighbourhood spans ${otherFiles} files.` : null;
}
