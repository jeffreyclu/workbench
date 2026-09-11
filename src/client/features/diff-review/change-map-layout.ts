import { type ChangeMap, type ChangeMapEdge, type ChangeMapNode } from '../../../shared/change-map.js';

/** The graph stays deterministic: the same diff always produces the same map.
 * Packages contain folders, folders contain code blocks, and every dependency
 * is a direct curve between the two blocks. */
const PADDING = 28;
const PACKAGE_GAP = 36;
const PACKAGE_PADDING = 18;
const PACKAGE_LABEL_HEIGHT = 28;
const FOLDER_GAP = 18;
const FOLDER_PADDING = 14;
const FOLDER_LABEL_HEIGHT = 24;
const NODE_GAP = 18;
const MIN_NODE_WIDTH = 150;
const MAX_NODE_WIDTH = 270;
const MIN_NODE_HEIGHT = 108;
const MAX_NODE_HEIGHT = 156;

export type ChangeMapCodeCategory = 'test' | 'ui' | 'type' | 'data' | 'service' | 'code';

export interface ChangeMapPlacedNode extends ChangeMapNode {
  x: number;
  y: number;
  width: number;
  height: number;
  packageId: string;
  folderId: string;
  category: ChangeMapCodeCategory;
}

export interface ChangeMapFolder {
  id: string;
  label: string;
  packageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
}

export interface ChangeMapPackage {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  folderCount: number;
}

export interface ChangeMapPlacedEdge extends ChangeMapEdge {
  path: string;
  labelX: number;
  labelY: number;
  crossesFolder: boolean;
  crossesPackage: boolean;
}

export interface ChangeMapLayout {
  nodes: ChangeMapPlacedNode[];
  folders: ChangeMapFolder[];
  packages: ChangeMapPackage[];
  edges: ChangeMapPlacedEdge[];
  width: number;
  height: number;
}

function pathParts(filePath: string): string[] {
  return filePath.split('/').filter(Boolean);
}

/** Monorepo roots get a two-segment package name. A conventional single app
 * has one repository package so its domain folders remain siblings. */
export function packageForPath(filePath: string): string {
  const parts = pathParts(filePath);
  if (parts.length >= 2 && ['apps', 'packages', 'services', 'libs'].includes(parts[0])) return `${parts[0]}/${parts[1]}`;
  return 'root';
}

export function folderForPath(filePath: string): string {
  const parts = pathParts(filePath);
  const start = packageForPath(filePath) === 'root' ? 0 : 2;
  const folders = parts.slice(start, -1);
  return folders.length > 0 ? folders.join('/') : '(package root)';
}

export function categoryForNode(node: ChangeMapNode): ChangeMapCodeCategory {
  const paths = node.filePaths.length > 0 ? node.filePaths : [node.filePath];
  if (paths.every((path) => /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[^/]+)$/.test(path))) return 'test';
  if (paths.some((path) => /\.(?:tsx|jsx)$/.test(path))) return 'ui';
  if (node.symbols.length > 0 && node.symbols.every((symbol) => symbol.kind === 'type')) return 'type';
  if (paths.some((path) => /(?:^|\/)(?:db|database|data|repository|storage|migrations?)(?:\/|\.|$)/i.test(path))) return 'data';
  if (paths.some((path) => /(?:^|\/)(?:api|server|service|routes?)(?:\/|\.|$)/i.test(path))) return 'service';
  return 'code';
}

function dimensions(node: ChangeMapNode): { width: number; height: number } {
  const lines = Math.max(1, node.additions + node.deletions);
  const scale = Math.sqrt(lines);
  return {
    width: Math.min(MAX_NODE_WIDTH, MIN_NODE_WIDTH + scale * 12),
    height: Math.min(MAX_NODE_HEIGHT, MIN_NODE_HEIGHT + scale * 7),
  };
}

function append<K, T>(map: Map<K, T[]>, key: K, value: T): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

interface Box { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }

