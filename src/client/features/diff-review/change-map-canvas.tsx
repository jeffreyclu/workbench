import { memo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { CHANGE_RELATIONS, changeEdgeLabel, type ChangeMapNode, changeEdgeContinuity } from '../../../shared/change-map.js';
import { type ChangeMapLayout } from './change-map-layout.js';
import { plainRelationText } from './change-map-logic.js';
import type { DecisionPopoverAnchor } from './decision-popover.js';

const ALWAYS_LABEL_EDGES = 8;
const TITLE_LINES = 3;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.2;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function wrapLabel(text: string, limit: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === '') {
      current = truncate(word, limit);
      continue;
    }
    const next = `${current} ${word}`;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    if (lines.length === maxLines - 1) {
      current = truncate(next, limit);
      break;
    }
    lines.push(current);
    current = truncate(word, limit);
  }
  if (current !== '') lines.push(current);
  return lines;
}

function markSymbol(symbol: ChangeMapNode['symbols'][number]): string {
  if (symbol.change === 'added') return `+${symbol.name}`;
  if (symbol.change === 'removed') return `−${symbol.name}`;
  return symbol.name;
}

function symbolLine(symbols: ChangeMapNode['symbols'], limit: number): string | null {
  if (symbols.length === 0) return null;
  const marked = symbols.map(markSymbol);
  let text = '';
  let shown = 0;
  for (const mark of marked) {
    const next = shown === 0 ? mark : `${text} ${mark}`;
    if (next.length > limit) break;
    text = next;
    shown += 1;
  }
  if (shown === 0) return truncate(marked[0], limit);
  return shown < marked.length ? `${text} +${marked.length - shown}` : text;
}

