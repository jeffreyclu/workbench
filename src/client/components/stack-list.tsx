import type { ReactNode, RefObject, UIEvent } from 'react';

/**
 * The one stack container for every stack — task queue and conversation rail
 * alike. Scroll behaviour, flex sizing and the edge padding that frames the
 * rows live here (and in the single `.stack-list` rule) so the two stacks
 * cannot drift apart again the way they did when each owned its own container.
 */
export function StackList({ scrollRef, className, role, ariaLabel, onScroll, children }: {
  scrollRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  role?: string;
  ariaLabel?: string;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div ref={scrollRef} className={['stack-list', className].filter(Boolean).join(' ')} role={role} aria-label={ariaLabel} onScroll={onScroll}>
      {children}
    </div>
  );
}
