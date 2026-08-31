import { changeEdgeLabel, type ChangeMap, type ChangeMapEdge, type ChangeMapNode } from '../../../shared/change-map.js';

/** Layout is presentation, so it stays out of `shared/change-map.ts`: the
 * relationships are the same whoever draws them. It is also fully
 * deterministic — no force simulation, no randomness — because a reviewer who
 * reopens the same diff must see the same picture in the same places.
 *
 * The picture is a grid a person can name: **a row is a file, a column is
 * causal depth**. A change sits in its file's lane, one column right of the
 * furthest change it depends on, so a reader can say out loud what they are
 * looking at — "these two changes in the router caused those three in the
 * card" — instead of decoding a packed graph of look-alike boxes.
 *
 * Two consequences fall out of that and are worth the code they cost: no edge
 * is ever drawn across a box, because anything spanning more than one column
 * is routed down the empty band between lanes; and two edges touching the same
 * node arrive at two different places on it. */
export const CHANGE_MAP_NODE_WIDTH = 260;
/** A title over up to three lines, the declarations the change touches, and
 * its line counts. Three lines is what it takes to finish a real change's
 * sentence; a box that ends in an ellipsis is a box that has to be opened. */
export const CHANGE_MAP_NODE_HEIGHT = 108;
/** The strip at the top of a lane that carries the file path. */
export const CHANGE_MAP_LANE_LABEL_HEIGHT = 24;

const COLUMN_GAP = 88;
const LANE_ROW_GAP = 14;
const LANE_PAD_BOTTOM = 12;
/** The empty band between two lanes. Long edges run along it, so it has to
 * hold a few parallel lines without either lane being touched. */
const LANE_GAP = 36;
const PADDING = 14;
/** How far apart two long edges sharing a band are held. */
const EDGE_STEP = 7;
/** Roughly one character of the label typeface, used to keep a label's whole
 * width clear of the boxes rather than only its midpoint. */
const LABEL_CHARACTER_WIDTH = 6.1;
/** Ports fan out across the middle half of a node's edge, so the box keeps its
 * corners and the lines still separate. */
const PORT_BAND = CHANGE_MAP_NODE_HEIGHT * 0.5;
/** Edges that point back the way they came run under the whole diagram rather
 * than back through it, each in its own channel. */
const RETURN_CHANNEL_GAP = 26;
const RETURN_CHANNEL_STEP = 13;

export interface ChangeMapPlacedNode extends ChangeMapNode {
  x: number;
  y: number;
  /** Causal depth: how many changes had to happen before this one. */
  column: number;
  /** Which stack this node sits in inside its lane, when a file has more than
   * one change at the same depth. */
  row: number;
  lane: number;
}

/** One file's band across the diagram. The file path is written once, on the
 * lane, rather than truncated into every box that belongs to it. */
export interface ChangeMapLane {
  id: string;
  filePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
}

export interface ChangeMapPlacedEdge extends ChangeMapEdge {
  /** SVG path from a port on the source node to a port on the target, bent
   * along a lane band when it has more than one column to cross. */
  path: string;
  labelX: number;
  labelY: number;
  /** Points back toward an earlier column, so it is drawn under the diagram as
   * a returning curve. */
  backward: boolean;
}

export interface ChangeMapLayout {
  nodes: ChangeMapPlacedNode[];
  lanes: ChangeMapLane[];
  edges: ChangeMapPlacedEdge[];
  width: number;
  height: number;
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

  // A change nothing caused starts at the left, like any other root. It used
  // to be given a trailing column of its own, which bought a label the dashed
  // border already carries and cost the diagram a whole empty column of width.
  for (const node of map.nodes) {
    if (node.degree === 0) columns.set(node.id, 0);
  }

  // Layering a cycle can leave a column with nothing in it. Closing the gaps
  // keeps the diagram from opening on an empty band of canvas.
  const used = [...new Set(columns.values())].sort((left, right) => left - right);
  const compacted = new Map(used.map((column, index) => [column, index]));
  for (const [id, column] of columns) columns.set(id, compacted.get(column)!);
  return columns;
}

