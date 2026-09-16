import { describe, expect, it } from 'vitest';
import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';
import { CHANGE_MAP_MAX_NODE_RADIUS, CHANGE_MAP_MIN_NODE_RADIUS, layoutChangeMap, type ChangeMapPlacedNode } from './change-map-layout.js';

function node(id: string, ordinal: number, overrides: Partial<ChangeMapNode> = {}): ChangeMapNode {
  return {
    id, ordinal, label: id, degree: 1, subject: id, filePath: `src/shared/${id}.ts`, fileCount: 1,
    filePaths: [`src/shared/${id}.ts`], symbols: [], signatureChanges: [],
    behavior: `Changes ${id}.`, additions: 4, deletions: 2, state: null, riskSignals: [],
    ...overrides,
  };
}

function edge(fromId: string, toId: string, relation: ChangeMapEdge['relation'] = 'calls'): ChangeMapEdge {
  return { id: `${fromId}->${toId}`, fromId, toId, relation, change: 'added', prior: null, symbols: [], explanation: `${fromId} to ${toId}` };
}

/** The start of the line, which is the point on the rim it leaves from. */
function start(path: string): { x: number; y: number } {
  const [x, y] = path.slice(2).split(/[ ]/).slice(0, 2).map(Number);
  return { x, y };
}

function end(path: string): { x: number; y: number } {
  const parts = path.trim().split(' ');
  return { x: Number(parts[parts.length - 2]), y: Number(parts[parts.length - 1]) };
}