function boundaryPoint(box: Box, toward: Point): Point {
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const dx = toward.x - centre.x;
  const dy = toward.y - centre.y;
  if (dx === 0 && dy === 0) return centre;
  const scale = 1 / Math.max(Math.abs(dx) / (box.width / 2), Math.abs(dy) / (box.height / 2));
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

function curve(from: ChangeMapPlacedNode, to: ChangeMapPlacedNode, index: number): { path: string; label: Point } {
  const fromCentre = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCentre = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const start = boundaryPoint(from, toCentre);
  const end = boundaryPoint(to, fromCentre);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const offset = ((index % 5) - 2) * 5;
  const control = { x: (start.x + end.x) / 2 - dy / length * offset, y: (start.y + end.y) / 2 + dx / length * offset };
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y}, ${end.x} ${end.y}`,
    label: { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 },
  };
}

export function layoutChangeMap(map: ChangeMap): ChangeMapLayout {
  const packageNodes = new Map<string, ChangeMapNode[]>();
  for (const node of [...map.nodes].sort((a, b) => a.ordinal - b.ordinal)) append(packageNodes, packageForPath(node.filePath), node);

  const nodes: ChangeMapPlacedNode[] = [];
  const folders: ChangeMapFolder[] = [];
  const packages: ChangeMapPackage[] = [];
  let packageX = PADDING;

  for (const [packageId, members] of packageNodes) {
    const folderNodes = new Map<string, ChangeMapNode[]>();
    for (const node of members) append(folderNodes, folderForPath(node.filePath), node);
    const folderLayouts: Array<{ id: string; width: number; height: number; members: Array<ChangeMapNode & { width: number; height: number }> }> = [];
    let packageWidth = 360;

    for (const [folderId, folderMembers] of folderNodes) {
      const sized = folderMembers.map((node) => ({ ...node, ...dimensions(node) }));
      const columns = Math.max(1, Math.ceil(Math.sqrt(sized.length)));
      const rows = Math.ceil(sized.length / columns);
      const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(...sized.filter((_, index) => index % columns === column).map((node) => node.width)));
      const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...sized.slice(row * columns, (row + 1) * columns).map((node) => node.height)));
      const width = FOLDER_PADDING * 2 + columnWidths.reduce((sum, value) => sum + value, 0) + NODE_GAP * (columns - 1);
      const height = FOLDER_LABEL_HEIGHT + FOLDER_PADDING * 2 + rowHeights.reduce((sum, value) => sum + value, 0) + NODE_GAP * (rows - 1);
      folderLayouts.push({ id: folderId, width, height, members: sized });
      packageWidth = Math.max(packageWidth, width + PACKAGE_PADDING * 2);
    }

    const packageHeight = PACKAGE_LABEL_HEIGHT + PACKAGE_PADDING * 2 + folderLayouts.reduce((sum, folder) => sum + folder.height, 0) + FOLDER_GAP * Math.max(0, folderLayouts.length - 1);
    const packageY = PADDING;
    packages.push({ id: packageId, label: packageId, x: packageX, y: packageY, width: packageWidth, height: packageHeight, folderCount: folderLayouts.length });

    let folderY = packageY + PACKAGE_LABEL_HEIGHT + PACKAGE_PADDING;
    for (const folder of folderLayouts) {
      const folderX = packageX + PACKAGE_PADDING;
      folders.push({ id: `${packageId}:${folder.id}`, label: folder.id, packageId, x: folderX, y: folderY, width: packageWidth - PACKAGE_PADDING * 2, height: folder.height, nodeCount: folder.members.length });
      const columns = Math.max(1, Math.ceil(Math.sqrt(folder.members.length)));
      const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(...folder.members.filter((_, index) => index % columns === column).map((node) => node.width)));
      const rowHeights = Array.from({ length: Math.ceil(folder.members.length / columns) }, (_, row) => Math.max(...folder.members.slice(row * columns, (row + 1) * columns).map((node) => node.height)));
      const columnOffsets = columnWidths.map((_, column) => columnWidths.slice(0, column).reduce((sum, value) => sum + value, 0) + NODE_GAP * column);
      const rowOffsets = rowHeights.map((_, row) => rowHeights.slice(0, row).reduce((sum, value) => sum + value, 0) + NODE_GAP * row);
      folder.members.forEach((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        nodes.push({ ...node, x: folderX + FOLDER_PADDING + columnOffsets[column], y: folderY + FOLDER_LABEL_HEIGHT + FOLDER_PADDING + rowOffsets[row], packageId, folderId: folder.id, category: categoryForNode(node) });
      });
      folderY += folder.height + FOLDER_GAP;
    }
    packageX += packageWidth + PACKAGE_GAP;
  }

  const placed = new Map(nodes.map((node) => [node.id, node]));
  const edges = map.edges.flatMap((edge, index): ChangeMapPlacedEdge[] => {
    const from = placed.get(edge.fromId);
    const to = placed.get(edge.toId);
    if (!from || !to) return [];
    const curved = curve(from, to, index);
    return [{ ...edge, path: curved.path, labelX: curved.label.x, labelY: curved.label.y, crossesFolder: from.folderId !== to.folderId || from.packageId !== to.packageId, crossesPackage: from.packageId !== to.packageId }];
  });
  const width = Math.max(480, packageX - PACKAGE_GAP + PADDING);
  const height = Math.max(280, ...packages.map((item) => item.y + item.height + PADDING));
  return { nodes, folders, packages, edges, width, height };
}
