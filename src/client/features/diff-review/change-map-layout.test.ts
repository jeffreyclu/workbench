import { describe, expect, it } from 'vitest';
import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';
import { CHANGE_MAP_NODE_HEIGHT, CHANGE_MAP_NODE_WIDTH, layoutChangeMap } from './change-map-layout.js';

function node(id: string, ordinal: number, degree = 1): ChangeMapNode {
  return {
    id, ordinal, label: id, degree, subject: id, filePath: `src/${id}.ts`, fileCount: 1,
    filePaths: [`src/${id}.ts`], symbols: [], signatureChanges: [],
    behavior: `Changes ${id}.`, additions: 1, deletions: 0, state: null, riskSignals: [],
  };
}

function edge(fromId: string, toId: string, relation: ChangeMapEdge['relation'] = 'calls'): ChangeMapEdge {
  return { id: `${fromId}->${toId}`, fromId, toId, relation, change: 'added', prior: null, symbols: [], explanation: `${fromId} to ${toId}` };
}

/** A chain a → b → c plus the long edge a → c that skips a column, which is the
 * case the old layout drew straight over b. */
const skipping: ChangeMap = {
  nodes: [node('a', 1, 2), node('b', 2, 2), node('c', 3, 2)],
  edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'c', 'uses')],
  omittedEdges: 0,
};

/** The points the line actually passes through — the start and the end of each
 * cubic — rather than the control points that shape it. */
function pathPoints(path: string): { x: number; y: number }[] {
  const [move, ...curves] = path.split(' C ');
  const point = (pair: string) => {
    const [x, y] = pair.trim().split(' ').map(Number);
    return { x, y };
  };
  return [point(move.replace('M ', '')), ...curves.map((curve) => point(curve.split(',').at(-1)!))];
}

describe('change map layout', () => {
  it('runs an edge that skips a column along an empty band rather than across the box in it', () => {
    const layout = layoutChangeMap(skipping);
    const long = layout.edges.find((item) => item.id === 'a->c')!;
    const skipped = layout.nodes.find((item) => item.id === 'b')!;
    const points = pathPoints(long.path);

    // Out of the port, along a band, back into a port. The flat middle run is
    // the part that has to pass the skipped box, so it is checked against
    // every box rather than only against that one.
    expect(points).toHaveLength(4);
    expect(points[1].y).toBe(points[2].y);
    expect(points[1].x).toBeLessThan(skipped.x);
    expect(points[2].x).toBeGreaterThan(skipped.x + CHANGE_MAP_NODE_WIDTH);
    for (const box of layout.nodes) {
      const crossesBox = points[1].y > box.y && points[1].y < box.y + CHANGE_MAP_NODE_HEIGHT;
      expect(crossesBox).toBe(false);
    }
  });

  it('gives every line leaving one node its own place on the edge of the box', () => {
    const fan: ChangeMap = {
      nodes: [node('root', 1, 3), node('one', 2), node('two', 3), node('three', 4)],
      edges: [edge('root', 'one'), edge('root', 'two'), edge('root', 'three')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(fan);
    const starts = layout.edges.map((item) => pathPoints(item.path)[0].y);

    expect(new Set(starts).size).toBe(3);
    const root = layout.nodes.find((item) => item.id === 'root')!;
    for (const start of starts) {
      expect(start).toBeGreaterThanOrEqual(root.y);
      expect(start).toBeLessThanOrEqual(root.y + CHANGE_MAP_NODE_HEIGHT);
    }
  });

  it('sends an edge that points back the way it came under the diagram', () => {
    const cyclic: ChangeMap = {
      nodes: [node('first', 1, 2), node('second', 2, 2)],
      edges: [edge('first', 'second'), edge('second', 'first', 'uses')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(cyclic);
    // Either edge of the pair can be the one that closes the cycle; exactly one
    // of them has to be, and it is the one routed underneath.
    const back = layout.edges.filter((item) => item.backward);
    const lowestBox = Math.max(...layout.nodes.map((item) => item.y + CHANGE_MAP_NODE_HEIGHT));

    expect(back).toHaveLength(1);
    expect(layout.height).toBeGreaterThan(lowestBox);
    expect(back[0].labelY).toBeGreaterThan(lowestBox);
  });

  it('gives each file one named row and keeps every change to it inside that row', () => {
    const shared: ChangeMap = {
      nodes: [
        { ...node('one', 1, 1), filePath: 'src/card.tsx' },
        { ...node('two', 2, 1), filePath: 'src/card.tsx' },
        { ...node('cause', 3, 2), filePath: 'src/hook.ts' },
      ],
      edges: [edge('cause', 'one'), edge('cause', 'two')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(shared);

    // Rows appear in the order their first change does, so the cause is read
    // before the two changes it explains.
    expect(layout.lanes.map((lane) => lane.filePath)).toEqual(['src/hook.ts', 'src/card.tsx']);
    const card = layout.lanes.find((lane) => lane.filePath === 'src/card.tsx')!;
    expect(card.nodeCount).toBe(2);
    const inCard = layout.nodes.filter((item) => item.filePath === 'src/card.tsx');
    expect(new Set(inCard.map((item) => item.y)).size).toBe(2);
    for (const placed of inCard) {
      expect(placed.y).toBeGreaterThanOrEqual(card.y);
      expect(placed.y + CHANGE_MAP_NODE_HEIGHT).toBeLessThanOrEqual(card.y + card.height);
    }
  });

  it('puts the same diff in the same places every time', () => {
    expect(layoutChangeMap(skipping)).toEqual(layoutChangeMap(skipping));
  });
});