function span(path: string): number {
  const from = start(path);
  const to = end(path);
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function find(nodes: ChangeMapPlacedNode[], id: string): ChangeMapPlacedNode {
  return nodes.find((item) => item.id === id)!;
}

describe('change map layout', () => {
  it('sizes a disc by how much code the change moves', () => {
    const map: ChangeMap = {
      nodes: [
        node('small', 1, { additions: 1, deletions: 0 }),
        node('middling', 2, { additions: 30, deletions: 10 }),
        node('large', 3, { additions: 300, deletions: 100 }),
      ],
      edges: [],
      omittedEdges: 0,
    };
    const { nodes } = layoutChangeMap(map);

    expect(find(nodes, 'small').radius).toBe(CHANGE_MAP_MIN_NODE_RADIUS);
    expect(find(nodes, 'large').radius).toBe(CHANGE_MAP_MAX_NODE_RADIUS);
    expect(find(nodes, 'middling').radius).toBeGreaterThan(find(nodes, 'small').radius);
    expect(find(nodes, 'middling').radius).toBeLessThan(find(nodes, 'large').radius);

    // Area tracks the line count, so a change ten times the size of another is
    // ten times the ink rather than ten times the width.
    const area = (item: ChangeMapPlacedNode) => Math.PI * item.radius ** 2;
    expect(area(find(nodes, 'large')) / area(find(nodes, 'middling'))).toBeGreaterThan(2);
  });

  it('gives a diff whose changes are all one size a middling disc each', () => {
    const map: ChangeMap = { nodes: [node('one', 1), node('two', 2)], edges: [], omittedEdges: 0 };
    for (const placed of layoutChangeMap(map).nodes) {
      expect(placed.radius).toBeGreaterThan(CHANGE_MAP_MIN_NODE_RADIUS);
      expect(placed.radius).toBeLessThan(CHANGE_MAP_MAX_NODE_RADIUS);
    }
  });

  it('sends every relationship out of a hub as its own line, in its own direction', () => {
    // The thing the old layered diagram could not show: a change nine others
    // depend on has to look like a change nine others depend on.
    const spokes = Array.from({ length: 9 }, (_, index) => node(`spoke-${index}`, index + 2));
    const map: ChangeMap = {
      nodes: [node('hub', 1, { degree: 9 }), ...spokes],
      edges: spokes.map((spoke) => edge('hub', spoke.id)),
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);
    const hub = find(layout.nodes, 'hub');

    expect(layout.edges).toHaveLength(9);
    const angles = layout.edges.map((item) => {
      const from = start(item.path);
      // Every line leaves the rim of the disc, not its centre, so the count of
      // lines touching a node is readable at the node.
      expect(Math.hypot(from.x - hub.x, from.y - hub.y)).toBeCloseTo(hub.radius, 0);
      return Math.round(Math.atan2(from.y - hub.y, from.x - hub.x) * 1000);
    });
    expect(new Set(angles).size).toBe(9);
  });

  it('keeps a folder inside its package and its changes inside the folder', () => {
    const map: ChangeMap = {
      nodes: [
        node('view', 1, { filePath: 'src/client/features/queue/view.tsx' }),
        node('logic', 2, { filePath: 'src/client/features/queue/logic.ts' }),
        node('routes', 3, { filePath: 'src/server/routes.ts' }),
      ],
      edges: [],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);

    expect(layout.packages.map((group) => group.id)).toEqual(['src/client', 'src/server']);
    expect(layout.folders.map((group) => group.folderPath)).toEqual(['src/client/features/queue', 'src/server']);

    for (const placed of layout.nodes) {
      const file = layout.files.find((group) => group.id === placed.fileId)!;
      const folder = layout.folders.find((group) => group.id === placed.folderId)!;
      const owner = layout.packages.find((group) => group.id === placed.packageId)!;
      expect(Math.hypot(placed.x - file.x, placed.y - file.y) + placed.radius).toBeLessThanOrEqual(file.radius + 0.5);
      expect(Math.hypot(file.x - folder.x, file.y - folder.y) + file.radius).toBeLessThanOrEqual(folder.radius + 0.5);
      expect(Math.hypot(placed.x - folder.x, placed.y - folder.y) + placed.radius).toBeLessThanOrEqual(folder.radius + 0.5);
      expect(Math.hypot(folder.x - owner.x, folder.y - owner.y) + folder.radius).toBeLessThanOrEqual(owner.radius + 0.5);
    }
  });

  it('groups every decision from the same file inside one file ring', () => {
    const sharedPath = 'src/client/features/queue/view.tsx';
    const map: ChangeMap = {
      nodes: [
        node('render', 1, { filePath: sharedPath, degree: 1 }),
        node('events', 2, { filePath: sharedPath, degree: 2 }),
        node('logic', 3, { filePath: 'src/client/features/queue/logic.ts', degree: 1 }),
      ],
      edges: [edge('render', 'events'), edge('events', 'logic')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);
    const shared = layout.files.find((group) => group.filePath === sharedPath)!;
    const sharedNodes = layout.nodes.filter((placed) => placed.fileId === shared.id);

    expect(layout.files).toHaveLength(2);
    expect(shared.label).toBe('view.tsx');
    expect(shared.nodeCount).toBe(2);
    expect(sharedNodes.map((placed) => placed.id)).toEqual(['render', 'events']);
    for (const placed of sharedNodes) {
      expect(Math.hypot(placed.x - shared.x, placed.y - shared.y) + placed.radius).toBeLessThanOrEqual(shared.radius + 0.5);
    }
    expect(layout.edges.find((item) => item.id === 'render->events')!.scope).toBe('file');
    expect(layout.edges.find((item) => item.id === 'events->logic')!.scope).toBe('folder');
  });

  it('makes reaching out of a folder the long line and staying in it the short one', () => {
    const map: ChangeMap = {
      nodes: [
        node('caller', 1, { filePath: 'src/client/features/queue/view.tsx', degree: 2 }),
        node('neighbour', 2, { filePath: 'src/client/features/queue/logic.ts' }),
        node('sibling', 3, { filePath: 'src/client/features/task/view.tsx' }),
        node('server', 4, { filePath: 'src/server/routes.ts' }),
      ],
      edges: [edge('caller', 'neighbour'), edge('caller', 'sibling'), edge('caller', 'server', 'imports')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);
    const scopes = new Map(layout.edges.map((item) => [item.id, item.scope]));

    expect(scopes.get('caller->neighbour')).toBe('folder');
    expect(scopes.get('caller->sibling')).toBe('package');
    expect(scopes.get('caller->server')).toBe('cross-package');

    const lengthOf = (id: string) => span(layout.edges.find((item) => item.id === id)!.path);
    expect(lengthOf('caller->neighbour')).toBeLessThan(lengthOf('caller->sibling'));
    expect(lengthOf('caller->sibling')).toBeLessThan(lengthOf('caller->server'));

    const caller = find(layout.nodes, 'caller');
    expect(caller.externalDegree).toBe(2);
    expect(caller.crossPackageDegree).toBe(1);
  });

  it('says how much of a folder stays inside it', () => {
    const map: ChangeMap = {
      nodes: [
        node('inside-a', 1, { filePath: 'src/client/features/queue/view.tsx', degree: 2 }),
        node('inside-b', 2, { filePath: 'src/client/features/queue/logic.ts', degree: 1 }),
        node('away', 3, { filePath: 'src/server/routes.ts', degree: 1 }),
      ],
      edges: [edge('inside-a', 'inside-b'), edge('inside-a', 'away', 'imports')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);
    const queue = layout.folders.find((group) => group.folderPath === 'src/client/features/queue')!;

    expect(queue.internalEdges).toBe(1);
    expect(queue.externalEdges).toBe(1);
    expect(queue.containment).toBe(0.5);

    // A folder nothing leaves reads as fully contained rather than as unknown.
    const untouched = layout.folders.find((group) => group.folderPath === 'src/server')!;
    expect(untouched.externalEdges).toBe(1);
  });

  it('draws two changes that depend on each other as two lines, not one', () => {
    const map: ChangeMap = {
      nodes: [node('first', 1, { degree: 2 }), node('second', 2, { degree: 2 })],
      edges: [edge('first', 'second'), edge('second', 'first', 'uses')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);

    expect(layout.edges).toHaveLength(2);
    const [forward, back] = layout.edges;
    expect(forward.path).not.toBe(back.path);
    // Both are bowed off the straight line between the pair, in opposite
    // directions, so neither hides under the other.
    for (const item of layout.edges) expect(item.path).toContain(' Q ');
  });

  it('drops a relationship whose other end is not in the drawing', () => {
    const map: ChangeMap = {
      nodes: [node('present', 1)],
      edges: [edge('present', 'absent')],
      omittedEdges: 0,
    };
    expect(layoutChangeMap(map).edges).toHaveLength(0);
  });

  it('never overlaps two discs, or two rings, however lopsided the diff', () => {
    // Circle packing is the one thing that can quietly ruin this drawing: a
    // hub twenty times the size of its neighbours has to push them apart
    // rather than cover them.
    const folders = ['src/client/features/queue', 'src/client/features/task', 'src/server', 'src/shared'];
    const map: ChangeMap = {
      nodes: Array.from({ length: 24 }, (_, index) => node(`n${index}`, index + 1, {
        filePath: `${folders[index % folders.length]}/file-${index}.ts`,
        additions: index === 0 ? 900 : (index % 7) + 1,
        deletions: index % 3,
      })),
      edges: [],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);

    for (const [index, left] of layout.nodes.entries()) {
      for (const right of layout.nodes.slice(index + 1)) {
        expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeGreaterThan(left.radius + right.radius);
      }
    }
    for (const [index, left] of layout.folders.entries()) {
      for (const right of layout.folders.slice(index + 1)) {
        expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeGreaterThan(left.radius + right.radius);
      }
    }
    for (const [index, left] of layout.files.entries()) {
      for (const right of layout.files.slice(index + 1)) {
        if (left.folderId !== right.folderId) continue;
        expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeGreaterThan(left.radius + right.radius);
      }
    }
    // And the drawing reports a canvas big enough to hold what it placed.
    for (const placed of layout.nodes) {
      expect(placed.x + placed.radius).toBeLessThan(layout.width);
      expect(placed.y + placed.radius).toBeLessThan(layout.height);
      expect(placed.x - placed.radius).toBeGreaterThan(0);
      expect(placed.y - placed.radius).toBeGreaterThan(0);
    }
  });

  it('draws every relationship as one direct line, never a routed elbow', () => {
    // Carried over from the other implementation's suite. The lane layout this
    // replaced drew orthogonal elbows, and an elbow hides both how many lines
    // leave a node and how far each one reaches.
    const layout = layoutChangeMap({
      nodes: [node('hub', 1), node('one', 2), node('two', 3), node('three', 4)],
      edges: [edge('hub', 'one'), edge('hub', 'two'), edge('hub', 'three')],
      omittedEdges: 0,
    });

    expect(layout.edges).toHaveLength(3);
    for (const placed of layout.edges) {
      expect(placed.path).toMatch(/^M -?[\d.]+ -?[\d.]+ [LQ] /);
      expect(placed.path).not.toMatch(/[HVCAST]/);
      expect(placed.path.match(/[LQ]/g)).toHaveLength(1);
    }
  });

  it('groups folders inside packages in a workspace, and marks what leaves them', () => {
    // Also carried over: the rest of these cases use one project's `src/*`
    // divisions, and a published-package repository is the other half of what
    // the package ring has to hold.
    const map: ChangeMap = {
      nodes: [
        node('button', 1, { filePath: 'packages/ui/src/button.tsx' }),
        node('dialog', 2, { filePath: 'packages/ui/src/dialog.tsx' }),
        node('query', 3, { filePath: 'packages/data/src/query.ts' }),
      ],
      edges: [edge('button', 'dialog'), edge('dialog', 'query')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);

    expect(layout.packages.map((item) => item.label).sort()).toEqual(['packages/data', 'packages/ui']);
    expect(layout.folders.map((item) => item.label)).toEqual(['src', 'src']);
    expect(layout.edges.find((item) => item.id === 'button->dialog')!.scope).toBe('folder');
    expect(layout.edges.find((item) => item.id === 'dialog->query')!.scope).toBe('cross-package');
  });

  it('puts the same diff in the same places every time', () => {
    const map: ChangeMap = {
      nodes: [
        node('one', 1, { filePath: 'src/client/a.ts', additions: 9, degree: 1 }),
        node('two', 2, { filePath: 'src/server/b.ts', additions: 40, degree: 1 }),
      ],
      edges: [edge('one', 'two')],
      omittedEdges: 0,
    };
    expect(layoutChangeMap(map)).toEqual(layoutChangeMap(map));
  });
});
