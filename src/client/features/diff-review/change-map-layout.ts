import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';
import { categoryOf, folderLabel, folderOf, packageOf, type CodeCategory } from './change-map-taxonomy.js';

/** Layout is presentation, so it stays out of `shared/change-map.ts`: the
 * relationships are the same whoever draws them. It is also fully
 * deterministic — no force simulation, no randomness — because a reviewer who
 * reopens the same diff must see the same picture in the same places.
 *
 * The picture is a **nested radial map**, and it is one on purpose. The grid
 * this replaced put a change one column right of whatever caused it, which
 * drew causal depth well and hid the two things a reader wants at a glance:
 * how connected a change is, and how far its connections travel. Layered lanes
 * flatten both. Every line leaves a box on the same side, so nine of them look
 * much like two; and a lane is a file, so a dependency crossing a package
 * boundary is drawn exactly like one that never left the folder.
 *
 * Three rules carry those facts instead:
 *
 * - **A node is a disc whose area is the amount of code the change moves.**
 *   Big edits are physically big, with nothing to read.
 * - **Discs sit on a ring, so lines leave them in every direction.** A symbol
 *   twenty changes depend on is a hub with twenty spokes; a leaf has one. The
 *   count is the picture rather than a number in a label.
 * - **Rings nest: nodes in a file, files in a folder, folders in a package.**
 *   An edge that stays inside a file is the shortest line; an edge to another
 *   package is a long chord across the whole diagram. Containment and reach
 *   read as line length, which needs no legend. */

/** The smallest a disc gets while still being a target a person can hit, and
 * the largest it gets before it starts eating its neighbours' room. */
export const CHANGE_MAP_MIN_NODE_RADIUS = 12;
export const CHANGE_MAP_MAX_NODE_RADIUS = 40;

/** These gaps reserve room for captions, not just circles. Packing only the
 * discs made the geometry technically non-overlapping while filenames and
 * symbol names still printed directly on top of one another. */
const NODE_GAP = 72;
const FILE_PAD = 32;
const FILE_GAP = 64;
const FOLDER_PAD = 36;
const FOLDER_GAP = 88;
const PACKAGE_PAD = 48;
const PACKAGE_GAP = 120;
const PADDING = 72;
/** How far apart two lines joining the same pair are bowed, so a mutual
 * dependency reads as two arrows rather than one thick one. */
const PARALLEL_EDGE_BOW = 14;
/** How far a caption clears the rim it belongs to, and the step between its
 * two lines. */
const LABEL_GAP = 13;
const LABEL_LINE = 12;

/** Where an edge goes, which is the whole containment reading. */
export type ChangeEdgeScope = 'file' | 'folder' | 'package' | 'cross-package';

export interface ChangeMapPlacedNode extends ChangeMapNode {
  /** Centre of the disc, not a corner: everything in this layout is radial. */
  x: number;
  y: number;
  /** Area is proportional to the lines the change moves, so radius is not. */
  radius: number;
  category: CodeCategory;
  packageId: string;
  folderId: string;
  fileId: string;
  /** Edges touching this node that leave its folder, and that leave its
   * package. A node whose degree is entirely external is code nothing around
   * it uses, which is worth seeing without counting lines. */
  externalDegree: number;
  crossPackageDegree: number;
  /** Where the caption goes. It is pushed straight out of the ring the node
   * sits on rather than always underneath, because underneath is where the
   * next disc round the ring has its own caption — two changes a little apart
   * on the same ring wrote their names on top of each other. */
  labelX: number;
  titleY: number;
  countsY: number;
  labelAnchor: 'start' | 'middle' | 'end';
}

/** One source file's ring. Decisions are review units, not files, so one file
 * can contribute several discs; this ring makes their shared ownership visible
 * before the reviewer reads a path. */
export interface ChangeMapFileGroup {
  id: string;
  packageId: string;
  folderId: string;
  filePath: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  nodeCount: number;
}

/** One folder's ring. The path is written once on the ring rather than
 * truncated into every disc inside it. */