function nodeContext(node: ChangeMapNode): string {
  const files = node.filePaths.length > 0 ? ` Files: ${node.filePaths.join(', ')}.` : '';
  const symbols = node.symbols.length > 0 ? ` Declares: ${node.symbols.map(markSymbol).join(', ')}.` : '';
  return `${files}${symbols}`;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

export const ChangeMapCanvas = memo(function ChangeMapCanvas({ layout, selectedId, cameFromId, riskBands, openDetailFor, selectedEdgeId, label = 'Change map diagram', nodeAttribute = 'data-change-map-node', onSelect, onOpenDetail, onSelectEdge }: {
  layout: ChangeMapLayout;
  selectedId: string | null;
  cameFromId?: string | null;
  riskBands?: Map<string, string>;
  openDetailFor?: string | null;
  selectedEdgeId: string | null;
  label?: string;
  nodeAttribute?: string;
  onSelect: (decisionId: string) => void;
  onOpenDetail?: (decisionId: string, anchor: DecisionPopoverAnchor) => void;
  onSelectEdge: (edgeId: string | null) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const connectedIds = new Set(layout.edges
    .filter((edge) => edge.fromId === selectedId || edge.toId === selectedId)
    .flatMap((edge) => [edge.fromId, edge.toId]));
  const orderedEdges = [...layout.edges].sort((left, right) =>
    Number(left.fromId === selectedId || left.toId === selectedId) - Number(right.fromId === selectedId || right.toId === selectedId));

  const activate = (event: KeyboardEvent, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };
  const fit = () => {
    const available = viewportRef.current?.clientWidth ?? layout.width;
    setZoom(clampZoom((available - 8) / layout.width));
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  };
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom((current) => clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
  };
  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('.change-map-node, .change-map-edge-target')) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    panStart.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    setPanning(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const start = panStart.current;
    const viewport = viewportRef.current;
    if (!start || !viewport) return;
    viewport.scrollLeft = start.left - (event.clientX - start.x);
    viewport.scrollTop = start.top - (event.clientY - start.y);
  };
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (!panStart.current) return;
    panStart.current = null;
    viewportRef.current?.releasePointerCapture(event.pointerId);
    setPanning(false);
  };

  return <div className={`change-map-canvas${layout.edges.length <= ALWAYS_LABEL_EDGES ? ' labelled' : ''}`} role="group" aria-label={label}>
    <div className="change-map-toolbar" role="toolbar" aria-label="Canvas zoom controls">
      <button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((current) => clampZoom(current - ZOOM_STEP))}><Minus size={13} /></button>
      <output aria-live="polite">{Math.round(zoom * 100)}%</output>
      <button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((current) => clampZoom(current + ZOOM_STEP))}><Plus size={13} /></button>
      <button type="button" aria-label="Fit diagram" onClick={fit}><Maximize2 size={12} /> Fit</button>
    </div>
    <div className={`change-map-viewport${panning ? ' is-panning' : ''}`} ref={viewportRef} tabIndex={0} onWheel={handleWheel} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
      <svg width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-label={`${label}. ${layout.packages.length} packages and ${layout.folders.length} folders.`}>
        <defs>
          {CHANGE_RELATIONS.map((relation) => <marker key={relation} id={`change-map-arrow-${relation}`} className={`change-map-arrow relation-${relation}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 8 4 L 0 7 z" /></marker>)}
        </defs>
        {layout.packages.map((item) => <g key={item.id} className="change-map-package" aria-hidden="true">
          <rect x={item.x} y={item.y} width={item.width} height={item.height} rx="14" />
          <text x={item.x + 14} y={item.y + 20}>{item.label}<tspan dx="9">{item.folderCount} {item.folderCount === 1 ? 'folder' : 'folders'}</tspan></text>
        </g>)}
        {layout.folders.map((item) => <g key={item.id} className={`change-map-folder${layout.nodes.find((node) => node.id === selectedId)?.folderId === item.label && layout.nodes.find((node) => node.id === selectedId)?.packageId === item.packageId ? ' selected' : ''}`} aria-hidden="true">
          <rect x={item.x} y={item.y} width={item.width} height={item.height} rx="10" />
          <text x={item.x + 11} y={item.y + 17}>{item.label}<tspan dx="8">{item.nodeCount} {item.nodeCount === 1 ? 'block' : 'blocks'}</tspan></text>
        </g>)}
        {orderedEdges.map((edge) => {
          const active = edge.id === selectedEdgeId;
          const touchesSelection = edge.fromId === selectedId || edge.toId === selectedId;
          const dimmed = Boolean(selectedId) && !touchesSelection && !active;
          return <g key={edge.id} className={`change-map-edge relation-${edge.relation} ${changeEdgeContinuity(edge)}${active ? ' active' : ''}${touchesSelection ? ' touches-selection' : ''}${dimmed ? ' dimmed' : ''}${edge.crossesFolder ? ' crosses-folder' : ''}${edge.crossesPackage ? ' crosses-package' : ''}`}>
            <path className="change-map-edge-line" d={edge.path} markerEnd={`url(#change-map-arrow-${edge.relation})`} />
            <path className="change-map-edge-target" d={edge.path} role="button" tabIndex={0} aria-label={`${changeEdgeLabel(edge)}: ${plainRelationText(edge.explanation)}`} onClick={() => onSelectEdge(active ? null : edge.id)} onKeyDown={(event) => activate(event, () => onSelectEdge(active ? null : edge.id))} />
            <text className="change-map-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">{changeEdgeLabel(edge)}</text>
          </g>;
        })}
        {layout.nodes.map((node) => {
          const isSelected = node.id === selectedId;
          const cameFrom = !isSelected && node.id === cameFromId;
          const reviewed = node.state !== null;
          const dimmed = Boolean(selectedId) && !isSelected && connectedIds.size > 0 && !connectedIds.has(node.id);
          const band = riskBands?.get(node.id) ?? null;
          const titleLines = wrapLabel(`${node.ordinal}. ${node.label}`, Math.max(16, Math.floor((node.width - 28) / 7.2)), TITLE_LINES);
          const symbols = symbolLine(node.symbols, Math.max(18, Math.floor((node.width - 28) / 6.4)));
          const titleBottom = 24 + titleLines.length * 17;
          const openDetail = (anchor: DecisionPopoverAnchor) => { onSelect(node.id); onOpenDetail?.(node.id, anchor); };
          return <g key={node.id} className={`change-map-node category-${node.category} state-${node.state ?? 'pending'}${isSelected ? ' selected' : ''}${cameFrom ? ' came-from' : ''}${reviewed ? ' reviewed' : ''}${dimmed ? ' dimmed' : ''}${node.degree === 0 ? ' isolated' : ''}`} role="button" tabIndex={0} aria-pressed={isSelected} {...{ [nodeAttribute]: node.id }} aria-haspopup={onOpenDetail ? 'dialog' : undefined} aria-expanded={onOpenDetail ? openDetailFor === node.id : undefined} aria-label={`Decision ${node.ordinal}: ${node.behavior}${nodeContext(node)} ${node.additions + node.deletions} changed lines. ${node.category} code. ${node.degree === 0 ? 'No related changes.' : `${node.degree} related ${node.degree === 1 ? 'change' : 'changes'}.`}${cameFrom ? ' Came from here.' : ''}${reviewed ? ' Already reviewed.' : ''}${band ? ` ${band} risk.` : ''}${onOpenDetail ? ' Open decision details.' : ''}`} onClick={(event) => openDetail(event.currentTarget)} onKeyDown={(event) => activate(event, () => openDetail(event.currentTarget))}>
            <rect className="change-map-node-body" x={node.x} y={node.y} width={node.width} height={node.height} rx="9" />
            <rect className="change-map-node-rail" x={node.x} y={node.y} width="4" height={node.height} rx="2" />
            {titleLines.map((line, index) => <text key={index} className="change-map-node-title" x={node.x + 14} y={node.y + 24 + index * 17}>{line}</text>)}
            {symbols && <text className="change-map-node-symbols" x={node.x + 14} y={node.y + titleBottom + 4}>{symbols}</text>}
            <text className="change-map-node-counts" x={node.x + 14} y={node.y + titleBottom + (symbols ? 23 : 4)}><tspan className="added">+{node.additions}</tspan><tspan className="removed" dx="7">−{node.deletions}</tspan>{node.fileCount > 1 && <tspan className="spans" dx="8">· {node.fileCount} files</tspan>}</text>
            {cameFrom && <text className="change-map-node-trail" x={node.x + node.width - 10} y={node.y + node.height - 12} textAnchor="end">came from</text>}
            {band && <circle className={`change-map-node-risk-dot band-${band}`} cx={node.x + node.width - 11} cy={node.y + 11} r="4" />}
          </g>;
        })}
      </svg>
    </div>
  </div>;
});
