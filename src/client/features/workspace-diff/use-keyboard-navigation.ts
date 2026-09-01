import { useEffect } from 'react';
import type { ReviewDecision } from '../diff-review/logic.js';

function pendingDecisions(decisions: ReviewDecision[]) {
  return decisions.filter((decision) => decision.state === null);
}

/** Returns the next or previous decision which still needs a human verdict. */
export function adjacentPendingDecisionId(decisions: ReviewDecision[], currentId: string | null, direction: 1 | -1): string | null {
  const pending = pendingDecisions(decisions);
  if (pending.length === 0) return null;
  const currentIndex = pending.findIndex((decision) => decision.id === currentId);
  if (currentIndex === -1) return (direction === 1 ? pending[0] : pending[pending.length - 1])?.id ?? null;
  return pending[(currentIndex + direction + pending.length) % pending.length]?.id ?? null;
}

/** Returns the first pending decision in the adjacent changed file. */
export function adjacentFileDecisionId(decisions: ReviewDecision[], filePaths: string[], currentFilePath: string | null, direction: 1 | -1): string | null {
  if (filePaths.length === 0) return null;
  const currentIndex = filePaths.indexOf(currentFilePath ?? '');
  const startIndex = currentIndex === -1 ? (direction === 1 ? -1 : 0) : currentIndex;
  for (let offset = 1; offset <= filePaths.length; offset += 1) {
    const filePath = filePaths[(startIndex + direction * offset + filePaths.length) % filePaths.length];
    const decision = decisions.find((entry) => entry.state === null && entry.filePaths.includes(filePath));
    if (decision) return decision.id;
  }
  return null;
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

/** Owns Changes' document-level shortcuts without duplicating review state. */
export function useWorkspaceDiffKeyboardNavigation({
  decisions, filePaths, activeId, activeFilePath, canMarkReviewed, onSelect, onMarkReviewed,
}: {
  decisions: ReviewDecision[];
  filePaths: string[];
  activeId: string | null;
  activeFilePath: string | null;
  canMarkReviewed: boolean;
  onSelect: (id: string) => void;
  onMarkReviewed: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
      const decisionId = event.key === 'j' ? adjacentPendingDecisionId(decisions, activeId, 1)
        : event.key === 'k' ? adjacentPendingDecisionId(decisions, activeId, -1)
          : event.key === ']' ? adjacentFileDecisionId(decisions, filePaths, activeFilePath, 1)
            : event.key === '[' ? adjacentFileDecisionId(decisions, filePaths, activeFilePath, -1)
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
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeFilePath, activeId, canMarkReviewed, decisions, filePaths, onMarkReviewed, onSelect]);
}