export interface ChangeMapFolderGroup {
  id: string;
  packageId: string;
  folderPath: string;
  /** The folder's path below its package. */
  label: string;
  x: number;
  y: number;
  radius: number;
  nodeCount: number;
  internalEdges: number;
  externalEdges: number;
  /** Share of this folder's relationships that stay inside it, 0 to 1. This is
   * the "is this change self-contained" number, stated rather than left to be
   * counted off the drawing. */
  containment: number;
}

export interface ChangeMapPackageGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  folderCount: number;
  nodeCount: number;
}

export interface ChangeMapPlacedEdge extends ChangeMapEdge {
  /** A straight line from rim to rim — bowed only when a second line joins the
   * same pair and would otherwise hide under it. Straight is the point: a
   * routed line hides how many lines a node has and how far each one goes. */
  path: string;
  labelX: number;
  labelY: number;
  scope: ChangeEdgeScope;
}

export interface ChangeMapLayout {
  nodes: ChangeMapPlacedNode[];
  files: ChangeMapFileGroup[];
  folders: ChangeMapFolderGroup[];
  packages: ChangeMapPackageGroup[];
  edges: ChangeMapPlacedEdge[];
  width: number;
  height: number;
}

interface Seat {
  x: number;
  y: number;
  /** Where on its parent's ring this seat is, which is what the ring inside it
   * is rotated by. */
  angle: number;
}

/** Each ring is turned by this much relative to the seat it sits on.
 *
 * Without it every ring starts at the top, so a folder sits directly below its
 * package and a node directly below its folder — and three relationships out of
 * one change come out as three lines lying on top of each other pointing the
 * same way. The golden angle is the standard answer to that: it is irrational,
 * so no amount of nesting brings two levels back into alignment. */
const RING_TURN = Math.PI * (3 - Math.sqrt(5));

/** Coordinates are compared in tests and memoised by value, so they are held
 * to a tenth of a pixel rather than to whatever the trigonometry produced. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Area, not radius, tracks the size of the change: doubling the lines a
 * change touches doubles the ink, which is the comparison the eye actually
 * makes. Radius therefore moves with the square root. A diff whose changes are
 * all one size gets one middling disc each rather than a field of maximums. */
function nodeRadius(size: number, smallest: number, largest: number): number {
  const span = Math.sqrt(largest) - Math.sqrt(smallest);
  if (span <= 0) return (CHANGE_MAP_MIN_NODE_RADIUS + CHANGE_MAP_MAX_NODE_RADIUS) / 2;
  const position = (Math.sqrt(size) - Math.sqrt(smallest)) / span;
  return CHANGE_MAP_MIN_NODE_RADIUS + position * (CHANGE_MAP_MAX_NODE_RADIUS - CHANGE_MAP_MIN_NODE_RADIUS);
}

/** The smallest ring the given circles fit around without touching.
 *
 * A circle of radius `r` sitting on a ring of radius `R` takes up `2·asin(r/R)`
 * of that ring's angle, so the ring is big enough exactly when those angles sum
 * to no more than a full turn. Bisecting for it beats a closed formula because
 * the circles differ in size — one hub the size of four leaves is the normal
 * case here, not the exception. */
function ringRadius(radii: number[], gap: number): number {
  if (radii.length <= 1) return 0;
  const needed = radii.map((radius) => radius + gap / 2);
  const angleAt = (ring: number) => needed.reduce((sum, radius) => sum + 2 * Math.asin(Math.min(1, radius / ring)), 0);
  let low = Math.max(...needed);
  let high = low;
  while (angleAt(high) > Math.PI * 2) high *= 2;
  for (let step = 0; step < 48; step += 1) {
    const middle = (low + high) / 2;
    if (angleAt(middle) > Math.PI * 2) low = middle;
    else high = middle;
  }
  return high;
}

/** Seats each circle on the ring, giving it the angle its own size needs and
 * sharing whatever is left over evenly. Equal spacing would let a large disc
 * overlap a small neighbour, which is exactly the case a change map is full
 * of. The first seat is at the top, so the same diff always opens the same way
 * round. */
