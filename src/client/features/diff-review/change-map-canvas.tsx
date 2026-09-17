import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { changeEdgeLabel, type ChangeMapNode, changeEdgeContinuity } from '../../../shared/change-map.js';
import { CODE_CATEGORY_LABELS, type CodeCategory } from './change-map-taxonomy.js';
import type { ChangeMapLayout } from './change-map-layout.js';
import { plainRelationText } from './change-map-logic.js';

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

/** The width assumed before the element has been measured — a first paint and
 * a test renderer, where there is no layout yet. Every camera sum after that
 * uses the real pixel box instead. */
const VIEW_WIDTH = 960;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
/** Fitting stops at 1: a four-node neighbourhood should sit at its drawn size
 * in the middle of the pane, not be blown up to fill it. */
const MAX_FIT_ZOOM = 1;
const ZOOM_STEP = 1.35;
/** The most one wheel event may change the scale by. A trackpad reports
 * hundreds of units of delta per flick and several events per frame, so
 * without a ceiling per event a single gesture slams the camera into its stop
 * long before the fingers stop moving. */
const MAX_WHEEL_STEP = 1.2;
/** Below this the captions are noise, above it there is room for all of them. */
const LABEL_ZOOM = 1.15;
const CAPTION_RADIUS = 19;
/** Several small pulses make direction readable immediately. One large pulse
 * became a fake-looking node when the reviewer zoomed in. */
const EDGE_FLOW_PULSES = 3;

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** The element's pixel box. The world window is this divided by the zoom, so
 * the `viewBox` and the element are always the same shape and one screen pixel
 * is always `1 / zoom` world units on both axes. */
