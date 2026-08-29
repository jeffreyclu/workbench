import { memo, useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Network } from 'lucide-react';
import { CHANGE_RELATIONS, CHANGE_RELATION_LABELS, type ChangeMap, type ChangeRelation } from '../../../shared/change-map.js';
import { CHANGE_MAP_NODE_HEIGHT, CHANGE_MAP_NODE_WIDTH, layoutChangeMap } from './change-map-layout.js';
import { selectChangeConnections, selectFocusedChangeMap, type ChangeMapConnection } from './change-map-logic.js';

const CHANGE_PATH_PREVIEW_LIMIT = 3;
const CHANGE_MAP_FOCUS_LIMIT = 4;

/** The diagram answers one question the queue cannot: which of these changes
 * exist because of another one. It reads left to right — a cause sits left of
 * everything that moved for it — and shares its selection with the queue and
 * the diff pane, so clicking a node is the same act as clicking its decision.
 *
 * Backticks in edge explanations come from the shared builder, which writes
 * them for prose contexts. Here the text is already monospace, so they are
 * stripped rather than rendered as literal characters. */
function plainText(explanation: string): string {
  return explanation.replace(/`/g, '');
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function fileTail(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length <= 2 ? filePath : `…/${parts.slice(-2).join('/')}`;
}

export const DiffReviewChangeMap = memo(function DiffReviewChangeMap({ map, selectedId, onSelect }: {
  map: ChangeMap;
  selectedId: string | null;
  onSelect: (decisionId: string) => void;
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
        <span>Change map</span>
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
          {layout.edges.map((edge) => {
            const active = edge.id === selectedEdgeId;
            const touchesSelection = edge.fromId === selectedId || edge.toId === selectedId;
            return <g key={edge.id} className={`change-map-edge relation-${edge.relation}${active ? ' active' : ''}${touchesSelection ? ' touches-selection' : ''}${edge.backward ? ' backward' : ''}`}>
              <path className="change-map-edge-line" d={edge.path} markerEnd={`url(#change-map-arrow-${edge.relation})`} />
              <path
                className="change-map-edge-target"
                d={edge.path}
                role="button"
                tabIndex={0}
                aria-label={`${CHANGE_RELATION_LABELS[edge.relation]}: ${plainText(edge.explanation)}`}
                onClick={() => setSelectedEdgeId(active ? null : edge.id)}
                onKeyDown={(event) => activate(event, () => setSelectedEdgeId(active ? null : edge.id))}
              />
              {(active || touchesSelection) && <text className="change-map-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">{CHANGE_RELATION_LABELS[edge.relation]}</text>}
            </g>;
          })}
          {layout.nodes.map((node) => {
            const isSelected = node.id === selectedId;
            const dimmed = Boolean(selectedId) && !isSelected && connectedIds.size > 0 && !connectedIds.has(node.id);
            return <g
              key={node.id}
              className={`change-map-node state-${node.state ?? 'pending'}${isSelected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}${node.degree === 0 ? ' isolated' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`Decision ${node.ordinal}: ${node.behavior} ${node.degree === 0 ? 'No related changes.' : `${node.degree} related ${node.degree === 1 ? 'change' : 'changes'}.`}`}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => activate(event, () => onSelect(node.id))}
            >
              <rect className="change-map-node-body" x={node.x} y={node.y} width={CHANGE_MAP_NODE_WIDTH} height={CHANGE_MAP_NODE_HEIGHT} rx="7" />
              <rect className="change-map-node-rail" x={node.x} y={node.y} width="3" height={CHANGE_MAP_NODE_HEIGHT} rx="1.5" />
              <text className="change-map-node-title" x={node.x + 13} y={node.y + 23}>{node.ordinal}. {truncate(node.label, 20)}</text>
              <text className="change-map-node-file" x={node.x + 13} y={node.y + 39}>{truncate(fileTail(node.filePath), 26)}</text>
              <text className="change-map-node-counts" x={node.x + 13} y={node.y + 53}>+{node.additions} / -{node.deletions}{node.fileCount > 1 ? ` · ${node.fileCount} files` : ''}</text>
            </g>;
          })}
        </svg>
      </div>
      <p className="change-map-explanation" role="status">
        {selectedEdge
          ? plainText(selectedEdge.explanation)
          : layout.edges.length === 0
            ? 'Nothing in this diff references anything else in it. Each change stands alone.'
            : 'Select a line to read why two changes are related, or a box to open that decision.'}
      </p>
      {relationsPresent.length > 0 && <ul className="change-map-legend" aria-label="Relationship types">
        {relationsPresent.map((relation: ChangeRelation) => <li key={relation} className={`relation-${relation}`}><span aria-hidden="true" />{CHANGE_RELATION_LABELS[relation]}</li>)}
      </ul>}
      {map.omittedEdges > 0 && <p className="muted change-map-omitted">{map.omittedEdges} weaker relationships are not drawn; this diff exceeds the map limit.</p>}
    </>}
  </section>;
});

/** Keeps the selected hunk's immediate code path attached to the code pane.
 * The full map remains useful as an overview, but review happens one decision
 * at a time; this focused path exposes the same graph without making the
 * reviewer scroll away from the code they are reading. */
export const DiffReviewChangePath = memo(function DiffReviewChangePath({ map, selectedId, onSelect }: {
  map: ChangeMap;
  selectedId: string;
  onSelect: (decisionId: string) => void;
}) {
  const [expandedForSelection, setExpandedForSelection] = useState<string | null>(null);
  const { selected: selectedNode, upstream, downstream } = useMemo(() => selectChangeConnections(map, selectedId), [map, selectedId]);
  if (!selectedNode || map.nodes.length < 2) return null;

  const expanded = expandedForSelection === selectedId;
  const totalConnections = upstream.length + downstream.length;
  const hiddenConnections = Math.max(0, upstream.length - CHANGE_PATH_PREVIEW_LIMIT)
    + Math.max(0, downstream.length - CHANGE_PATH_PREVIEW_LIMIT);
  const visibleUpstream = expanded ? upstream : upstream.slice(0, CHANGE_PATH_PREVIEW_LIMIT);
  const visibleDownstream = expanded ? downstream : downstream.slice(0, CHANGE_PATH_PREVIEW_LIMIT);

  return <nav className="change-path" aria-label="Related code changes">
    <header className="change-path-current">
      <Network size={13} aria-hidden="true" />
      <span>Change {selectedNode.ordinal}</span>
      <code>{truncate(selectedNode.label, 28)}</code>
      {hiddenConnections > 0 && <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpandedForSelection(expanded ? null : selectedId)}
      >{expanded ? 'Show fewer' : `Show all ${totalConnections}`}</button>}
    </header>
    {totalConnections === 0
      ? <small>No direct relationships in this diff</small>
      : <div className={`change-path-groups${expanded ? ' expanded' : ''}`}>
        {upstream.length > 0 && <ChangePathGroup direction="upstream" connections={visibleUpstream} total={upstream.length} onSelect={onSelect} />}
        {downstream.length > 0 && <ChangePathGroup direction="downstream" connections={visibleDownstream} total={downstream.length} onSelect={onSelect} />}
      </div>}
  </nav>;
});

const ChangePathGroup = memo(function ChangePathGroup({ direction, connections, total, onSelect }: {
  direction: 'upstream' | 'downstream';
  connections: ChangeMapConnection[];
  total: number;
  onSelect: (decisionId: string) => void;
}) {
  const upstream = direction === 'upstream';
  return <section className="change-path-group" aria-label={`${total} ${direction} ${total === 1 ? 'change' : 'changes'}`}>
    <header>
      {upstream ? <ArrowLeft size={12} aria-hidden="true" /> : <ArrowRight size={12} aria-hidden="true" />}
      <span>{direction}</span><small>{total}</small>
    </header>
    <ol>
      {connections.map(({ edge, related }) => <li key={edge.id} className={`relation-${edge.relation}`}>
        <button type="button" onClick={() => onSelect(related.id)} aria-label={`Jump to decision ${related.ordinal}: ${plainText(edge.explanation)}`}>
          <b>{related.ordinal}. {truncate(related.label, 26)}</b>
          <small>{CHANGE_RELATION_LABELS[edge.relation]} · {truncate(fileTail(related.filePath), 30)}</small>
        </button>
      </li>)}
    </ol>
  </section>;
});
