import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { CHANGE_RELATIONS, changeEdgeLabel, type ChangeMapNode, changeEdgeContinuity } from '../../../shared/change-map.js';
import { CODE_CATEGORY_LABELS, type CodeCategory } from './change-map-taxonomy.js';
import type { ChangeMapLayout } from './change-map-layout.js';
import { plainRelationText } from './change-map-logic.js';
import type { DecisionPopoverAnchor } from './decision-popover.js';

/** The drawing itself, shared by the whole-diff diagram and the per-decision
 * diagram beside an open decision panel. Both surfaces must read as the same
 * picture — same discs, same lines, same selection semantics — so the markup
 * lives in one place and the callers only decide which subgraph to hand it.
 *
 * It is a camera over a world, not a picture in a scrolling box. The old
 * surface was called a canvas and behaved like an image: it grew to whatever
 * the layout measured and left the reviewer to scroll a diagram far wider than
 * the pane. Here the SVG stays the size of the pane and the `viewBox` moves —
 * so the wheel zooms about the pointer, a drag pans, and a wide refactor can
 * be taken in whole and then gone into. */

/** The logical width of the window onto the world. The element is sized by
 * CSS; this is only the unit the camera works in, so one constant keeps
 * zooming, fitting and panning in the same arithmetic. */
const VIEW_WIDTH = 960;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
/** Fitting stops at 1: a four-node neighbourhood should sit at its drawn size
 * in the middle of the pane, not be blown up to fill it. */
const MAX_FIT_ZOOM = 1;
const ZOOM_STEP = 1.35;
/** Below this the captions are noise, above it there is room for all of them. */
const LABEL_ZOOM = 1.15;
const ALWAYS_LABEL_EDGES = 8;
const CAPTION_RADIUS = 19;

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The camera that shows the whole drawing, centred. Every surface opens here
 * and the `Fit` control returns to it. */
