import { describe, expect, it } from 'vitest';
import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';
import { selectChangeConnections, selectFocusedChangeMap } from './change-map-logic.js';

function node(id: string, ordinal: number): ChangeMapNode {
  return {
    id, ordinal, label: id, degree: 1, subject: id, filePath: `src/${id}.ts`, fileCount: 1,
    filePaths: [`src/${id}.ts`], symbols: [], signatureChanges: [],
    behavior: `Changes ${id}.`, additions: 1, deletions: 0, state: null, riskSignals: [],
  };
}

function edge(fromId: string, toId: string, relation: ChangeMapEdge['relation'] = 'calls'): ChangeMapEdge {
  return { id: `${fromId}->${toId}`, fromId, toId, relation, change: 'added', symbols: [], explanation: `${fromId} to ${toId}` };
}

const nodes = [node('root', 1), ...Array.from({ length: 6 }, (_, index) => node(`up-${index + 1}`, index + 2)), ...Array.from({ length: 6 }, (_, index) => node(`down-${index + 1}`, index + 8))];
const map: ChangeMap = {
  nodes,
  edges: [
    ...nodes.slice(1, 7).map((item) => edge(item.id, 'root', item.id === 'up-6' ? 'passes-parameter' : 'calls')),
    ...nodes.slice(7).map((item) => edge('root', item.id)),
    edge('up-1', 'down-1', 'uses'),
  ],
  omittedEdges: 2,
};

describe('change map focus selectors', () => {
  it('separates and prioritizes direct upstream and downstream changes', () => {
    const result = selectChangeConnections(map, 'root');

    expect(result.selected?.id).toBe('root');
    expect(result.upstream).toHaveLength(6);
    expect(result.downstream).toHaveLength(6);
    expect(result.upstream[0].related.id).toBe('up-6');
    expect(result.upstream.every((connection) => connection.direction === 'upstream')).toBe(true);
  });

  it('bounds each direction and excludes incidental neighbor edges', () => {
    const result = selectFocusedChangeMap(map, 'root', 2);

    expect(result.visibleConnections).toBe(4);
    expect(result.hiddenConnections).toBe(8);
    expect(result.map.nodes).toHaveLength(5);
    expect(result.map.edges).toHaveLength(4);
    expect(result.map.edges.some((item) => item.id === 'up-1->down-1')).toBe(false);
    expect(result.map.omittedEdges).toBe(2);
  });
});
