import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_WIDTH = 336;
const VIEWPORT_MARGIN = 12;

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
export function DecisionPopover({ anchor, anchorId, labelledBy, onClose, children }: {
  anchor: HTMLElement;
  /** The decision whose gutter marker opened this. Used to re-find a live
   * marker when the original element is gone; see `liveAnchor`. */
  anchorId?: string | null;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, width: POPOVER_WIDTH, visibility: 'hidden' });

  /** The element to measure against, re-resolved on every placement rather than
   * captured once. Selecting a decision can re-render the diff pane and unmount
   * the clicked button, and a detached node measures as a zero rect at the
   * origin — which reads as "the panel opened in the corner, attached to
   * nothing". A live marker for the same decision is the right anchor then, and
   * when there is none the panel still opens, just centred. */
  const liveAnchor = (): HTMLElement | null => {
    if (anchor.isConnected) return anchor;
    if (!anchorId) return null;
    return document.querySelector<HTMLElement>(`[data-decision-marker="${CSS.escape(anchorId)}"]`);
  };

  useLayoutEffect(() => {
    const place = () => {
      const element = panel.current;
      if (!element) return;
      const target = liveAnchor();
      if (!target) {
        setStyle({ position: 'fixed', top: VIEWPORT_MARGIN, left: Math.max(VIEWPORT_MARGIN, (window.innerWidth - POPOVER_WIDTH) / 2), width: POPOVER_WIDTH, visibility: 'visible' });
        return;
      }
      const rect = target.getBoundingClientRect();
      // Anchored off the marker's right edge, flipping to its left when the
      // viewport cannot hold the panel there.
      const spaceRight = window.innerWidth - rect.right - VIEWPORT_MARGIN;
      const left = spaceRight >= POPOVER_WIDTH
        ? rect.right + 10
        : Math.max(VIEWPORT_MARGIN, rect.left - POPOVER_WIDTH - 10);
      const height = element.offsetHeight;
      const top = Math.max(VIEWPORT_MARGIN, Math.min(rect.top, window.innerHeight - VIEWPORT_MARGIN - height));
      setStyle({ position: 'fixed', top, left, width: POPOVER_WIDTH, visibility: 'visible' });
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
  }, [anchor, anchorId]);

  useEffect(() => {
    panel.current?.focus?.({ preventScroll: true });
    return () => {
      // Only take focus back if it is still inside the panel being unmounted —
      // selecting another decision should not yank focus off its new target.
      if (document.activeElement === document.body || panel.current?.contains(document.activeElement)) liveAnchor()?.focus?.({ preventScroll: true });
    };
  }, [anchor, anchorId]);

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
  }, [anchor, anchorId, onClose]);

  return createPortal(
    <div ref={panel} className="decision-popover" role="dialog" aria-labelledby={labelledBy} tabIndex={-1} style={style}>
      {children}
    </div>,
    document.body,
  );
}
