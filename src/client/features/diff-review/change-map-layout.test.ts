import { describe, expect, it } from 'vitest';
import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';
import { categoryForNode, folderForPath, layoutChangeMap, packageForPath } from './change-map-layout.js';

function node(id: string, ordinal: number, filePath = `src/${id}.ts`, additions = 1, deletions = 0): ChangeMapNode {
  return {
    id, ordinal, label: id, degree: 1, subject: id, filePath, fileCount: 1,
    filePaths: [filePath], symbols: [], signatureChanges: [],
    behavior: `Changes ${id}.`, additions, deletions, state: null, riskSignals: [],
  };
}

function edge(fromId: string, toId: string, relation: ChangeMapEdge['relation'] = 'calls'): ChangeMapEdge {
  return { id: `${fromId}->${toId}`, fromId, toId, relation, change: 'added', prior: null, symbols: [], explanation: `${fromId} to ${toId}` };
}

describe('change map layout', () => {
  it('makes node area grow with the number of changed code lines', () => {
    const layout = layoutChangeMap({
      nodes: [node('small', 1, 'src/a/small.ts', 1), node('large', 2, 'src/a/large.ts', 80, 20)],
      edges: [edge('small', 'large')], omittedEdges: 0,
    });
    const small = layout.nodes.find((item) => item.id === 'small')!;
    const large = layout.nodes.find((item) => item.id === 'large')!;

    expect(large.width * large.height).toBeGreaterThan(small.width * small.height);
  });

  it('draws every relationship as a direct curved line radiating from its source node', () => {
    const layout = layoutChangeMap({
      nodes: [node('hub', 1), node('one', 2), node('two', 3), node('three', 4)],
      edges: [edge('hub', 'one'), edge('hub', 'two'), edge('hub', 'three')], omittedEdges: 0,
    });

    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.every((item) => item.path.startsWith('M ') && item.path.includes(' Q '))).toBe(true);
    expect(layout.edges.every((item) => !item.path.includes(' C '))).toBe(true);
  });

  it('groups folders inside packages and marks cross-boundary coupling', () => {
    const map: ChangeMap = {
      nodes: [
        node('button', 1, 'packages/ui/src/button.tsx'),
        node('dialog', 2, 'packages/ui/src/dialog.tsx'),
        node('query', 3, 'packages/data/src/query.ts'),
      ],
      edges: [edge('button', 'dialog'), edge('dialog', 'query')], omittedEdges: 0,
    };
    const layout = layoutChangeMap(map);

    expect(layout.packages.map((item) => item.label)).toEqual(['packages/ui', 'packages/data']);
    expect(layout.folders.map((item) => item.label)).toEqual(['src', 'src']);
    expect(layout.edges.find((item) => item.id === 'button->dialog')).toMatchObject({ crossesFolder: false, crossesPackage: false });
    expect(layout.edges.find((item) => item.id === 'dialog->query')).toMatchObject({ crossesFolder: true, crossesPackage: true });
  });

  it('uses stable package and folder path rules', () => {
    expect(packageForPath('packages/ui/src/card.tsx')).toBe('packages/ui');
    expect(folderForPath('packages/ui/src/card.tsx')).toBe('src');
    expect(packageForPath('src/client/card.tsx')).toBe('root');
    expect(folderForPath('src/client/card.tsx')).toBe('src/client');
  });

  it('assigns semantic categories from code shape and path', () => {
    expect(categoryForNode(node('component', 1, 'src/card.tsx'))).toBe('ui');
    expect(categoryForNode(node('spec', 1, 'src/card.test.ts'))).toBe('test');
    expect(categoryForNode({ ...node('contract', 1), symbols: [{ name: 'Contract', kind: 'type', change: 'changed' }] })).toBe('type');
    expect(categoryForNode(node('repo', 1, 'src/database/repository.ts'))).toBe('data');
    expect(categoryForNode(node('route', 1, 'src/server/routes.ts'))).toBe('service');
    expect(categoryForNode(node('logic', 1, 'src/shared/logic.ts'))).toBe('code');
  });

  it('puts the same diff in the same places every time', () => {
    const map: ChangeMap = { nodes: [node('a', 1), node('b', 2)], edges: [edge('a', 'b')], omittedEdges: 0 };
    expect(layoutChangeMap(map)).toEqual(layoutChangeMap(map));
  });
});
