import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';

/** Layout is presentation, so it stays out of `shared/change-map.ts`: the
 * relationships are the same whoever draws them. It is also fully
 * deterministic — no force simulation, no randomness — because a reviewer who
 * reopens the same diff must see the same picture in the same places.
 *
 * The diagram is only worth having if it can be read at a glance, so the
 * layout spends its effort on the three things that actually make a graph
 * legible: an edge never crosses a box, edges cross each other as rarely as
 * the layering allows, and two edges touching the same node arrive at two
 * different places on it. */
export const CHANGE_MAP_NODE_WIDTH = 188;
// Four lines: ordinal and label, file, counts, and the symbols the change
// declares or removes.
export const CHANGE_MAP_NODE_HEIGHT = 78;
const COLUMN_GAP = 96;
const ROW_GAP = 22;
const PADDING = 14;
/** A long edge is not drawn over the columns it flies past. It is given a slim
 * lane of its own in each one, reserved like a node but only tall enough to
 * keep neighbouring lines apart. */
const LANE_HEIGHT = 16;
/** Edges that point back the way they came run under the whole diagram rather
 * than back through it, each in its own channel. */
const RETURN_CHANNEL_GAP = 28;
const RETURN_CHANNEL_STEP = 13;
/** Two down-and-up passes of the median heuristic. More sweeps stop paying for
 * themselves on graphs this size. */
const ORDERING_SWEEPS = 4;
/** Ports fan out across the middle half of a node's edge, so the box keeps its
 * corners and the lines still separate. */
const PORT_BAND = CHANGE_MAP_NODE_HEIGHT * 0.5;

export interface ChangeMapPlacedNode extends ChangeMapNode {
  x: number;
  y: number;
  column: number;
  row: number;
}

export interface ChangeMapPlacedEdge extends ChangeMapEdge {
  /** SVG path from a port on the source node to a port on the target, bent
   * through whatever lanes it was routed along. */
  path: string;
  labelX: number;
  labelY: number;
  /** Points back toward an earlier column, so it is drawn under the diagram as
   * a returning curve. */
  backward: boolean;
}

export interface ChangeMapLayout {
  nodes: ChangeMapPlacedNode[];
  edges: ChangeMapPlacedEdge[];
  width: number;
  height: number;
}

/** A slot in a column: either a decision's box or a corner of a long edge. */
interface Cell {
  id: string;
  column: number;
  height: number;
  y: number;
  /** Null for a routing lane, which belongs to an edge rather than a decision. */
  nodeId: string | null;
}

