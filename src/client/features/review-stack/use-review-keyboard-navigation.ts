import { useEffect } from 'react';
import type { ReviewQueueEntry } from './review-queue.js';

function decisionEntries(queue: ReviewQueueEntry[]) {
  return queue.filter((entry) => !entry.routing.autoSettled && entry.decision.state === null);
}

/** Returns the next or previous block which still needs a human decision. */
export function adjacentDecisionId(queue: ReviewQueueEntry[], currentId: string | null, direction: 1 | -1): string | null {
  const entries = decisionEntries(queue);
  if (entries.length === 0) return null;
  const index = entries.findIndex((entry) => entry.decision.id === currentId);
  return entries[(index + direction + entries.length) % entries.length]?.decision.id ?? null;
}

/** Returns the first review block in the adjacent changed file, wrapping at either end. */
export function adjacentFileDecisionId(queue: ReviewQueueEntry[], currentFilePath: string | null, direction: 1 | -1): string | null {
  const filePaths = [...new Set(queue.flatMap((entry) => entry.decision.hunks.map((hunk) => hunk.filePath)))];
  if (filePaths.length === 0) return null;
  const index = filePaths.indexOf(currentFilePath ?? '');
  const path = filePaths[(index + direction + filePaths.length) % filePaths.length];
  return queue.find((entry) => entry.decision.hunks.some((hunk) => hunk.filePath === path) && !entry.routing.autoSettled)?.decision.id
    ?? queue.find((entry) => entry.decision.hunks.some((hunk) => hunk.filePath === path))?.decision.id
    ?? null;
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

/** Owns the Review stack's document-level shortcuts so the view stays declarative. */
export function useReviewKeyboardNavigation({
  queue, activeId, activeFilePath, canMarkReviewed, onSelect, onMarkReviewed, onToggleReadingMode, onToggleCode,
}: {
  queue: ReviewQueueEntry[];
  activeId: string | null;
  activeFilePath: string | null;
  canMarkReviewed: boolean;
  onSelect: (id: string) => void;
  onMarkReviewed: () => void;
  /** Switches the diff pane between the finished code and the unified diff. */
  onToggleReadingMode?: () => void;
  /** Opens or closes the code for the current block. The block leads with its
   * claim, so reading the code is a deliberate act rather than the default. */
  onToggleCode?: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
      const decisionId = event.key === 'j' ? adjacentDecisionId(queue, activeId, 1)
        : event.key === 'k' ? adjacentDecisionId(queue, activeId, -1)
          : event.key === ']' ? adjacentFileDecisionId(queue, activeFilePath, 1)
            : event.key === '[' ? adjacentFileDecisionId(queue, activeFilePath, -1)
              : null;
      if (decisionId) {
        event.preventDefault();
        onSelect(decisionId);
        return;
      }
      if (event.key === 'r' && canMarkReviewed) {
        event.preventDefault();
        onMarkReviewed();
        return;
      }
      if (event.key === 'd' && onToggleReadingMode) {
        event.preventDefault();
        onToggleReadingMode();
        return;
      }
      if (event.key === 'o' && onToggleCode) {
        event.preventDefault();
        onToggleCode();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeFilePath, activeId, canMarkReviewed, onMarkReviewed, onSelect, onToggleCode, onToggleReadingMode, queue]);
}
