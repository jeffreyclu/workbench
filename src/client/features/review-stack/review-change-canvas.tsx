import { memo, useEffect, useMemo, useRef } from 'react';
import type { ChangeMap } from '../../../shared/change-map.js';

/** The handle a canvas node is addressed by. */
export const REVIEW_CANVAS_NODE_ATTRIBUTE = 'data-review-canvas-node';

const NODE_HEIGHT = 74;
const NODE_GAP = 14;
const ROW = NODE_HEIGHT + NODE_GAP;
/** The strip left of the boxes that the relationship curves run in. */
const LANE_WIDTH = 28;
const LANE_STEP = 7;

function fileTail(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length <= 2 ? filePath : `…/${parts.slice(-2).join('/')}`;
}

/**
 * The canvas beside the code: one node per change, stacked in the order the
 * diff reads.
 *
 * It is deliberately laid out down the page rather than across it. The pane it
 * lives in is a column beside the code, so a left-to-right graph would have to
 * be scrolled sideways to be read at all, and the thing the reviewer is
 * matching it against — hunks in a file — only ever runs downward.
 *
 * Node ids are decision ids, which is what makes the coupling exact rather than
 * approximate: the queue, the diff gutter and this canvas all select the same
 * value, so focusing a hunk focuses its node and focusing a node focuses its
 * hunk without any translation between them.
 */
export const ReviewChangeCanvas = memo(function ReviewChangeCanvas({
  map, selectedId, selectionTick, openDetailFor, handled, onSelect,
}: {
  map: ChangeMap;
  selectedId: string | null;
  /** Changes already dealt with, mapped to why — 'Approved', 'Delegated'. They
   * are greyed rather than dropped: the canvas is a map of the whole change,
   * and a node missing from it would make the diff and the map disagree about
   * how many changes there are. */
  handled?: Map<string, string>;
  /** Bumped on every selection, including reselecting the same node, so the
   * canvas re-reveals a node the reviewer scrolled away from. */
  selectionTick: number;
  /** The change whose decision popover is open, so the node that opened it
   * reads as expanded. */
  openDetailFor?: string | null;
  /** A node press is a handle press: it names the change and hands over the
   * element the popover anchors to, exactly as the gutter marker does. */
  onSelect: (decisionId: string, anchor: HTMLElement) => void;
}) {
  const body = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => new Map(map.nodes.map((node, index) => [node.id, index])), [map.nodes]);

  // Curves are computed from the row index rather than measured, so the drawing
  // is identical on every render and cannot disagree with where the boxes are.
  const edges = useMemo(() => map.edges.flatMap((edge) => {
    const from = rows.get(edge.fromId);
    const to = rows.get(edge.toId);
    if (from === undefined || to === undefined || from === to) return [];
    const y1 = from * ROW + NODE_HEIGHT / 2;
    const y2 = to * ROW + NODE_HEIGHT / 2;
    const bulge = LANE_WIDTH - Math.min(3, Math.abs(from - to)) * LANE_STEP;
    return [{
      id: edge.id,
      touches: edge.fromId === selectedId || edge.toId === selectedId,
      d: `M ${LANE_WIDTH} ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, ${LANE_WIDTH} ${y2}`,
    }];
  }), [map.edges, rows, selectedId]);

  const linked = useMemo(() => new Set(map.edges
    .filter((edge) => edge.fromId === selectedId || edge.toId === selectedId)
    .flatMap((edge) => [edge.fromId, edge.toId])), [map.edges, selectedId]);

  useEffect(() => {
    // Scroll only this pane. The code pane scrolls itself to the same change,
    // and a `scrollIntoView` here would drag every ancestor along with it.
    const pane = body.current;
    const row = selectedId === null ? undefined : rows.get(selectedId);
    if (!pane || row === undefined) return;
    const furthest = Math.max(0, pane.scrollHeight - pane.clientHeight);
    const top = Math.min(furthest, Math.max(0, row * ROW - (pane.clientHeight - NODE_HEIGHT) / 2));
    pane.scrollTo?.({ top, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // The node is usually already in view, so the scroll above is often a no-op
    // and the press would otherwise leave no trace. Same restart idiom as the
    // code pane, so both halves of the card acknowledge the same press.
    // Matched by reading the attribute rather than by an attribute selector: a
    // decision id carries the hunk header, so it holds spaces and braces that
    // do not survive being embedded in a selector.
    const node = [...pane.querySelectorAll<HTMLElement>(`[${REVIEW_CANVAS_NODE_ATTRIBUTE}]`)]
      .find((candidate) => candidate.getAttribute(REVIEW_CANVAS_NODE_ATTRIBUTE) === selectedId);
    if (node) {
      node.classList.remove('handle-pulse');
      void node.offsetWidth;
      node.classList.add('handle-pulse');
    }
  }, [rows, selectedId, selectionTick]);

  const height = Math.max(0, map.nodes.length * ROW - NODE_GAP);

  return <section className="review-canvas" aria-label="Change canvas">
    <header>
      <h4>Canvas</h4>
      <p>{map.nodes.length} {map.nodes.length === 1 ? 'change' : 'changes'}</p>
    </header>
    <div className="review-canvas-body" ref={body}>
      <div className="review-canvas-stage" style={{ height }}>
        <svg className="review-canvas-edges" width={LANE_WIDTH} height={height} aria-hidden="true">
          {edges.map((edge) => <path key={edge.id} className={`review-canvas-edge${edge.touches ? ' is-touching' : ''}`} d={edge.d} />)}
        </svg>
        {map.nodes.map((node, index) => {
          const settledAs = handled?.get(node.id) ?? null;
          return <button
          key={node.id}
          type="button"
          {...{ [REVIEW_CANVAS_NODE_ATTRIBUTE]: node.id }}
          className={`review-canvas-node state-${node.state ?? 'pending'}${node.id === selectedId ? ' is-active' : ''}${node.id !== selectedId && linked.has(node.id) ? ' is-linked' : ''}${settledAs ? ' is-handled' : ''}`}
          style={{ top: index * ROW, height: NODE_HEIGHT }}
          aria-current={node.id === selectedId}
          aria-haspopup="dialog"
          aria-expanded={openDetailFor === node.id}
          aria-label={`Change ${node.ordinal}: ${node.behavior} in ${node.filePath} — ${settledAs ? `${settledAs} · ` : ''}open decision details`}
          onClick={(event) => onSelect(node.id, event.currentTarget)}
        >
          <span className="review-canvas-node-head"><b>{node.ordinal}</b><code>{fileTail(node.filePath)}</code></span>
          <span className="review-canvas-node-behavior">{node.behavior}</span>
          <span className="review-canvas-node-meta"><i>+{node.additions}</i><i>−{node.deletions}</i>{settledAs ? <em>{settledAs}</em> : node.state && <em>{node.state}</em>}</span>
        </button>;
        })}
      </div>
    </div>
  </section>;
});