interface Viewport {
  width: number;
  height: number;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Keeps the drawing findable. Pan and zoom stay free until the window has
 * left the drawing behind altogether: past that there is nothing on screen to
 * navigate by and `Fit` is the only way back, which is not a camera, it is a
 * trap. */
function clampCamera(camera: Camera, layout: ChangeMapLayout, view: Viewport): Camera {
  const span = (extent: number, window: number): [number, number] => {
    const low = -window / 2;
    const high = extent - window / 2;
    return low <= high ? [low, high] : [high, low];
  };
  const [minX, maxX] = span(layout.width, view.width / camera.zoom);
  const [minY, maxY] = span(layout.height, view.height / camera.zoom);
  return {
    zoom: camera.zoom,
    x: Math.min(maxX, Math.max(minX, camera.x)),
    y: Math.min(maxY, Math.max(minY, camera.y)),
  };
}

/** The camera that shows the whole drawing, centred. Every surface opens here
 * and the `Fit` control returns to it. */
function fitCamera(layout: ChangeMapLayout, view: Viewport): Camera {
  const zoom = clampZoom(Math.min(MAX_FIT_ZOOM, Math.min(view.width / layout.width, view.height / layout.height)));
  return {
    x: layout.width / 2 - view.width / zoom / 2,
    y: layout.height / 2 - view.height / zoom / 2,
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
  const changeKind = node.changeKind === 'added'
    ? ' Net-new code.'
    : node.changeKind === 'removed'
      ? ' Deleted code.'
      : node.changeKind === 'modified'
        ? ' Modified code.'
        : '';
  const files = node.filePaths.length > 0 ? ` Files: ${node.filePaths.join(', ')}.` : '';
  const symbols = node.symbols.length > 0 ? ` Declares: ${node.symbols.map(markSymbol).join(', ')}.` : '';
  const signatures = node.signatureChanges.map((change) => {
    const added = change.added.length > 0 ? `adds ${change.added.join(', ')}` : '';
    const removed = change.removed.length > 0 ? `removes ${change.removed.join(', ')}` : '';
    return `${change.symbol} ${[added, removed].filter(Boolean).join(' and ')}`;
  });
  return ` ${CODE_CATEGORY_LABELS[node.category]} code, ${node.additions + node.deletions} lines changed.${changeKind}${files}${symbols}${signatures.length > 0 ? ` Signature changes: ${signatures.join('; ')}.` : ''}`;
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

export const ChangeMapCanvas = memo(function ChangeMapCanvas({ layout, selectedId, cameFromId, riskBands, inspectedId, codePanel, selectedEdgeId, label = 'Change map diagram', nodeAttribute = 'data-change-map-node', viewHeight = 560, onSelect, onSelectEdge }: {
  layout: ChangeMapLayout;
  selectedId: string | null;
  /** The change the reviewer was on before following a relationship here, so
   * the diagram shows the trail back rather than only where they landed. */
  cameFromId?: string | null;
  riskBands?: Map<string, string>;
  /** The node whose code is open in the dock beside the drawing. Supplying it
   * — even as null — is what tells the canvas that a click shows code here,
   * so the discs announce that rather than a panel that never opens. */
  inspectedId?: string | null;
  /** The code itself, drawn as a column inside this frame. It is deliberately
   * not a popover and not the diff pane below: a reviewer asking "what is
   * this disc?" should not have the page move under them to answer it. */
  codePanel?: ReactNode;
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
  onSelectEdge: (edgeId: string | null) => void;
}) {
  const surface = useRef<SVGSVGElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: VIEW_WIDTH, height: viewHeight });
  /** The last measurement and the current drawing, read by the wheel, the drag
   * and the keys. They are refs so those handlers do not have to be rebuilt —
   * and rebound — every time the camera moves. */
  const measured = useRef<Viewport | null>(null);
  const world = useRef(layout);
  world.current = layout;
  const [camera, setCamera] = useState<Camera>(() => fitCamera(layout, { width: VIEW_WIDTH, height: viewHeight }));
  const [panning, setPanning] = useState(false);

  const viewportNow = useCallback((): Viewport => measured.current ?? { width: VIEW_WIDTH, height: viewHeight }, [viewHeight]);

  // A different subgraph is a different world, so the camera goes back to
  // showing all of it. Without this, focusing a change leaves the reviewer
  // looking at empty space where the previous drawing used to be.
  useLayoutEffect(() => {
    setCamera(fitCamera(layout, viewportNow()));
  }, [layout, viewHeight, viewportNow]);

  // The window onto the world is the element's own pixel box divided by the
  // zoom, so the `viewBox` and the element always have the same shape. When
  // they do not, `preserveAspectRatio` silently letterboxes the drawing and
  // every pointer handed to it lands on the wrong world point: the map slides
  // out from under the cursor instead of zooming about it, and a drag moves it
  // at a different rate across than down. A docked code column, which takes
  // 40% of the width away the moment a disc is clicked, made that mismatch
  // certain.
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return undefined;
    const apply = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      const previous = measured.current;
      if (previous && Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5) return;
      measured.current = { width, height };
      setViewport({ width, height });
      // Resizing must not take the reviewer anywhere: whatever was in the
      // middle of the pane stays in the middle, so opening the code column
      // narrows the view onto the same drawing instead of jumping it.
      setCamera((current) => (previous
        ? clampCamera({
            zoom: current.zoom,
            x: current.x + (previous.width - width) / current.zoom / 2,
            y: current.y + (previous.height - height) / current.zoom / 2,
          }, world.current, { width, height })
        : fitCamera(world.current, { width, height })));
    };
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) apply(box.width, box.height);
      })
      : null;
    observer?.observe(element);
    const rect = element.getBoundingClientRect();
    apply(rect.width, rect.height);
    return () => observer?.disconnect();
  }, []);

  const worldWidth = viewport.width / camera.zoom;
  const worldHeight = viewport.height / camera.zoom;

  /** Zoom about a point on the screen, so whatever is under the pointer stays
   * under the pointer. Zooming about the centre instead is the thing that
   * makes a map feel like it is fighting back.
   *
   * The anchor is worked out inside the update, from the camera actually being
   * replaced: a trackpad sends several wheel events per frame, and reading the
   * rendered camera would anchor every event after the first to a position
   * that has already moved. */
  const zoomAt = useCallback((factor: number, client?: { x: number; y: number }) => {
    setCamera((current) => {
      const zoom = clampZoom(current.zoom * factor);
      if (zoom === current.zoom) return current;
      const view = measured.current ?? { width: VIEW_WIDTH, height: viewHeight };
      const rect = client ? surface.current?.getBoundingClientRect() : undefined;
      const anchor = client && rect && rect.width > 0 && rect.height > 0
        ? { x: current.x + (client.x - rect.left) / current.zoom, y: current.y + (client.y - rect.top) / current.zoom }
        : { x: current.x + view.width / current.zoom / 2, y: current.y + view.height / current.zoom / 2 };
      return clampCamera({
        zoom,
        x: anchor.x - (anchor.x - current.x) * (current.zoom / zoom),
        y: anchor.y - (anchor.y - current.y) * (current.zoom / zoom),
      }, world.current, view);
    });
  }, [viewHeight]);

  const fit = useCallback(() => setCamera(fitCamera(world.current, viewportNow())), [viewportNow]);

  // Wheel has to be bound by hand and non-passively: React routes it through a
  // passive listener, where `preventDefault` is ignored and zooming the map
  // scrolls the review pane behind it instead.
  useEffect(() => {
    const element = surface.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Firefox reports lines, and a page scroll reports pages. Left in their
      // own units a notch there would be worth a fortieth of the same notch
      // elsewhere.
      const pixels = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * (element.getBoundingClientRect().height || viewHeight)
          : event.deltaY;
      const factor = Math.min(MAX_WHEEL_STEP, Math.max(1 / MAX_WHEEL_STEP, Math.exp(-pixels * 0.0015)));
      zoomAt(factor, { x: event.clientX, y: event.clientY });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt, viewHeight]);

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
    // One screen pixel is `1 / zoom` world units on both axes now that the
    // window matches the element, so the drag needs no measuring of its own.
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    drag.current = { ...active, x: event.clientX, y: event.clientY };
    setCamera((current) => clampCamera({
      zoom: current.zoom,
      x: current.x - dx / current.zoom,
      y: current.y - dy / current.zoom,
    }, world.current, measured.current ?? { width: VIEW_WIDTH, height: viewHeight }));
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
    const shift = (dx: number, dy: number) => setCamera((current) => clampCamera({
      zoom: current.zoom,
      x: current.x + dx * (60 / current.zoom),
      y: current.y + dy * (60 / current.zoom),
    }, world.current, viewportNow()));
    const moves: Record<string, () => void> = {
      '+': () => zoomAt(ZOOM_STEP),
      '=': () => zoomAt(ZOOM_STEP),
      '-': () => zoomAt(1 / ZOOM_STEP),
      '0': fit,
      ArrowLeft: () => shift(-1, 0),
      ArrowRight: () => shift(1, 0),
      ArrowUp: () => shift(0, -1),
      ArrowDown: () => shift(0, 1),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  };

  // Opening a node's code is the strongest local question on the canvas. Let
  // that inspected node focus the relationships while its panel is open;
  // otherwise the current review decision remains the focus.
  const relationshipFocusId = inspectedId ?? selectedId;
  const connectedIds = new Set(layout.edges
    .filter((edge) => edge.fromId === relationshipFocusId || edge.toId === relationshipFocusId)
    .flatMap((edge) => [edge.fromId, edge.toId]));

  // Lines that answer the current selection are painted last, so they sit on
  // top of the ones the reviewer is not asking about rather than under them.
  const orderedEdges = [...layout.edges].sort((left, right) =>
    Number(left.fromId === relationshipFocusId || left.toId === relationshipFocusId) - Number(right.fromId === relationshipFocusId || right.toId === relationshipFocusId));

  // Big discs are drawn first so a small one is never lost underneath one that
  // happens to be near it.
  const orderedNodes = [...layout.nodes].sort((left, right) => right.radius - left.radius);

  const selectedFolder = layout.nodes.find((node) => node.id === relationshipFocusId)?.folderId ?? null;
  const selectedPackage = layout.nodes.find((node) => node.id === relationshipFocusId)?.packageId ?? null;
  const selectedFile = layout.nodes.find((node) => node.id === relationshipFocusId)?.fileId ?? null;
  const showEveryCaption = camera.zoom >= LABEL_ZOOM;
  const showsCode = inspectedId !== undefined;

  const activate = (event: KeyboardEvent, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };

  return <div
    className={`change-map-canvas${panning ? ' panning' : ''}${codePanel ? ' with-code' : ''}`}
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
      {/* The packages, then the folders inside them. They are drawn first and
          never take a click: they are the ground the graph sits on, and what
          makes a line leaving one of them visible as leaving it. */}
      {layout.packages.map((group) => <g key={group.id} className={`change-map-package${selectedPackage === group.id ? ' selected' : ''}`} aria-hidden="true">
        <circle className="change-map-package-ring" cx={group.x} cy={group.y} r={group.radius} vectorEffect="non-scaling-stroke" />
        <text className="change-map-package-label" x={group.x} y={group.y - group.radius + 20} textAnchor="middle">
          {pathTail(group.label, 40)}
          <tspan className="change-map-group-count" dx="8">{group.nodeCount} {group.nodeCount === 1 ? 'change' : 'changes'} · {group.folderCount} {group.folderCount === 1 ? 'folder' : 'folders'}</tspan>
        </text>
      </g>)}
      {layout.folders.map((group) => <g key={group.id} className={`change-map-folder${selectedFolder === group.id ? ' selected' : ''}${group.externalEdges > 0 && group.containment < 0.5 ? ' reaching' : ''}`} aria-hidden="true">
        <circle className="change-map-folder-ring" cx={group.x} cy={group.y} r={group.radius} vectorEffect="non-scaling-stroke" />
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
      {layout.files.map((group) => <g key={group.id} className={`change-map-file${selectedFile === group.id ? ' selected' : ''}`} aria-hidden="true">
        <circle className="change-map-file-ring" cx={group.x} cy={group.y} r={group.radius} vectorEffect="non-scaling-stroke" />
        <text className="change-map-file-label" x={group.x} y={group.y - group.radius + 13} textAnchor="middle">
          {pathTail(group.label, 28)}
          <tspan className="change-map-group-count" dx="6">{group.nodeCount} {group.nodeCount === 1 ? 'change' : 'changes'}</tspan>
        </text>
      </g>)}
      {orderedEdges.map((edge, edgeIndex) => {
        const active = edge.id === selectedEdgeId;
        const touchesSelection = edge.fromId === relationshipFocusId || edge.toId === relationshipFocusId;
        const dimmed = Boolean(relationshipFocusId) && !touchesSelection && !active;
        const showFlow = edge.change === 'added' && (!dimmed || layout.edges.length <= 12);
        return <g key={edge.id} className={`change-map-edge relation-${edge.relation} scope-${edge.scope} ${changeEdgeContinuity(edge)}${active ? ' active' : ''}${touchesSelection ? ' touches-selection' : ''}${dimmed ? ' dimmed' : ''}`}>
          <path className="change-map-edge-line" d={edge.path} vectorEffect="non-scaling-stroke">
            {edge.change === 'removed' && <animate attributeName="opacity" values="0.65;0.08;0.65" dur="2.4s" begin={`${-(edgeIndex % 6) * 0.19}s`} repeatCount="indefinite" />}
          </path>
          {showFlow && Array.from({ length: EDGE_FLOW_PULSES }, (_, pulseIndex) => <circle
            key={pulseIndex}
            className={`change-map-edge-flow${edge.relation === 'references-type' ? ' reference' : ''}`}
            r={(edge.relation === 'references-type' ? 3.2 : 2.7) / camera.zoom}
            vectorEffect="non-scaling-stroke"
            aria-hidden="true"
          >
            <animateMotion path={edge.path} dur="1.8s" begin={`${-(edgeIndex % 6) * 0.13 - pulseIndex * 0.6}s`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
          </circle>)}
          <path
            className="change-map-edge-target"
            d={edge.path}
            vectorEffect="non-scaling-stroke"
            role="button"
            tabIndex={0}
            aria-label={`${changeEdgeLabel(edge)}: ${plainRelationText(edge.explanation)}`}
            onClick={() => onSelectEdge(active ? null : edge.id)}
            onKeyDown={(event) => activate(event, () => onSelectEdge(active ? null : edge.id))}
          />
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
        const inspected = showsCode && node.id === inspectedId;
        return <g
          key={node.id}
          className={`change-map-node category-${node.category} state-${node.state ?? 'pending'}${isSelected ? ' selected' : ''}${cameFrom ? ' came-from' : ''}${reviewed ? ' reviewed' : ''}${dimmed ? ' dimmed' : ''}${node.degree === 0 ? ' isolated' : ''}${node.crossPackageDegree > 0 ? ' crosses-package' : ''}${inspected ? ' inspected' : ''}`}
          role="button"
          tabIndex={0}
          aria-pressed={isSelected}
          // A stable handle on the node, so an open popover can re-find it
          // after selecting reflows the diagram into focus mode.
          {...{ [nodeAttribute]: node.id }}
          aria-expanded={showsCode ? inspected : undefined}
          aria-label={`Decision ${node.ordinal}: ${node.behavior}${nodeContext(node)} ${reachText(node)}${cameFrom ? ' Came from here.' : ''}${reviewed ? ' Already reviewed.' : ''}${band ? ` ${band} risk.` : ''}${showsCode ? (inspected ? ' Its code is shown beside the diagram.' : ' Show its code beside the diagram.') : ''}`}
          onClick={() => onSelect(node.id)}
          onKeyDown={(event) => activate(event, () => onSelect(node.id))}
        >
          {/* The disc is the change, and its area is how much code the change
              moves. The inner ring says whether the code is new, deleted or
              modified; the outer ring is the reviewer's own verdict. */}
          <circle className="change-map-node-body" cx={node.x} cy={node.y} r={node.radius} vectorEffect="non-scaling-stroke" />
          {node.changeKind && (node.changeKind === 'modified'
            ? <>
                <circle className="change-map-node-change-ring change-added-half" cx={node.x} cy={node.y} r={Math.max(1, node.radius - 3.5)} pathLength="100" vectorEffect="non-scaling-stroke" />
                <circle className="change-map-node-change-ring change-removed-half" cx={node.x} cy={node.y} r={Math.max(1, node.radius - 3.5)} pathLength="100" vectorEffect="non-scaling-stroke" />
              </>
            : <circle className={`change-map-node-change-ring change-${node.changeKind}`} cx={node.x} cy={node.y} r={Math.max(1, node.radius - 3.5)} vectorEffect="non-scaling-stroke" />)}
          <circle className="change-map-node-rail" cx={node.x} cy={node.y} r={node.radius} vectorEffect="non-scaling-stroke" />
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
    {/* The code sits in the frame, beside the drawing: the drawing narrows to
        make room for it and nothing outside this element moves. */}
    {codePanel}
    {/* The camera's own controls. The wheel and a drag do the same job, but a
        surface whose only zoom is a gesture is one a reviewer has to be told
        about, and the percentage is what makes "am I zoomed in?" answerable. */}
    <div className="change-map-zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / ZOOM_STEP)}><Minus size={12} aria-hidden="true" /></button>
      <output aria-live="off">{Math.round(camera.zoom * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => zoomAt(ZOOM_STEP)}><Plus size={12} aria-hidden="true" /></button>
      <button type="button" aria-label="Fit to view" onClick={fit}><Crosshair size={12} aria-hidden="true" /></button>
    </div>
  </div>;
});
