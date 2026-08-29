import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_WIDTH = 336;
const ASIDE_WIDTH = 306;
const ASIDE_GAP = 10;
const VIEWPORT_MARGIN = 12;
/** Below this the panel, the diagram and the viewport margins cannot sit in a
 * row, so the pair stacks instead of being squeezed to an unreadable width or
 * pushed off a phone screen. */
const STACK_BREAKPOINT = POPOVER_WIDTH + ASIDE_GAP + ASIDE_WIDTH + VIEWPORT_MARGIN * 2;

export type DecisionPopoverAnchor = HTMLElement | SVGElement;

/**
 * The decision detail, anchored to the gutter marker that opened it.
 *
 * It renders through a portal on purpose: `.diff-review-file-diff-body` is a
 * scroll container with `overflow: auto`, so a panel rendered inside the block
 * would be clipped at the pane edge. Fixed positioning recomputed from the
 * anchor's rect keeps it beside its marker while the diff scrolls under it.
 *
 * Not a modal — the whole point is to read the detail against the code behind
 * it — so focus moves in but is not trapped, and dismissal returns focus to the
 * marker so keyboard review continues where it left off.
 */
export function DecisionPopover({ anchor, anchorId, anchorAttribute = 'data-decision-marker', labelledBy, aside, onClose, children }: {
  /** Either handle that opens this panel: a gutter marker (HTML) or a change
   * map node (SVG). Both measure and focus the same way. */
  anchor: DecisionPopoverAnchor;
  /** The decision whose handle opened this. Used to re-find a live handle when
   * the original element is gone; see `liveAnchor`. */
  anchorId?: string | null;
  /** Which handle to re-find by. A decision has one marker per surface, so the
   * surface that opened the panel is the one that must keep anchoring it —
   * re-finding the gutter marker for a panel opened from the map would jump it
   * across the page. */
  anchorAttribute?: string;
  labelledBy: string;
  /** Companion content pinned to the panel's right edge — the diagram of what
   * this decision relates to. It is placed as part of the panel, not beside
   * it, so the pair is measured and flipped as one unit and the diagram can
   * never be pushed off screen on its own. On a viewport too narrow for a row
   * it stacks under the decision instead. */
  aside?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const hasAside = Boolean(aside);
  /** Measured on every placement rather than fixed at mount, so rotating a
   * phone crosses the breakpoint without the panel having to close and reopen.
   * Narrow viewports stack the diagram under the decision and clamp the panel
   * to the screen; wide ones reserve both columns as before. */
  const measure = () => {
    const stacked = hasAside && window.innerWidth < STACK_BREAKPOINT;
    const columns = hasAside && !stacked ? POPOVER_WIDTH + ASIDE_GAP + ASIDE_WIDTH : POPOVER_WIDTH;
    return { stacked, width: Math.min(columns, window.innerWidth - VIEWPORT_MARGIN * 2) };
  };
  const [stacked, setStacked] = useState(() => measure().stacked);
  const [style, setStyle] = useState<CSSProperties>(() => ({ position: 'fixed', top: 0, left: 0, width: measure().width, visibility: 'hidden' }));

  /** The element to measure against, re-resolved on every placement rather than
   * captured once. Selecting a decision can re-render the diff pane and unmount
   * the clicked button, and a detached node measures as a zero rect at the
   * origin — which reads as "the panel opened in the corner, attached to
   * nothing". A live marker for the same decision is the right anchor then, and
   * when there is none the panel still opens, just centred. */
  const liveAnchor = (): DecisionPopoverAnchor | null => {
    if (anchor.isConnected) return anchor;
    if (!anchorId) return null;
    return document.querySelector<DecisionPopoverAnchor>(`[${anchorAttribute}="${CSS.escape(anchorId)}"]`);
  };

  useLayoutEffect(() => {
    const place = () => {
      const element = panel.current;
      if (!element) return;
      const { stacked: nextStacked, width } = measure();
      setStacked(nextStacked);
      const target = liveAnchor();
      if (!target) {
        setStyle({ position: 'fixed', top: VIEWPORT_MARGIN, left: Math.max(VIEWPORT_MARGIN, (window.innerWidth - width) / 2), width, visibility: 'visible' });
        return;
      }
      const rect = target.getBoundingClientRect();
      // Anchored off the marker's right edge, flipping to its left when the
      // viewport cannot hold the panel there.
      const spaceRight = window.innerWidth - rect.right - VIEWPORT_MARGIN;
      const left = spaceRight >= width
        ? rect.right + 10
        : Math.max(VIEWPORT_MARGIN, rect.left - width - 10);
      const height = element.offsetHeight;
      const top = Math.max(VIEWPORT_MARGIN, Math.min(rect.top, window.innerHeight - VIEWPORT_MARGIN - height));
      setStyle({ position: 'fixed', top, left, width, visibility: 'visible' });
    };
    place();
    // The anchor moves with the diff scroller, not the window, so scroll is
    // observed in the capture phase to catch every ancestor that can move it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [anchor, anchorId, anchorAttribute, hasAside]);

  useEffect(() => {
    panel.current?.focus?.({ preventScroll: true });
    return () => {
      // Only take focus back if it is still inside the panel being unmounted —
      // selecting another decision should not yank focus off its new target.
      if (document.activeElement === document.body || panel.current?.contains(document.activeElement)) liveAnchor()?.focus?.({ preventScroll: true });
    };
  }, [anchor, anchorId, anchorAttribute]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || liveAnchor()?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [anchor, anchorId, anchorAttribute, onClose]);

  return createPortal(
    <div ref={panel} className={`decision-popover${hasAside ? ' with-aside' : ''}${stacked ? ' stacked' : ''}`} role="dialog" aria-labelledby={labelledBy} tabIndex={-1} style={style}>
      {hasAside ? <>
        <div className="decision-popover-panel">{children}</div>
        <div className="decision-popover-aside">{aside}</div>
      </> : children}
    </div>,
    document.body,
  );
}