function seatOnRing(radii: number[], ring: number, gap: number, startAngle: number): Seat[] {
  if (radii.length === 1) return [{ x: 0, y: 0, angle: startAngle }];
  const widths = radii.map((radius) => 2 * Math.asin(Math.min(1, (radius + gap / 2) / ring)));
  const slack = Math.max(0, Math.PI * 2 - widths.reduce((sum, width) => sum + width, 0));
  const share = slack / radii.length;
  const seats: Seat[] = [];
  let angle = startAngle;
  for (const width of widths) {
    const centre = angle + width / 2;
    seats.push({ x: ring * Math.cos(centre), y: ring * Math.sin(centre), angle: centre });
    angle += width + share;
  }
  return seats;
}

/** Grouping keeps first-appearance order, which is what makes the drawing
 * stable: the same diff yields the same rings in the same order. */
function groupInOrder<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

interface Shaped {
  node: ChangeMapNode;
  radius: number;
  category: CodeCategory;
  packageId: string;
  folderId: string;
  fileId: string;
}

function shapeNodes(map: ChangeMap): Shaped[] {
  const sizeOf = (node: ChangeMapNode) => Math.max(1, node.additions + node.deletions);
  const sizes = map.nodes.map(sizeOf);
  const smallest = Math.min(...sizes);
  const largest = Math.max(...sizes);
  return map.nodes.map((node) => ({
    node,
    radius: nodeRadius(sizeOf(node), smallest, largest),
    category: categoryOf(node),
    packageId: packageOf(node.filePath),
    folderId: folderOf(node.filePath),
    fileId: node.filePath,
  }));
}

/** Rim to rim, so a line starts where its disc ends and the arrowhead lands on
 * the edge of its target rather than under it. Every line out of a node leaves
 * at its own angle, which is what makes a hub look like a hub. */
function edgeGeometry(from: ChangeMapPlacedNode, to: ChangeMapPlacedNode, bow: number): { path: string; labelX: number; labelY: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  const start = { x: from.x + ux * from.radius, y: from.y + uy * from.radius };
  const end = { x: to.x - ux * to.radius, y: to.y - uy * to.radius };
  if (bow === 0) {
    return {
      path: `M ${round(start.x)} ${round(start.y)} L ${round(end.x)} ${round(end.y)}`,
      labelX: round((start.x + end.x) / 2),
      labelY: round((start.y + end.y) / 2),
    };
  }
  const control = { x: (start.x + end.x) / 2 - uy * bow * 2, y: (start.y + end.y) / 2 + ux * bow * 2 };
  return {
    path: `M ${round(start.x)} ${round(start.y)} Q ${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`,
    // Midpoint of the quadratic, not of its endpoints, so the label sits on
    // the line rather than beside it.
    labelX: round((start.x + 2 * control.x + end.x) / 4),
    labelY: round((start.y + 2 * control.y + end.y) / 4),
  };
}

function scopeOf(from: ChangeMapPlacedNode, to: ChangeMapPlacedNode): ChangeEdgeScope {
  if (from.packageId !== to.packageId) return 'cross-package';
  if (from.folderId !== to.folderId) return 'package';
  return from.fileId === to.fileId ? 'file' : 'folder';
}

