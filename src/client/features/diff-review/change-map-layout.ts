import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';

/** Layout is presentation, so it stays out of `shared/change-map.ts`: the
 * relationships are the same whoever draws them. It is also fully
 * deterministic — no force simulation, no randomness — because a reviewer who
 * reopens the same diff must see the same picture in the same places. */
export const CHANGE_MAP_NODE_WIDTH = 188;
export const CHANGE_MAP_NODE_HEIGHT = 62;
const COLUMN_GAP = 76;
const ROW_GAP = 16;
const PADDING = 14;

export interface ChangeMapPlacedNode extends ChangeMapNode {
  x: number;
  y: number;
  column: number;
  row: number;
}

export interface ChangeMapPlacedEdge extends ChangeMapEdge {
  /** SVG cubic path from the source node's right edge to the target's left edge. */
  path: string;
  labelX: number;
  labelY: number;
  /** Points back toward an earlier column, so it is drawn as a returning curve. */
  backward: boolean;
}

export interface ChangeMapLayout {
  nodes: ChangeMapPlacedNode[];
  edges: ChangeMapPlacedEdge[];
  width: number;
  height: number;
}

/** Longest-path layering: a decision sits one column right of the furthest
 * decision it depends on, so causes read left of effects. Cycles are real in
 * diffs (two functions that call each other, both changed), so the walk
 * carries its own stack and stops at a repeat rather than recursing forever. */
function columnOf(nodeId: string, incoming: Map<string, string[]>, memo: Map<string, number>, stack: Set<string>): number {
  const cached = memo.get(nodeId);
  if (cached !== undefined) return cached;
  if (stack.has(nodeId)) return 0;
  stack.add(nodeId);
  const sources = incoming.get(nodeId) ?? [];
  const column = sources.length === 0 ? 0 : Math.max(...sources.map((source) => columnOf(source, incoming, memo, stack) + 1));
  stack.delete(nodeId);
  memo.set(nodeId, column);
  return column;
}

export function layoutChangeMap(map: ChangeMap): ChangeMapLayout {
  const incoming = new Map<string, string[]>();
  for (const edge of map.edges) {
    incoming.set(edge.toId, [...(incoming.get(edge.toId) ?? []), edge.fromId]);
  }
  const memo = new Map<string, number>();
  const connected = map.nodes.filter((node) => node.degree > 0);
  const columns = new Map<string, number>();
  for (const node of connected) columns.set(node.id, columnOf(node.id, incoming, memo, new Set()));

  // Unrelated changes get their own trailing column instead of sharing column
  // zero with the roots. A reviewer should be able to see at a glance which
  // parts of the diff stand alone.
  const isolatedColumn = connected.length === 0 ? 0 : Math.max(...connected.map((node) => columns.get(node.id) ?? 0)) + 1;
  for (const node of map.nodes) {
    if (node.degree === 0) columns.set(node.id, isolatedColumn);
  }

  const rows = new Map<number, number>();
  const nodes: ChangeMapPlacedNode[] = [...map.nodes]
    .sort((left, right) => (columns.get(left.id)! - columns.get(right.id)!) || left.ordinal - right.ordinal)
    .map((node) => {
      const column = columns.get(node.id)!;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return {
        ...node,
        column,
        row,
        x: PADDING + column * (CHANGE_MAP_NODE_WIDTH + COLUMN_GAP),
        y: PADDING + row * (CHANGE_MAP_NODE_HEIGHT + ROW_GAP),
      };
    });

  const placed = new Map(nodes.map((node) => [node.id, node]));
  const edges: ChangeMapPlacedEdge[] = map.edges.flatMap((edge) => {
    const from = placed.get(edge.fromId);
    const to = placed.get(edge.toId);
    if (!from || !to) return [];
    const startX = from.x + CHANGE_MAP_NODE_WIDTH;
    const startY = from.y + CHANGE_MAP_NODE_HEIGHT / 2;
    const endX = to.x;
    const endY = to.y + CHANGE_MAP_NODE_HEIGHT / 2;
    const backward = to.column <= from.column;
    // A backward edge cannot bend forward or it would be drawn through its own
    // nodes, so its control points bow outward and it reads as a return path.
    const bend = backward ? COLUMN_GAP : Math.max(28, (endX - startX) / 2);
    const controlOneX = startX + bend;
    const controlTwoX = endX - bend;
    return [{
      ...edge,
      backward,
      path: `M ${startX} ${startY} C ${controlOneX} ${startY}, ${controlTwoX} ${endY}, ${endX} ${endY}`,
      // Cubic midpoint at t = 0.5, so a label sits on the curve rather than on
      // the straight line between its endpoints.
      labelX: (startX + 3 * controlOneX + 3 * controlTwoX + endX) / 8,
      labelY: (startY + 3 * startY + 3 * endY + endY) / 8,
    }];
  });

  const width = PADDING * 2 + (Math.max(...nodes.map((node) => node.column), 0) + 1) * (CHANGE_MAP_NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP;
  const height = PADDING * 2 + Math.max(...[...rows.values()], 1) * (CHANGE_MAP_NODE_HEIGHT + ROW_GAP) - ROW_GAP;
  return { nodes, edges, width, height };
}
