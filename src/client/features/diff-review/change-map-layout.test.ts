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
  return { id: `${fromId}->${toId}`, fromId, toId, relation, change: 'added', symbols: [], explanation: `${fromId} to ${toId}` };
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
  it('routes an edge that skips a column around the box in it instead of through it', () => {
    const layout = layoutChangeMap(skipping);
    const long = layout.edges.find((item) => item.id === 'a->c')!;
    const skipped = layout.nodes.find((item) => item.id === 'b')!;

    // Three points — a port, a lane, a port — rather than one straight hop.
    expect(long.path.split(' C ')).toHaveLength(3);
    const lane = pathPoints(long.path)[1];
    expect(lane.x).toBeGreaterThan(skipped.x);
    expect(lane.x).toBeLessThan(skipped.x + CHANGE_MAP_NODE_WIDTH);
    const clearsBox = lane.y < skipped.y || lane.y > skipped.y + CHANGE_MAP_NODE_HEIGHT;
    expect(clearsBox).toBe(true);
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

  it('centres short columns against the tallest one so edges stay level', () => {
    const lopsided: ChangeMap = {
      nodes: [node('hub', 1, 3), node('leaf-1', 2), node('leaf-2', 3), node('leaf-3', 4)],
      edges: [edge('hub', 'leaf-1'), edge('hub', 'leaf-2'), edge('hub', 'leaf-3')],
      omittedEdges: 0,
    };
    const layout = layoutChangeMap(lopsided);
    const hub = layout.nodes.find((item) => item.id === 'hub')!;
    const leaves = layout.nodes.filter((item) => item.id !== 'hub');
    const leafMiddle = (Math.min(...leaves.map((leaf) => leaf.y)) + Math.max(...leaves.map((leaf) => leaf.y + CHANGE_MAP_NODE_HEIGHT))) / 2;

    expect(Math.abs((hub.y + CHANGE_MAP_NODE_HEIGHT / 2) - leafMiddle)).toBeLessThanOrEqual(1);
  });

  it('puts the same diff in the same places every time', () => {
    expect(layoutChangeMap(skipping)).toEqual(layoutChangeMap(skipping));
  });
});
