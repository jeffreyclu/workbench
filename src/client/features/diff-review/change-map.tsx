import { memo, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Network } from 'lucide-react';
import { CHANGE_RELATIONS, CHANGE_RELATION_LABELS, type ChangeMap, type ChangeRelation } from '../../../shared/change-map.js';
import { CHANGE_MAP_NODE_HEIGHT, CHANGE_MAP_NODE_WIDTH, layoutChangeMap } from './change-map-layout.js';
import { plainRelationText, selectFocusedChangeMap } from './change-map-logic.js';
import type { DecisionPopoverAnchor } from './decision-popover.js';

const CHANGE_MAP_FOCUS_LIMIT = 4;

/** The diagram answers one question the queue cannot: which of these changes
 * exist because of another one. It reads left to right — a cause sits left of
 * everything that moved for it — and shares its selection with the queue and
 * the diff pane, so clicking a node is the same act as clicking its decision.
 *
 * Relationships now read primarily as inline links inside the diff itself; the
 * diagram stays as the opt-in whole-diff view for wide refactors. */

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function fileTail(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length <= 2 ? filePath : `…/${parts.slice(-2).join('/')}`;
}

export const DiffReviewChangeMap = memo(function DiffReviewChangeMap({ map, selectedId, riskBands, openDetailFor, onSelect, onOpenDetail }: {
  map: ChangeMap;
  selectedId: string | null;
  /** Scored risk band per decision, the same map the gutter dot reads, so a
   * node carries its AI score without being opened. */
  riskBands?: Map<string, string>;
  openDetailFor?: string | null;
  onSelect: (decisionId: string) => void;
  /** Opens the decision detail — score and AI assist — anchored to the node.
   * The diagram is a review surface, not an index: a node must reach the same
   * panel its gutter marker does. */
  onOpenDetail?: (decisionId: string, anchor: DecisionPopoverAnchor) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [fullMapForSelection, setFullMapForSelection] = useState<string | null>(null);
  const focused = useMemo(() => selectedId
    ? selectFocusedChangeMap(map, selectedId, CHANGE_MAP_FOCUS_LIMIT)
    : { map, visibleConnections: map.edges.length, hiddenConnections: 0 }, [map, selectedId]);
  const showingAll = Boolean(selectedId) && fullMapForSelection === selectedId;
  const visibleMap = showingAll ? map : focused.map;
  const layout = useMemo(() => layoutChangeMap(visibleMap), [visibleMap]);

  // One change has nothing to relate to, and a map of it would only take space
  // away from the diff.
  if (map.nodes.length < 2) return null;

  const selectedEdge = layout.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const connectedIds = new Set(layout.edges
    .filter((edge) => edge.fromId === selectedId || edge.toId === selectedId)
    .flatMap((edge) => [edge.fromId, edge.toId]));
  const relationsPresent = CHANGE_RELATIONS.filter((relation) => layout.edges.some((edge) => edge.relation === relation));
  const relatedCount = layout.nodes.filter((node) => node.degree > 0).length;

  // Lines that answer the current selection are painted last, so they sit on
  // top of the ones the reviewer is not asking about rather than under them.
  const orderedEdges = [...layout.edges].sort((left, right) =>
    Number(left.fromId === selectedId || left.toId === selectedId) - Number(right.fromId === selectedId || right.toId === selectedId));

  const activate = (event: KeyboardEvent, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };

  return <section className="diff-review-change-map" aria-label="Change relationship map">
    <header>
      <button type="button" className="change-map-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <Network size={14} aria-hidden="true" />
        <span>Full change diagram</span>
        <small>{layout.edges.length === 0
          ? 'No relationships found between these changes'
          : `${layout.edges.length} ${layout.edges.length === 1 ? 'relationship' : 'relationships'} across ${relatedCount} of ${layout.nodes.length} changes`}</small>
      </button>
    </header>
    {open && <>
      {selectedId && <div className="change-map-scope">
        <span>{showingAll
          ? `All ${map.nodes.length} changes`
          : `Focused on change ${map.nodes.find((node) => node.id === selectedId)?.ordinal ?? ''} · ${focused.visibleConnections} direct ${focused.visibleConnections === 1 ? 'relationship' : 'relationships'}`}</span>
        {(focused.hiddenConnections > 0 || showingAll || focused.map.nodes.length < map.nodes.length) && <button type="button" onClick={() => setFullMapForSelection(showingAll ? null : selectedId)}>
          {showingAll ? 'Focus on current change' : `Show all ${map.nodes.length} changes`}
        </button>}
      </div>}
      <div className="change-map-canvas" role="group" aria-label="Change map diagram" tabIndex={0}>
        <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
          <defs>
            {CHANGE_RELATIONS.map((relation) => <marker key={relation} id={`change-map-arrow-${relation}`} className={`change-map-arrow relation-${relation}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 8 4 L 0 7 z" />
            </marker>)}
          </defs>
          {orderedEdges.map((edge) => {
            const active = edge.id === selectedEdgeId;
            const touchesSelection = edge.fromId === selectedId || edge.toId === selectedId;
            const dimmed = Boolean(selectedId) && !touchesSelection && !active;
            return <g key={edge.id} className={`change-map-edge relation-${edge.relation}${active ? ' active' : ''}${touchesSelection ? ' touches-selection' : ''}${dimmed ? ' dimmed' : ''}${edge.backward ? ' backward' : ''}`}>
              <path className="change-map-edge-line" d={edge.path} markerEnd={`url(#change-map-arrow-${edge.relation})`} />
              <path
                className="change-map-edge-target"
                d={edge.path}
                role="button"
                tabIndex={0}
                aria-label={`${CHANGE_RELATION_LABELS[edge.relation]}: ${plainRelationText(edge.explanation)}`}
                onClick={() => setSelectedEdgeId(active ? null : edge.id)}
                onKeyDown={(event) => activate(event, () => setSelectedEdgeId(active ? null : edge.id))}
              />
              {(active || touchesSelection) && <text className="change-map-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">{CHANGE_RELATION_LABELS[edge.relation]}</text>}
            </g>;
          })}
          {layout.nodes.map((node) => {
            const isSelected = node.id === selectedId;
            const dimmed = Boolean(selectedId) && !isSelected && connectedIds.size > 0 && !connectedIds.has(node.id);
            const band = riskBands?.get(node.id) ?? null;
            const openDetail = (anchor: DecisionPopoverAnchor) => {
              onSelect(node.id);
              onOpenDetail?.(node.id, anchor);
            };
            return <g
              key={node.id}
              className={`change-map-node state-${node.state ?? 'pending'}${isSelected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}${node.degree === 0 ? ' isolated' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              // A stable handle on the node, so an open popover can re-find it
              // after selecting reflows the diagram into focus mode.
              data-change-map-node={node.id}
              aria-haspopup={onOpenDetail ? 'dialog' : undefined}
              aria-expanded={onOpenDetail ? openDetailFor === node.id : undefined}
              aria-label={`Decision ${node.ordinal}: ${node.behavior} ${node.degree === 0 ? 'No related changes.' : `${node.degree} related ${node.degree === 1 ? 'change' : 'changes'}.`}${band ? ` ${band} risk.` : ''}${onOpenDetail ? ' Open decision details.' : ''}`}
              onClick={(event) => openDetail(event.currentTarget)}
              onKeyDown={(event) => activate(event, () => openDetail(event.currentTarget))}
            >
              <rect className="change-map-node-body" x={node.x} y={node.y} width={CHANGE_MAP_NODE_WIDTH} height={CHANGE_MAP_NODE_HEIGHT} rx="7" />
              <rect className="change-map-node-rail" x={node.x} y={node.y} width="3" height={CHANGE_MAP_NODE_HEIGHT} rx="1.5" />
              <text className="change-map-node-title" x={node.x + 13} y={node.y + 23}>{node.ordinal}. {truncate(node.label, 20)}</text>
              <text className="change-map-node-file" x={node.x + 13} y={node.y + 39}>{truncate(fileTail(node.filePath), 26)}</text>
              <text className="change-map-node-counts" x={node.x + 13} y={node.y + 53}>+{node.additions} / -{node.deletions}{node.fileCount > 1 ? ` · ${node.fileCount} files` : ''}</text>
              {band && <circle className={`change-map-node-risk-dot band-${band}`} cx={node.x + CHANGE_MAP_NODE_WIDTH - 9} cy={node.y + 9} r="3.5" />}
            </g>;
          })}
        </svg>
      </div>
      <p className="change-map-explanation" role="status">
        {selectedEdge
          ? plainRelationText(selectedEdge.explanation)
          : layout.edges.length === 0
            ? 'Nothing in this diff references anything else in it. Each change stands alone.'
            : 'Select a line to read why two changes are related, or a box to open that decision — risk score and AI assist included.'}
      </p>
      {relationsPresent.length > 0 && <ul className="change-map-legend" aria-label="Relationship types">
        {relationsPresent.map((relation: ChangeRelation) => <li key={relation} className={`relation-${relation}`}><span aria-hidden="true" />{CHANGE_RELATION_LABELS[relation]}</li>)}
      </ul>}
      {map.omittedEdges > 0 && <p className="muted change-map-omitted">{map.omittedEdges} weaker relationships are not drawn; this diff exceeds the map limit.</p>}
    </>}
  </section>;
});
