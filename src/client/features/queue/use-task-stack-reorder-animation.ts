import { useLayoutEffect, useRef, type RefObject } from 'react';

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function hasTaskOrderChanged(previousIds: readonly string[], nextIds: readonly string[]) {
  return previousIds.length === nextIds.length
    && previousIds.some((id, index) => id !== nextIds[index])
    && previousIds.every((id) => nextIds.includes(id));
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.(MOTION_QUERY).matches;
}

/** Animates server-driven rank changes without participating in dnd-kit drag motion. */
export function useTaskStackReorderAnimation(
  containerRef: RefObject<HTMLElement | null>,
  itemIds: readonly string[],
  skipNextReorderRef: RefObject<boolean>,
  scopeKey: string,
) {
  const previousIds = useRef<string[]>([]);
  const previousRects = useRef(new Map<string, DOMRect>());
  const previousScopeKey = useRef(scopeKey);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (previousScopeKey.current !== scopeKey) {
      previousScopeKey.current = scopeKey;
      previousIds.current = [];
      previousRects.current = new Map();
    }

    const cards = new Map<string, HTMLElement>();
    for (const card of container.querySelectorAll<HTMLElement>('[data-work-item-id]')) {
      const id = card.dataset.workItemId;
      if (id) cards.set(id, card);
    }
    const changed = hasTaskOrderChanged(previousIds.current, itemIds);
    const skipAnimation = skipNextReorderRef.current;

    if (changed && skipAnimation) skipNextReorderRef.current = false;
    if (changed && !skipAnimation && !prefersReducedMotion()) {
      for (const id of itemIds) {
        const card = cards.get(id);
        const before = previousRects.current.get(id);
        if (!card || !before) continue;
        const deltaY = before.top - card.getBoundingClientRect().top;
        if (Math.abs(deltaY) < 1) continue;
        card.animate(
          [{ transform: `translate3d(0, ${deltaY}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' },
        );
      }
    }

    previousIds.current = [...itemIds];
    previousRects.current = new Map([...cards].map(([id, card]) => [id, card.getBoundingClientRect()]));
  }, [containerRef, itemIds, skipNextReorderRef, scopeKey]);
}
