import {
  CHANGE_RELATIONS,
  type ChangeMap,
  type ChangeMapEdge,
  type ChangeMapNode,
  type ChangeRelation,
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

export interface ChangeLink {
  /** The decision at the other end of the relationship. */
  decisionId: string;
  ordinal: number;
  label: string;
  filePath: string;
  relation: ChangeRelation;
  explanation: string;
}

export interface ChangeLinkSummary {
  total: number;
  /** Changes this one exists because of. */
  upstream: ChangeLink[];
  /** Changes that moved because of this one. */
  downstream: ChangeLink[];
  /** Relationship counts, strongest first, for the one-line lens. */
  byRelation: { relation: ChangeRelation; count: number }[];
  /** Colours the gutter marker and the lens; the strongest relation is the one
   * worth a reviewer's attention when a change has several. */
  topRelation: ChangeRelation;
}

/** Backticks come from the shared builder, which writes them for prose. The
 * lens and peek panel are already monospace, so they are stripped rather than
 * rendered as literal characters. */
export function plainRelationText(explanation: string): string {
  return explanation.replace(/`/g, '');
}

/** Relationships indexed by decision, so the diff pane can answer "what else
 * moved with this hunk?" without walking every edge per block. Built once per
 * map: a linear pass beats calling `selectChangeConnections` for every node. */
export function buildChangeLinkIndex(map: ChangeMap): Map<string, ChangeLinkSummary> {
  const nodesById = new Map(map.nodes.map((node) => [node.id, node]));
  const upstream = new Map<string, ChangeLink[]>();
  const downstream = new Map<string, ChangeLink[]>();

  const push = (bucket: Map<string, ChangeLink[]>, ownerId: string, relatedId: string, edge: ChangeMapEdge) => {
    const related = nodesById.get(relatedId);
    if (!related) return;
    const links = bucket.get(ownerId) ?? [];
    links.push({
      decisionId: related.id,
      ordinal: related.ordinal,
      label: related.label,
      filePath: related.filePath,
      relation: edge.relation,
      explanation: edge.explanation,
    });
    bucket.set(ownerId, links);
  };

  for (const edge of map.edges) {
    push(downstream, edge.fromId, edge.toId, edge);
    push(upstream, edge.toId, edge.fromId, edge);
  }

  const byStrength = (left: ChangeLink, right: ChangeLink) =>
    (relationOrder.get(left.relation) ?? CHANGE_RELATIONS.length) - (relationOrder.get(right.relation) ?? CHANGE_RELATIONS.length)
    || left.ordinal - right.ordinal;

  const index = new Map<string, ChangeLinkSummary>();
  for (const node of map.nodes) {
    const up = (upstream.get(node.id) ?? []).sort(byStrength);
    const down = (downstream.get(node.id) ?? []).sort(byStrength);
    if (up.length === 0 && down.length === 0) continue;

    const counts = new Map<ChangeRelation, number>();
    for (const link of [...up, ...down]) counts.set(link.relation, (counts.get(link.relation) ?? 0) + 1);
    const byRelation = CHANGE_RELATIONS
      .filter((relation) => counts.has(relation))
      .map((relation) => ({ relation, count: counts.get(relation) ?? 0 }));

    index.set(node.id, {
      total: up.length + down.length,
      upstream: up,
      downstream: down,
      byRelation,
      topRelation: byRelation[0].relation,
    });
  }
  return index;
}