function fitCamera(layout: ChangeMapLayout, viewHeight: number): Camera {
  const zoom = clampZoom(Math.min(MAX_FIT_ZOOM, Math.min(VIEW_WIDTH / layout.width, viewHeight / layout.height)));
  return {
    x: layout.width / 2 - VIEW_WIDTH / zoom / 2,
    y: layout.height / 2 - viewHeight / zoom / 2,
    zoom,
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** The end of a path, which is the part that identifies the folder. */
function pathTail(value: string, limit: number): string {
  return value.length <= limit ? value : `…${value.slice(-(limit - 1))}`;
}

/** A declaration and what the patch did to it: `+` added, `−` removed, bare
 * for one that exists on both sides and was rewritten. */
function markSymbol(symbol: ChangeMapNode['symbols'][number]): string {
  if (symbol.change === 'added') return `+${symbol.name}`;
  if (symbol.change === 'removed') return `−${symbol.name}`;
  return symbol.name;
}

/** Everything the node is, spelled out for a screen reader: what kind of code
 * it is, the files it touches, the declarations it moves, and the signatures
 * it changes. The disc says size and reach by shape; none of that survives
 * into a screen reader, so it is said in words here instead. */
function nodeContext(node: ChangeMapNode & { category: CodeCategory; externalDegree: number; crossPackageDegree: number }): string {
  const files = node.filePaths.length > 0 ? ` Files: ${node.filePaths.join(', ')}.` : '';
  const symbols = node.symbols.length > 0 ? ` Declares: ${node.symbols.map(markSymbol).join(', ')}.` : '';
  const signatures = node.signatureChanges.map((change) => {
    const added = change.added.length > 0 ? `adds ${change.added.join(', ')}` : '';
    const removed = change.removed.length > 0 ? `removes ${change.removed.join(', ')}` : '';
    return `${change.symbol} ${[added, removed].filter(Boolean).join(' and ')}`;
  });
  return ` ${CODE_CATEGORY_LABELS[node.category]} code, ${node.additions + node.deletions} lines changed.${files}${symbols}${signatures.length > 0 ? ` Signature changes: ${signatures.join('; ')}.` : ''}`;
}

/** How far this change reaches, which is the question the rings exist to
 * answer and the one a reviewer cannot get from a list of edges. */
function reachText(node: { degree: number; externalDegree: number; crossPackageDegree: number }): string {
  if (node.degree === 0) return 'No related changes.';
  const related = `${node.degree} related ${node.degree === 1 ? 'change' : 'changes'}`;
  if (node.externalDegree === 0) return `${related}, all inside its own folder.`;
  const outside = `${node.externalDegree} outside its folder`;
  return node.crossPackageDegree > 0
    ? `${related}, ${outside}, ${node.crossPackageDegree} in another package.`
    : `${related}, ${outside}.`;
}

export const ChangeMapCanvas = memo(function ChangeMapCanvas({ layout, selectedId, cameFromId, riskBands, openDetailFor, selectedEdgeId, label = 'Change map diagram', nodeAttribute = 'data-change-map-node', viewHeight = 560, onSelect, onOpenDetail, onSelectEdge }: {
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
  /** How tall the window onto the world is. A panel gets a shorter one than a
   * page; the camera arithmetic is the same either way. */
  viewHeight?: number;
  onSelect: (decisionId: string) => void;
  onOpenDetail?: (decisionId: string, anchor: DecisionPopoverAnchor) => void;
  onSelectEdge: (edgeId: string | null) => void;
}) {
  const surface = useRef<SVGSVGElement | null>(null);
  const [camera, setCamera] = useState<Camera>(() => fitCamera(layout, viewHeight));
  const [panning, setPanning] = useState(false);

  // A different subgraph is a different world, so the camera goes back to
  // showing all of it. Without this, focusing a change leaves the reviewer
  // looking at empty space where the previous drawing used to be.
  useLayoutEffect(() => {
    setCamera(fitCamera(layout, viewHeight));
  }, [layout, viewHeight]);

  const worldWidth = VIEW_WIDTH / camera.zoom;
  const worldHeight = viewHeight / camera.zoom;

  /** Zoom about a fixed point in the world, so whatever is under the pointer
   * stays under the pointer. Zooming about the centre instead is the thing
   * that makes a map feel like it is fighting back. */
  const zoomAbout = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    setCamera((current) => {
      const zoom = clampZoom(current.zoom * factor);
      if (zoom === current.zoom) return current;
      const point = anchor ?? { x: current.x + VIEW_WIDTH / current.zoom / 2, y: current.y + viewHeight / current.zoom / 2 };
      return {
        zoom,
        x: point.x - (point.x - current.x) * (current.zoom / zoom),
        y: point.y - (point.y - current.y) * (current.zoom / zoom),
      };
    });
  }, [viewHeight]);

  /** Where a pointer is in the world. Falls back to the middle of the view
   * when the element has not been measured — the camera must still move, just
   * about the centre rather than about the cursor. */
  const worldPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return undefined;
    return {
      x: camera.x + ((clientX - rect.left) / rect.width) * worldWidth,
      y: camera.y + ((clientY - rect.top) / rect.height) * worldHeight,
    };
  }, [camera.x, camera.y, worldWidth, worldHeight]);

  // Wheel has to be bound by hand and non-passively: React routes it through a
  // passive listener, where `preventDefault` is ignored and zooming the map
  // scrolls the review pane behind it instead.
  useEffect(() => {
    const element = surface.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAbout(Math.exp(-event.deltaY * 0.0015), worldPoint(event.clientX, event.clientY));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAbout, worldPoint]);

  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const startPan = (event: PointerEvent<SVGSVGElement>) => {
    // Only empty space drags. A press that started on a disc or a line is that
    // element's, or the reviewer could never click anything.
    if (event.button !== 0 || (event.target as Element).closest('.change-map-node, .change-map-edge-target')) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setPanning(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const movePan = (event: PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const rect = surface.current?.getBoundingClientRect();
    const scaleX = rect && rect.width > 0 ? worldWidth / rect.width : 1 / camera.zoom;
    const scaleY = rect && rect.height > 0 ? worldHeight / rect.height : 1 / camera.zoom;
    const dx = (event.clientX - active.x) * scaleX;
    const dy = (event.clientY - active.y) * scaleY;
    drag.current = { ...active, x: event.clientX, y: event.clientY };
    setCamera((current) => ({ ...current, x: current.x - dx, y: current.y - dy }));
  };
  const endPan = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  /** The same camera from the keyboard, because a reviewer who navigates the
   * diagram with the keyboard needs to move it with the keyboard too. */
  const onCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nudge = 60 / camera.zoom;
    const moves: Record<string, () => void> = {
      '+': () => zoomAbout(ZOOM_STEP),
      '=': () => zoomAbout(ZOOM_STEP),
      '-': () => zoomAbout(1 / ZOOM_STEP),
      '0': () => setCamera(fitCamera(layout, viewHeight)),
      ArrowLeft: () => setCamera((current) => ({ ...current, x: current.x - nudge })),
      ArrowRight: () => setCamera((current) => ({ ...current, x: current.x + nudge })),
      ArrowUp: () => setCamera((current) => ({ ...current, y: current.y - nudge })),
      ArrowDown: () => setCamera((current) => ({ ...current, y: current.y + nudge })),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  };

  const connectedIds = new Set(layout.edges
    .filter((edge) => edge.fromId === selectedId || edge.toId === selectedId)
    .flatMap((edge) => [edge.fromId, edge.toId]));

  // Lines that answer the current selection are painted last, so they sit on
  // top of the ones the reviewer is not asking about rather than under them.
  const orderedEdges = [...layout.edges].sort((left, right) =>
    Number(left.fromId === selectedId || left.toId === selectedId) - Number(right.fromId === selectedId || right.toId === selectedId));

  // Big discs are drawn first so a small one is never lost underneath one that
  // happens to be near it.
  const orderedNodes = [...layout.nodes].sort((left, right) => right.radius - left.radius);

  const selectedFolder = layout.nodes.find((node) => node.id === selectedId)?.folderId ?? null;
  const selectedPackage = layout.nodes.find((node) => node.id === selectedId)?.packageId ?? null;
  const showEveryCaption = camera.zoom >= LABEL_ZOOM;

  const activate = (event: KeyboardEvent, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };

  return <div
    className={`change-map-canvas${layout.edges.length <= ALWAYS_LABEL_EDGES ? ' labelled' : ''}${panning ? ' panning' : ''}`}
    role="group"
    aria-label={label}
    tabIndex={0}
    onKeyDown={onCanvasKeyDown}
  >
    <svg
      ref={surface}
      className="change-map-surface"
      width="100%"
      height={viewHeight}
      viewBox={`${camera.x} ${camera.y} ${worldWidth} ${worldHeight}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <defs>
        {CHANGE_RELATIONS.map((relation) => <marker key={relation} id={`change-map-arrow-${relation}`} className={`change-map-arrow relation-${relation}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 8 4 L 0 7 z" />
        </marker>)}
      </defs>
      {/* The packages, then the folders inside them. They are drawn first and
          never take a click: they are the ground the graph sits on, and what
          makes a line leaving one of them visible as leaving it. */}
      {layout.packages.map((group) => <g key={group.id} className={`change-map-package${selectedPackage === group.id ? ' selected' : ''}`} aria-hidden="true">
        <circle className="change-map-package-ring" cx={group.x} cy={group.y} r={group.radius} />
        <text className="change-map-package-label" x={group.x} y={group.y - group.radius + 20} textAnchor="middle">
          {pathTail(group.label, 40)}
          <tspan className="change-map-group-count" dx="8">{group.nodeCount} {group.nodeCount === 1 ? 'change' : 'changes'} · {group.folderCount} {group.folderCount === 1 ? 'folder' : 'folders'}</tspan>
        </text>
      </g>)}
      {layout.folders.map((group) => <g key={group.id} className={`change-map-folder${selectedFolder === group.id ? ' selected' : ''}${group.externalEdges > 0 && group.containment < 0.5 ? ' reaching' : ''}`} aria-hidden="true">
        <circle className="change-map-folder-ring" cx={group.x} cy={group.y} r={group.radius} />
        <text className="change-map-folder-label" x={group.x} y={group.y - group.radius + 15} textAnchor="middle">
          {pathTail(group.label, 34)}
          {/* Said in the drawing as line length, and in words here, because
              "mostly self-contained" is the judgement the reviewer is making
              and it should not depend on counting lines. */}
          <tspan className="change-map-group-count" dx="7">{group.externalEdges === 0
            ? 'self-contained'
            : `${Math.round(group.containment * 100)}% internal`}</tspan>
        </text>
      </g>)}
      {orderedEdges.map((edge) => {
        const active = edge.id === selectedEdgeId;
        const touchesSelection = edge.fromId === selectedId || edge.toId === selectedId;
        const dimmed = Boolean(selectedId) && !touchesSelection && !active;
        return <g key={edge.id} className={`change-map-edge relation-${edge.relation} scope-${edge.scope} ${changeEdgeContinuity(edge)}${active ? ' active' : ''}${touchesSelection ? ' touches-selection' : ''}${dimmed ? ' dimmed' : ''}`}>
          <path className="change-map-edge-line" d={edge.path} markerEnd={`url(#change-map-arrow-${edge.relation})`} />
          <path
            className="change-map-edge-target"
            d={edge.path}
            role="button"
            tabIndex={0}
            aria-label={`${changeEdgeLabel(edge)}: ${plainRelationText(edge.explanation)}`}
            onClick={() => onSelectEdge(active ? null : edge.id)}
            onKeyDown={(event) => activate(event, () => onSelectEdge(active ? null : edge.id))}
          />
          <text className="change-map-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">{changeEdgeLabel(edge)}</text>
        </g>;
      })}
      {orderedNodes.map((node) => {
        const isSelected = node.id === selectedId;
        const cameFrom = !isSelected && node.id === cameFromId;
        // A recorded state is the reviewer's own mark on this change: whatever
        // they decided, they have already read it.
        const reviewed = node.state !== null;
        const dimmed = Boolean(selectedId) && !isSelected && connectedIds.size > 0 && !connectedIds.has(node.id);
        const band = riskBands?.get(node.id) ?? null;
        const captioned = showEveryCaption || isSelected || cameFrom || node.radius >= CAPTION_RADIUS;
        const openDetail = (anchor: DecisionPopoverAnchor) => {
          onSelect(node.id);
          onOpenDetail?.(node.id, anchor);
        };
        return <g
          key={node.id}
          className={`change-map-node category-${node.category} state-${node.state ?? 'pending'}${isSelected ? ' selected' : ''}${cameFrom ? ' came-from' : ''}${reviewed ? ' reviewed' : ''}${dimmed ? ' dimmed' : ''}${node.degree === 0 ? ' isolated' : ''}${node.crossPackageDegree > 0 ? ' crosses-package' : ''}`}
          role="button"
          tabIndex={0}
          aria-pressed={isSelected}
          // A stable handle on the node, so an open popover can re-find it
          // after selecting reflows the diagram into focus mode.
          {...{ [nodeAttribute]: node.id }}
          aria-haspopup={onOpenDetail ? 'dialog' : undefined}
          aria-expanded={onOpenDetail ? openDetailFor === node.id : undefined}
          aria-label={`Decision ${node.ordinal}: ${node.behavior}${nodeContext(node)} ${reachText(node)}${cameFrom ? ' Came from here.' : ''}${reviewed ? ' Already reviewed.' : ''}${band ? ` ${band} risk.` : ''}${onOpenDetail ? ' Open decision details.' : ''}`}
          onClick={(event) => openDetail(event.currentTarget)}
          onKeyDown={(event) => activate(event, () => openDetail(event.currentTarget))}
        >
          {/* The disc is the change, and its area is how much code the change
              moves. The ring around it is the reviewer's own verdict. */}
          <circle className="change-map-node-body" cx={node.x} cy={node.y} r={node.radius} />
          <circle className="change-map-node-rail" cx={node.x} cy={node.y} r={node.radius} />
          {node.radius >= 14 && <text className="change-map-node-ordinal" x={node.x} y={node.y + 4} textAnchor="middle">{node.ordinal}</text>}
          {captioned && <text className="change-map-node-title" x={node.labelX} y={node.titleY} textAnchor={node.labelAnchor}>{truncate(node.label, 26)}</text>}
          {captioned && <text className="change-map-node-counts" x={node.labelX} y={node.countsY} textAnchor={node.labelAnchor}>
            <tspan className="added">+{node.additions}</tspan>
            <tspan className="removed" dx="6">−{node.deletions}</tspan>
            {node.fileCount > 1 && <tspan className="spans" dx="7">· {node.fileCount} files</tspan>}
          </text>}
          {cameFrom && <text className="change-map-node-trail" x={node.x} y={node.y - node.radius - 8} textAnchor="middle">came from</text>}
          {band && <circle className={`change-map-node-risk-dot band-${band}`} cx={node.x + node.radius * 0.71} cy={node.y - node.radius * 0.71} r="4.5" />}
        </g>;
      })}
    </svg>
    {/* The camera's own controls. The wheel and a drag do the same job, but a
        surface whose only zoom is a gesture is one a reviewer has to be told
        about, and the percentage is what makes "am I zoomed in?" answerable. */}
    <div className="change-map-zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => zoomAbout(1 / ZOOM_STEP)}><Minus size={12} aria-hidden="true" /></button>
      <output aria-live="off">{Math.round(camera.zoom * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => zoomAbout(ZOOM_STEP)}><Plus size={12} aria-hidden="true" /></button>
      <button type="button" aria-label="Fit to view" onClick={() => setCamera(fitCamera(layout, viewHeight))}><Crosshair size={12} aria-hidden="true" /></button>
    </div>
  </div>;
});
