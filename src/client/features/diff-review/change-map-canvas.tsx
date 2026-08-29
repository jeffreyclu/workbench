import { memo, type KeyboardEvent } from 'react';
import { CHANGE_RELATIONS, CHANGE_RELATION_LABELS, type ChangeRelation } from '../../../shared/change-map.js';
import { CHANGE_MAP_NODE_HEIGHT, CHANGE_MAP_NODE_WIDTH, type ChangeMapLayout } from './change-map-layout.js';
import { plainRelationText } from './change-map-logic.js';
import type { DecisionPopoverAnchor } from './decision-popover.js';

/** The drawing itself, shared by the whole-diff diagram and the per-decision
 * diagram beside an open decision panel. Both surfaces must read as the same
 * picture — same boxes, same arrows, same selection semantics — so the markup
 * lives in one place and the callers only decide which subgraph to hand it. */

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function fileTail(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length <= 2 ? filePath : `…/${parts.slice(-2).join('/')}`;
}

export const ChangeMapCanvas = memo(function ChangeMapCanvas({ layout, selectedId, cameFromId, riskBands, openDetailFor, selectedEdgeId, label = 'Change map diagram', nodeAttribute = 'data-change-map-node', onSelect, onOpenDetail, onSelectEdge }: {
  layout: ChangeMapLayout;
  selectedId: string | null;
  /** The change the reviewer was on before following a relationship here, so
   * the diagram shows the trail back rather than only where they landed. */
  cameFromId?: string | null;
  riskBands?: Map<string, string>;
  openDetailFor?: string | null;
  selectedEdgeId: string | null;
  label?: string;
  /** The handle an open decision panel re-finds this node by. Every surface
   * that draws the map needs its own handle: two elements answering to the
   * same one would let a panel re-anchor to the wrong drawing. */
  nodeAttribute?: string;
  onSelect: (decisionId: string) => void;
  onOpenDetail?: (decisionId: string, anchor: DecisionPopoverAnchor) => void;
  onSelectEdge: (edgeId: string | null) => void;
}) {
  const connectedIds = new Set(layout.edges
    .filter((edge) => edge.fromId === selectedId || edge.toId === selectedId)
    .flatMap((edge) => [edge.fromId, edge.toId]));

  // Lines that answer the current selection are painted last, so they sit on
  // top of the ones the reviewer is not asking about rather than under them.
  const orderedEdges = [...layout.edges].sort((left, right) =>
    Number(left.fromId === selectedId || left.toId === selectedId) - Number(right.fromId === selectedId || right.toId === selectedId));

  const activate = (event: KeyboardEvent, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };

  return <div className="change-map-canvas" role="group" aria-label={label} tabIndex={0}>
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
            aria-label={`${CHANGE_RELATION_LABELS[edge.relation as ChangeRelation]}: ${plainRelationText(edge.explanation)}`}
            onClick={() => onSelectEdge(active ? null : edge.id)}
            onKeyDown={(event) => activate(event, () => onSelectEdge(active ? null : edge.id))}
          />
          {(active || touchesSelection) && <text className="change-map-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">{CHANGE_RELATION_LABELS[edge.relation as ChangeRelation]}</text>}
        </g>;
      })}
      {layout.nodes.map((node) => {
        const isSelected = node.id === selectedId;
        const cameFrom = !isSelected && node.id === cameFromId;
        // A recorded state is the reviewer's own mark on this change: whatever
        // they decided, they have already read it.
        const reviewed = node.state !== null;
        const dimmed = Boolean(selectedId) && !isSelected && connectedIds.size > 0 && !connectedIds.has(node.id);
        const band = riskBands?.get(node.id) ?? null;
        const openDetail = (anchor: DecisionPopoverAnchor) => {
          onSelect(node.id);
          onOpenDetail?.(node.id, anchor);
        };
        return <g
          key={node.id}
          className={`change-map-node state-${node.state ?? 'pending'}${isSelected ? ' selected' : ''}${cameFrom ? ' came-from' : ''}${reviewed ? ' reviewed' : ''}${dimmed ? ' dimmed' : ''}${node.degree === 0 ? ' isolated' : ''}`}
          role="button"
          tabIndex={0}
          aria-pressed={isSelected}
          // A stable handle on the node, so an open popover can re-find it
          // after selecting reflows the diagram into focus mode.
          {...{ [nodeAttribute]: node.id }}
          aria-haspopup={onOpenDetail ? 'dialog' : undefined}
          aria-expanded={onOpenDetail ? openDetailFor === node.id : undefined}
          aria-label={`Decision ${node.ordinal}: ${node.behavior} ${node.degree === 0 ? 'No related changes.' : `${node.degree} related ${node.degree === 1 ? 'change' : 'changes'}.`}${cameFrom ? ' Came from here.' : ''}${reviewed ? ' Already reviewed.' : ''}${band ? ` ${band} risk.` : ''}${onOpenDetail ? ' Open decision details.' : ''}`}
          onClick={(event) => openDetail(event.currentTarget)}
          onKeyDown={(event) => activate(event, () => openDetail(event.currentTarget))}
        >
          <rect className="change-map-node-body" x={node.x} y={node.y} width={CHANGE_MAP_NODE_WIDTH} height={CHANGE_MAP_NODE_HEIGHT} rx="7" />
          <rect className="change-map-node-rail" x={node.x} y={node.y} width="3" height={CHANGE_MAP_NODE_HEIGHT} rx="1.5" />
          <text className="change-map-node-title" x={node.x + 13} y={node.y + 23}>{node.ordinal}. {truncate(node.label, 20)}</text>
          <text className="change-map-node-file" x={node.x + 13} y={node.y + 39}>{truncate(fileTail(node.filePath), 26)}</text>
          <text className="change-map-node-counts" x={node.x + 13} y={node.y + 53}>+{node.additions} / -{node.deletions}{node.fileCount > 1 ? ` · ${node.fileCount} files` : ''}</text>
          {cameFrom && <text className="change-map-node-trail" x={node.x + CHANGE_MAP_NODE_WIDTH - 9} y={node.y + CHANGE_MAP_NODE_HEIGHT - 8} textAnchor="end">came from</text>}
          {band && <circle className={`change-map-node-risk-dot band-${band}`} cx={node.x + CHANGE_MAP_NODE_WIDTH - 9} cy={node.y + 9} r="3.5" />}
        </g>;
      })}
    </svg>
  </div>;
});