export function layoutChangeMap(map: ChangeMap): ChangeMapLayout {
  const shaped = shapeNodes(map);
  const byFile = groupInOrder(shaped, (item) => item.fileId);

  // A folder contains file rings, not a flat bag of decisions. This extra
  // level is what makes two changes in one source file visibly belong together.
  const fileRings = [...byFile].map(([fileId, members]) => {
    const radii = members.map((member) => member.radius);
    const ring = ringRadius(radii, NODE_GAP);
    return { fileId, folderId: members[0].folderId, packageId: members[0].packageId, members, radii, ring, radius: ring + Math.max(...radii) + FILE_PAD };
  });
  const byFolder = groupInOrder(fileRings, (item) => item.folderId);

  // Folder rings first, because a package ring is sized by the folder rings it
  // has to hold, and the outermost ring by the packages.
  const folderRings = [...byFolder].map(([folderId, rings]) => {
    const radii = rings.map((item) => item.radius);
    const ring = ringRadius(radii, FILE_GAP);
    return { folderId, packageId: rings[0].packageId, rings, radii, ring, radius: ring + Math.max(...radii) + FOLDER_PAD };
  });

  const byPackage = groupInOrder(folderRings, (ring) => ring.packageId);
  const packageRings = [...byPackage].map(([packageId, rings]) => {
    const radii = rings.map((item) => item.radius);
    const ring = ringRadius(radii, FOLDER_GAP);
    return { packageId, rings, radii, ring, radius: ring + Math.max(...radii) + PACKAGE_PAD };
  });

  const packageRadii = packageRings.map((ring) => ring.radius);
  const outerRing = ringRadius(packageRadii, PACKAGE_GAP);
  const outerSeats = seatOnRing(packageRadii, outerRing, PACKAGE_GAP, -Math.PI / 2);

  // One walk down the four levels, adding each seat to the one above it.
  const packages: ChangeMapPackageGroup[] = [];
  const folders: ChangeMapFolderGroup[] = [];
  const files: ChangeMapFileGroup[] = [];
  const nodes: ChangeMapPlacedNode[] = [];
  packageRings.forEach((packageRing, packageIndex) => {
    const seat = outerSeats[packageIndex];
    packages.push({
      id: packageRing.packageId,
      label: packageRing.packageId,
      x: seat.x,
      y: seat.y,
      radius: packageRing.radius,
      folderCount: packageRing.rings.length,
      nodeCount: packageRing.rings.reduce((sum, folderRing) => sum + folderRing.rings.reduce((fileSum, fileRing) => fileSum + fileRing.members.length, 0), 0),
    });
    const folderSeats = seatOnRing(packageRing.radii, packageRing.ring, FOLDER_GAP, seat.angle + RING_TURN);
    packageRing.rings.forEach((folderRing, folderIndex) => {
      const folderSeat = folderSeats[folderIndex];
      const centre = { x: seat.x + folderSeat.x, y: seat.y + folderSeat.y };
      const folderNodeCount = folderRing.rings.reduce((sum, fileRing) => sum + fileRing.members.length, 0);
      folders.push({
        id: folderRing.folderId,
        packageId: folderRing.packageId,
        folderPath: folderRing.folderId,
        label: folderLabel(folderRing.folderId, folderRing.packageId),
        x: centre.x,
        y: centre.y,
        radius: folderRing.radius,
        nodeCount: folderNodeCount,
        internalEdges: 0,
        externalEdges: 0,
        containment: 1,
      });
      const fileSeats = seatOnRing(folderRing.radii, folderRing.ring, FILE_GAP, folderSeat.angle + RING_TURN);
      folderRing.rings.forEach((fileRing, fileIndex) => {
        const fileSeat = fileSeats[fileIndex];
        const fileCentre = { x: centre.x + fileSeat.x, y: centre.y + fileSeat.y };
        files.push({
          id: fileRing.fileId,
          packageId: fileRing.packageId,
          folderId: fileRing.folderId,
          filePath: fileRing.fileId,
          label: fileRing.fileId.split('/').pop() ?? fileRing.fileId,
          x: fileCentre.x,
          y: fileCentre.y,
          radius: fileRing.radius,
          nodeCount: fileRing.members.length,
        });
        const nodeSeats = seatOnRing(fileRing.radii, fileRing.ring, NODE_GAP, fileSeat.angle + RING_TURN);
        fileRing.members.forEach((member, memberIndex) => {
          const nodeSeat = nodeSeats[memberIndex];
          nodes.push({
            ...member.node,
            x: fileCentre.x + nodeSeat.x,
            y: fileCentre.y + nodeSeat.y,
            radius: member.radius,
            category: member.category,
            packageId: member.packageId,
            folderId: member.folderId,
            fileId: member.fileId,
            externalDegree: 0,
            crossPackageDegree: 0,
            labelX: 0,
            titleY: 0,
            countsY: 0,
            labelAnchor: 'middle',
          });
        });
      });
    });
  });

  // Shift the whole drawing into positive space: the rings were built around
  // an origin in the middle of it.
  const shiftX = PADDING - Math.min(...packages.map((group) => group.x - group.radius));
  const shiftY = PADDING - Math.min(...packages.map((group) => group.y - group.radius));
  for (const group of packages) { group.x = round(group.x + shiftX); group.y = round(group.y + shiftY); group.radius = round(group.radius); }
  for (const group of folders) { group.x = round(group.x + shiftX); group.y = round(group.y + shiftY); group.radius = round(group.radius); }
  for (const group of files) { group.x = round(group.x + shiftX); group.y = round(group.y + shiftY); group.radius = round(group.radius); }
  for (const node of nodes) { node.x = round(node.x + shiftX); node.y = round(node.y + shiftY); node.radius = round(node.radius); }

  // Captions point away from their file ring. A file holding one change has
  // nothing to point away from, so that caption goes underneath.
  for (const node of nodes) {
    const file = files.find((group) => group.id === node.fileId)!;
    const away = Math.hypot(node.x - file.x, node.y - file.y);
    const dx = away === 0 ? 0 : (node.x - file.x) / away;
    const dy = away === 0 ? 1 : (node.y - file.y) / away;
    const reach = node.radius + LABEL_GAP;
    const anchorY = node.y + dy * reach;
    node.labelX = round(node.x + dx * reach);
    node.titleY = round(dy < -0.3 ? anchorY - LABEL_LINE : anchorY);
    node.countsY = round(node.titleY + LABEL_LINE);
    node.labelAnchor = dx > 0.3 ? 'start' : dx < -0.3 ? 'end' : 'middle';
  }

  const placedById = new Map(nodes.map((node) => [node.id, node]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const drawable = map.edges.filter((edge) => placedById.has(edge.fromId) && placedById.has(edge.toId) && edge.fromId !== edge.toId);

  // Two changes can relate in both directions at once — two functions that
  // call each other, both edited. Counting the pair first is what lets the
  // second line be bowed off the first instead of drawn under it.
  const pairKey = (edge: ChangeMapEdge) => [edge.fromId, edge.toId].sort().join(' ');
  const pairCounts = new Map<string, number>();
  for (const edge of drawable) pairCounts.set(pairKey(edge), (pairCounts.get(pairKey(edge)) ?? 0) + 1);
  const pairSeen = new Map<string, number>();

  const edges: ChangeMapPlacedEdge[] = drawable.map((edge) => {
    const from = placedById.get(edge.fromId)!;
    const to = placedById.get(edge.toId)!;
    const key = pairKey(edge);
    const total = pairCounts.get(key)!;
    const index = pairSeen.get(key) ?? 0;
    pairSeen.set(key, index + 1);
    const bow = total === 1 ? 0 : (index - (total - 1) / 2) * PARALLEL_EDGE_BOW;
    const scope = scopeOf(from, to);

    const leavesFolder = scope === 'package' || scope === 'cross-package';
    from.externalDegree += leavesFolder ? 1 : 0;
    to.externalDegree += leavesFolder ? 1 : 0;
    from.crossPackageDegree += scope === 'cross-package' ? 1 : 0;
    to.crossPackageDegree += scope === 'cross-package' ? 1 : 0;
    if (!leavesFolder) folderById.get(from.folderId)!.internalEdges += 1;
    else {
      folderById.get(from.folderId)!.externalEdges += 1;
      folderById.get(to.folderId)!.externalEdges += 1;
    }

    return { ...edge, ...edgeGeometry(from, to, bow), scope };
  });

  for (const folder of folders) {
    const total = folder.internalEdges + folder.externalEdges;
    folder.containment = total === 0 ? 1 : folder.internalEdges / total;
  }

  const right = Math.max(...packages.map((group) => group.x + group.radius));
  const bottom = Math.max(...packages.map((group) => group.y + group.radius));
  return { nodes, files, folders, packages, edges, width: round(right + PADDING), height: round(bottom + PADDING) };
}