function append<K, T>(index: Map<K, T[]>, key: K, value: T): void {
  index.set(key, [...(index.get(key) ?? []), value]);
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
 * enters every box and band flat, which is what makes a bundle of them read as
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

  // Lanes appear in the order their first change does — shallowest column,
  // then earliest change in the diff — so reading top to bottom follows the
  // same order as reading the queue.
  const ordered = [...map.nodes].sort((left, right) =>
    (columns.get(left.id)! - columns.get(right.id)!) || (left.ordinal - right.ordinal));
  const laneOrder: string[] = [];
  const laneMembers = new Map<string, ChangeMapNode[]>();
  for (const node of ordered) {
    if (!laneMembers.has(node.filePath)) {
      laneMembers.set(node.filePath, []);
      laneOrder.push(node.filePath);
    }
    laneMembers.get(node.filePath)!.push(node);
  }

  const nodes: ChangeMapPlacedNode[] = [];
  const lanes: ChangeMapLane[] = [];
  let cursor = LANE_GAP;
  laneOrder.forEach((filePath, lane) => {
    const members = laneMembers.get(filePath)!;
    const top = cursor + CHANGE_MAP_LANE_LABEL_HEIGHT;
    const taken = new Map<number, number>();
    let rows = 1;
    for (const node of members) {
      const column = columns.get(node.id)!;
      const row = taken.get(column) ?? 0;
      taken.set(column, row + 1);
      rows = Math.max(rows, row + 1);
      nodes.push({ ...node, column, row, lane, x: columnX(column), y: top + row * (CHANGE_MAP_NODE_HEIGHT + LANE_ROW_GAP) });
    }
    const height = CHANGE_MAP_LANE_LABEL_HEIGHT + rows * CHANGE_MAP_NODE_HEIGHT + (rows - 1) * LANE_ROW_GAP + LANE_PAD_BOTTOM;
    lanes.push({ id: filePath, filePath, x: PADDING - 8, y: cursor, width: 0, height, nodeCount: members.length });
    cursor += height + LANE_GAP;
  });

  const width = PADDING * 2 + (lastColumn + 1) * (CHANGE_MAP_NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP;
  for (const lane of lanes) lane.width = width - 2 * (PADDING - 8);
  const bottom = lanes.length === 0 ? CHANGE_MAP_NODE_HEIGHT : cursor - LANE_GAP;

  // The empty bands a long edge may run along: above the first lane, between
  // each neighbouring pair, and below the last.
  const bands = [LANE_GAP / 2, ...lanes.map((lane) => lane.y + lane.height + LANE_GAP / 2)];

  const placed = new Map(nodes.map((node) => [node.id, node]));
  const centreY = (nodeId: string) => placed.get(nodeId)!.y + CHANGE_MAP_NODE_HEIGHT / 2;

  const forward: ChangeMapEdge[] = [];
  const returning: ChangeMapEdge[] = [];
  for (const edge of map.edges) {
    const from = placed.get(edge.fromId);
    const to = placed.get(edge.toId);
    if (!from || !to) continue;
    (to.column > from.column ? forward : returning).push(edge);
  }

  // Ports are handed out in the order the lines arrive vertically, so the fan
  // out of a node never crosses itself before it has left the box.
  const ports = new Map<string, { start: number; end: number }>();
  const assignPorts = (side: 'start' | 'end') => {
    const grouped = new Map<string, ChangeMapEdge[]>();
    for (const edge of forward) append(grouped, side === 'start' ? edge.fromId : edge.toId, edge);
    for (const [nodeId, list] of grouped) {
      const node = placed.get(nodeId)!;
      const far = (edge: ChangeMapEdge) => centreY(side === 'start' ? edge.toId : edge.fromId);
      const sorted = [...list].sort((left, right) => (far(left) - far(right)) || left.id.localeCompare(right.id));
      sorted.forEach((edge, index) => {
        const existing = ports.get(edge.id) ?? { start: 0, end: 0 };
        ports.set(edge.id, { ...existing, [side]: portY(node.y, sorted.length, index) });
      });
    }
  };
  assignPorts('start');
  assignPorts('end');

  // An edge that crosses more than one column would fly over whatever sits in
  // between, so it is put on the band nearest to both of its ends instead.
  // Bands hold no boxes, which is what makes the detour safe rather than only
  // usually safe.
  const banded = new Map<string, number>();
  const sharing = new Map<number, string[]>();
  for (const edge of forward) {
    if (placed.get(edge.toId)!.column - placed.get(edge.fromId)!.column < 2) continue;
    const { start, end } = ports.get(edge.id)!;
    const cost = (band: number) => Math.abs(band - start) + Math.abs(band - end);
    const chosen = bands.reduce((best, band) => (cost(band) < cost(best) ? band : best), bands[0]);
    banded.set(edge.id, chosen);
    append(sharing, chosen, edge.id);
  }
  const spread = new Map<string, number>();
  for (const [, ids] of sharing) {
    const sorted = [...ids].sort();
    sorted.forEach((id, index) => spread.set(id, (index - (sorted.length - 1) / 2) * EDGE_STEP));
  }

  /** A label that would land on a box is lifted just above it — a line's name
   * printed underneath a change is a name nobody reads. The label is centred on
   * its point, so it is its whole width that has to clear the box, not the
   * point: half a name disappearing under a card is the same bug as all of it. */
  const clearOfBoxes = (point: Point, text: string): number => {
    const reach = text.length * LABEL_CHARACTER_WIDTH / 2 + 3;
    const clash = nodes.find((node) => point.x + reach > node.x - 6 && point.x - reach < node.x + CHANGE_MAP_NODE_WIDTH + 6
      && point.y > node.y - 9 && point.y < node.y + CHANGE_MAP_NODE_HEIGHT + 9);
    return clash ? clash.y - 9 : point.y;
  };

  /** A label that would land on a lane's file path is lifted into the empty
   * band just above that lane. Two pieces of text in the same place is the one
   * thing that makes a diagram unreadable outright. */
  const clearOfLaneLabels = (y: number): number => {
    const clash = lanes.find((lane) => y > lane.y - 3 && y < lane.y + CHANGE_MAP_LANE_LABEL_HEIGHT + 3);
    return clash ? clash.y - 9 : y;
  };

  const edges: ChangeMapPlacedEdge[] = [];
  for (const edge of forward) {
    const from = placed.get(edge.fromId)!;
    const to = placed.get(edge.toId)!;
    const port = ports.get(edge.id)!;
    const start = { x: from.x + CHANGE_MAP_NODE_WIDTH, y: port.start };
    const end = { x: to.x, y: port.end };
    const band = banded.get(edge.id);
    const points = band === undefined
      ? [start, end]
      : (() => {
        const limit = LANE_GAP / 2 - 4;
        const line = band + Math.max(-limit, Math.min(limit, spread.get(edge.id) ?? 0));
        return [start, { x: start.x + COLUMN_GAP / 2, y: line }, { x: end.x - COLUMN_GAP / 2, y: line }, end];
      })();
    const label = pathMidpoint(points);
    edges.push({ ...edge, backward: false, path: smoothPath(points), labelX: label.x, labelY: clearOfLaneLabels(clearOfBoxes(label, changeEdgeLabel(edge))) });
  }

  // Two labels lifted clear of the same box can land on top of each other,
  // which is the collision they were moved to avoid. Later ones step up into
  // the band until they are clear, in an order fixed by position and then id
  // so that the same diff still draws the same picture.
  const settled: { x: number; y: number; reach: number }[] = [];
  const byPosition = [...edges].sort((left, right) =>
    (left.labelY - right.labelY) || (left.labelX - right.labelX) || left.id.localeCompare(right.id));
  for (const edge of byPosition) {
    const reach = changeEdgeLabel(edge).length * LABEL_CHARACTER_WIDTH / 2 + 3;
    let y = edge.labelY;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const overlaps = settled.some((other) => Math.abs(other.y - y) < 12 && Math.abs(other.x - edge.labelX) < other.reach + reach);
      if (!overlaps) break;
      y -= 13;
    }
    edge.labelY = y;
    settled.push({ x: edge.labelX, y, reach });
  }

  let deepest = bottom;
  returning.forEach((edge, index) => {
    const from = placed.get(edge.fromId)!;
    const to = placed.get(edge.toId)!;
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

  return { nodes, lanes, edges, width, height: deepest + PADDING };
}