interface Point {
  x: number;
  y: number;
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

function assignColumns(map: ChangeMap): Map<string, number> {
  const present = new Set(map.nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  for (const edge of map.edges) {
    if (!present.has(edge.fromId) || !present.has(edge.toId)) continue;
    incoming.set(edge.toId, [...(incoming.get(edge.toId) ?? []), edge.fromId]);
  }
  const memo = new Map<string, number>();
  const columns = new Map<string, number>();
  const connected = map.nodes.filter((node) => node.degree > 0);
  for (const node of connected) columns.set(node.id, columnOf(node.id, incoming, memo, new Set()));

  // Unrelated changes get their own trailing column instead of sharing column
  // zero with the roots. A reviewer should be able to see at a glance which
  // parts of the diff stand alone.
  const isolatedColumn = connected.length === 0 ? 0 : Math.max(...connected.map((node) => columns.get(node.id) ?? 0)) + 1;
  for (const node of map.nodes) {
    if (node.degree === 0) columns.set(node.id, isolatedColumn);
  }

  // Layering a cycle can leave a column with nothing in it. Closing the gaps
  // keeps the diagram from opening on an empty band of canvas.
  const used = [...new Set(columns.values())].sort((left, right) => left - right);
  const compacted = new Map(used.map((column, index) => [column, index]));
  for (const [id, column] of columns) columns.set(id, compacted.get(column)!);
  return columns;
}

function append(index: Map<string, string[]>, key: string, value: string): void {
  index.set(key, [...(index.get(key) ?? []), value]);
}

/** The median heuristic: a cell wants to sit level with the middle of whatever
 * it is attached to in the neighbouring column. Cells attached to nothing keep
 * the position they already had, so the order stays stable and deterministic. */
function reorderLayer(layer: string[], neighbours: Map<string, string[]>, positions: Map<string, number>): string[] {
  const keys = new Map<string, number>();
  layer.forEach((id, index) => {
    const attached = (neighbours.get(id) ?? [])
      .map((neighbour) => positions.get(neighbour))
      .filter((position): position is number => position !== undefined)
      .sort((left, right) => left - right);
    if (attached.length === 0) return keys.set(id, index);
    const middle = attached.length >> 1;
    keys.set(id, attached.length % 2 === 1 ? attached[middle] : (attached[middle - 1] + attached[middle]) / 2);
  });
  return layer
    .map((id, index) => ({ id, index }))
    .sort((left, right) => (keys.get(left.id)! - keys.get(right.id)!) || (left.index - right.index))
    .map((entry) => entry.id);
}

function columnX(column: number): number {
  return PADDING + column * (CHANGE_MAP_NODE_WIDTH + COLUMN_GAP);
}

/** Even spacing across the port band, collapsing to the node's midpoint when
 * there is only one line to place. */
function portY(top: number, count: number, index: number): number {
  if (count <= 1) return top + CHANGE_MAP_NODE_HEIGHT / 2;
  return top + (CHANGE_MAP_NODE_HEIGHT - PORT_BAND) / 2 + (PORT_BAND * index) / (count - 1);
}

/** Horizontal-tangent cubics between consecutive points: the line leaves and
 * enters every box and lane flat, which is what makes a bundle of them read as
 * parallel rather than as a knot. */
function smoothPath(points: Point[]): string {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const bend = Math.max(18, (to.x - from.x) / 2);
    path += ` C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  }
  return path;
}

/** Midpoint of the middle segment, so a label sits on the curve rather than on
 * the straight line between its endpoints. */
function pathMidpoint(points: Point[]): Point {
  const segment = Math.floor((points.length - 1) / 2);
  const from = points[segment];
  const to = points[segment + 1];
  const bend = Math.max(18, (to.x - from.x) / 2);
  return {
    x: (from.x + 3 * (from.x + bend) + 3 * (to.x - bend) + to.x) / 8,
    y: (from.y + 3 * from.y + 3 * to.y + to.y) / 8,
  };
}

export function layoutChangeMap(map: ChangeMap): ChangeMapLayout {
  const columns = assignColumns(map);
  const lastColumn = Math.max(...map.nodes.map((node) => columns.get(node.id) ?? 0), 0);
  const layers: string[][] = Array.from({ length: lastColumn + 1 }, () => []);
  const cells = new Map<string, Cell>();
  const place = (cell: Cell) => {
    cells.set(cell.id, cell);
    layers[cell.column].push(cell.id);
  };

  for (const node of [...map.nodes].sort((left, right) => (columns.get(left.id)! - columns.get(right.id)!) || (left.ordinal - right.ordinal))) {
    place({ id: node.id, column: columns.get(node.id)!, height: CHANGE_MAP_NODE_HEIGHT, y: 0, nodeId: node.id });
  }

  // A forward edge becomes a chain of cells, one per column it passes through.
  // The intermediate ones are lanes, and because they take a slot they push the
  // boxes aside instead of being drawn over them.
  const chains = new Map<string, string[]>();
  const returning: ChangeMapEdge[] = [];
  for (const edge of map.edges) {
    const from = columns.get(edge.fromId);
    const to = columns.get(edge.toId);
    if (from === undefined || to === undefined) continue;
    if (to <= from) {
      returning.push(edge);
      continue;
    }
    const chain = [edge.fromId];
    for (let column = from + 1; column < to; column += 1) {
      const id = `${edge.id}@${column}`;
      place({ id, column, height: LANE_HEIGHT, y: 0, nodeId: null });
      chain.push(id);
    }
    chain.push(edge.toId);
    chains.set(edge.id, chain);
  }

  const nextOf = new Map<string, string[]>();
  const previousOf = new Map<string, string[]>();
  for (const chain of chains.values()) {
    for (let index = 0; index + 1 < chain.length; index += 1) {
      append(nextOf, chain[index], chain[index + 1]);
      append(previousOf, chain[index + 1], chain[index]);
    }
  }

  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = downward
      ? layers.map((_, column) => column).slice(1)
      : layers.map((_, column) => column).slice(0, -1).reverse();
    for (const column of order) {
      const reference = layers[downward ? column - 1 : column + 1];
      const positions = new Map(reference.map((id, index) => [id, index]));
      layers[column] = reorderLayer(layers[column], downward ? previousOf : nextOf, positions);
    }
  }

  // Columns are centred against the tallest one. Left top-aligned, a column
  // holding one box would sit level with the top of a column holding ten, and
  // every edge between them would be a long diagonal.
  const heights = layers.map((layer) => layer.reduce((total, id, index) => total + cells.get(id)!.height + (index === 0 ? 0 : ROW_GAP), 0));
  const tallest = Math.max(...heights, CHANGE_MAP_NODE_HEIGHT);
  layers.forEach((layer, column) => {
    let y = PADDING + Math.round((tallest - heights[column]) / 2);
    for (const id of layer) {
      const cell = cells.get(id)!;
      cell.y = y;
      y += cell.height + ROW_GAP;
    }
  });

  const nodes: ChangeMapPlacedNode[] = [];
  layers.forEach((layer, column) => {
    let row = 0;
    for (const id of layer) {
      const cell = cells.get(id)!;
      if (!cell.nodeId) continue;
      const node = map.nodes.find((candidate) => candidate.id === cell.nodeId)!;
      nodes.push({ ...node, column, row, x: columnX(column), y: cell.y });
      row += 1;
    }
  });
  const placed = new Map(nodes.map((node) => [node.id, node]));

  const centreOf = (cellId: string): Point => {
    const cell = cells.get(cellId)!;
    return cell.nodeId
      ? { x: columnX(cell.column) + CHANGE_MAP_NODE_WIDTH / 2, y: cell.y + CHANGE_MAP_NODE_HEIGHT / 2 }
      : { x: columnX(cell.column) + CHANGE_MAP_NODE_WIDTH / 2, y: cell.y + cell.height / 2 };
  };

  // Ports are handed out in the order the lines arrive vertically, so the fan
  // out of a node never crosses itself before it has left the box.
  const ports = new Map<string, { start: number; end: number }>();
  const assignPorts = (side: 'start' | 'end') => {
    const grouped = new Map<string, string[]>();
    for (const [edgeId, chain] of chains) {
      const anchorNode = side === 'start' ? chain[0] : chain[chain.length - 1];
      append(grouped, anchorNode, edgeId);
    }
    for (const [nodeId, edgeIds] of grouped) {
      const node = placed.get(nodeId);
      if (!node) continue;
      const sorted = [...edgeIds].sort((left, right) => {
        const leftChain = chains.get(left)!;
        const rightChain = chains.get(right)!;
        const leftNeighbour = side === 'start' ? leftChain[1] : leftChain[leftChain.length - 2];
        const rightNeighbour = side === 'start' ? rightChain[1] : rightChain[rightChain.length - 2];
        return (centreOf(leftNeighbour).y - centreOf(rightNeighbour).y) || left.localeCompare(right);
      });
      sorted.forEach((edgeId, index) => {
        const existing = ports.get(edgeId) ?? { start: 0, end: 0 };
        ports.set(edgeId, { ...existing, [side]: portY(node.y, sorted.length, index) });
      });
    }
  };
  assignPorts('start');
  assignPorts('end');

  const edges: ChangeMapPlacedEdge[] = [];
  for (const edge of map.edges) {
    const chain = chains.get(edge.id);
    if (!chain) continue;
    const from = placed.get(edge.fromId)!;
    const to = placed.get(edge.toId)!;
    const port = ports.get(edge.id)!;
    const points: Point[] = chain.map((cellId, index) => {
      if (index === 0) return { x: from.x + CHANGE_MAP_NODE_WIDTH, y: port.start };
      if (index === chain.length - 1) return { x: to.x, y: port.end };
      return centreOf(cellId);
    });
    const label = pathMidpoint(points);
    edges.push({ ...edge, backward: false, path: smoothPath(points), labelX: label.x, labelY: label.y });
  }

  const bottom = Math.max(...[...cells.values()].map((cell) => cell.y + cell.height), PADDING + CHANGE_MAP_NODE_HEIGHT);
  let deepest = bottom;
  returning.forEach((edge, index) => {
    const from = placed.get(edge.fromId);
    const to = placed.get(edge.toId);
    if (!from || !to) return;
    const channelY = bottom + RETURN_CHANNEL_GAP + index * RETURN_CHANNEL_STEP;
    deepest = Math.max(deepest, channelY);
    const startX = from.x + CHANGE_MAP_NODE_WIDTH * 0.34;
    const startY = from.y + CHANGE_MAP_NODE_HEIGHT;
    const endX = to.x + CHANGE_MAP_NODE_WIDTH * 0.66;
    const endY = to.y + CHANGE_MAP_NODE_HEIGHT;
    edges.push({
      ...edge,
      backward: true,
      path: `M ${startX} ${startY} C ${startX} ${channelY}, ${endX} ${channelY}, ${endX} ${endY}`,
      labelX: (startX + endX) / 2,
      labelY: (startY + endY + 6 * channelY) / 8,
    });
  });

  return {
    nodes,
    edges,
    width: PADDING * 2 + (lastColumn + 1) * (CHANGE_MAP_NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: deepest + PADDING,
  };
}
