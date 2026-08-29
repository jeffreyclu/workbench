import {
  CHANGE_RELATIONS,
  type ChangeMap,
  type ChangeMapEdge,
  type ChangeMapNode,
} from '../../../shared/change-map.js';

export interface ChangeMapConnection {
  edge: ChangeMapEdge;
  related: ChangeMapNode;
  direction: 'upstream' | 'downstream';
}

export interface SelectedChangeConnections {
  selected: ChangeMapNode | null;
  upstream: ChangeMapConnection[];
  downstream: ChangeMapConnection[];
}

const relationOrder = new Map(CHANGE_RELATIONS.map((relation, index) => [relation, index]));

/** Direct relationships are the useful unit while reading one hunk. Strong
 * semantic links come first, then source order keeps the result stable when
 * several call sites have the same relationship. */
export function selectChangeConnections(map: ChangeMap, selectedId: string): SelectedChangeConnections {
  const selected = map.nodes.find((node) => node.id === selectedId) ?? null;
  const nodesById = new Map(map.nodes.map((node) => [node.id, node]));
  const connections = map.edges.flatMap((edge): ChangeMapConnection[] => {
    if (edge.fromId !== selectedId && edge.toId !== selectedId) return [];
    const direction = edge.fromId === selectedId ? 'downstream' : 'upstream';
    const related = nodesById.get(direction === 'downstream' ? edge.toId : edge.fromId);
    return related ? [{ edge, related, direction }] : [];
  });
  const ordered = connections.sort((left, right) =>
    (relationOrder.get(left.edge.relation) ?? CHANGE_RELATIONS.length) - (relationOrder.get(right.edge.relation) ?? CHANGE_RELATIONS.length)
    || left.related.ordinal - right.related.ordinal);

  return {
    selected,
    upstream: ordered.filter((connection) => connection.direction === 'upstream'),
    downstream: ordered.filter((connection) => connection.direction === 'downstream'),
  };
}

export interface FocusedChangeMap {
  map: ChangeMap;
  visibleConnections: number;
  hiddenConnections: number;
}

/** A complete large-diff graph is still available, but its default view is a
 * bounded neighborhood around the selected change. Only edges touching the
 * selected node are kept: drawing incidental links between its neighbors
 * recreates the hairball this focus mode is meant to remove. */
export function selectFocusedChangeMap(map: ChangeMap, selectedId: string, perDirectionLimit: number): FocusedChangeMap {
  const { selected, upstream, downstream } = selectChangeConnections(map, selectedId);
  if (!selected) return { map, visibleConnections: map.edges.length, hiddenConnections: 0 };

  const visible = [...upstream.slice(0, perDirectionLimit), ...downstream.slice(0, perDirectionLimit)];
  const visibleIds = new Set([selected.id, ...visible.map((connection) => connection.related.id)]);
  const visibleEdgeIds = new Set(visible.map((connection) => connection.edge.id));
  return {
    map: {
      nodes: map.nodes.filter((node) => visibleIds.has(node.id)),
      edges: map.edges.filter((edge) => visibleEdgeIds.has(edge.id)),
      omittedEdges: map.omittedEdges,
    },
    visibleConnections: visible.length,
    hiddenConnections: upstream.length + downstream.length - visible.length,
  };
}
