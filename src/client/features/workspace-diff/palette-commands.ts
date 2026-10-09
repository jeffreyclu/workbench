import type { WorkspaceDiffFile } from '../../../shared/contracts';
import type { PaletteCommand } from '../command-palette';
import type { ReviewDecision } from '../diff-review/logic.js';
import { adjacentFileDecisionId, adjacentPendingDecisionId } from './use-keyboard-navigation.js';

/** The decision a file switch should land on: what still needs a verdict first. */
export function decisionIdForFile(decisions: ReviewDecision[], path: string): string | null {
  const touching = decisions.filter((decision) => decision.filePaths.includes(path));
  return (touching.find((decision) => decision.state === null) ?? touching[0])?.id ?? null;
}

interface ReviewPaletteInput {
  files: WorkspaceDiffFile[];
  decisions: ReviewDecision[];
  activeId: string | null;
  activeFilePath: string | null;
  canMarkReviewed: boolean;
  onSelect: (decisionId: string) => void;
  onMarkReviewed: () => void;
  onToggleReadingMode: () => void;
  onCollapseAll?: () => void;
  onExpandAll?: () => void;
  /** Copies a link to the file being read. */
  onCopyLink?: () => void;
}

/**
 * What the palette offers while a changeset is open: a command per changed file
 * (the quick file switcher) and the review actions the keyboard shortcuts
 * already expose. Both go through the same selection path as the Changes
 * controls, so the palette cannot disagree with them.
 */
export function reviewPaletteCommands({ files, decisions, activeId, activeFilePath, canMarkReviewed, onSelect, onMarkReviewed, onToggleReadingMode, onCollapseAll, onExpandAll, onCopyLink }: ReviewPaletteInput): PaletteCommand[] {
  const filePaths = files.map((file) => file.path);
  const fileCommands = files.flatMap((file): PaletteCommand[] => {
    const decisionId = decisionIdForFile(decisions, file.path);
    if (!decisionId) return [];
    return [{
      id: `file:${file.path}`,
      group: 'Files',
      label: file.path,
      detail: `+${file.additions} −${file.deletions}`,
      keywords: file.previousPath ?? undefined,
      run: () => onSelect(decisionId),
    }];
  });
  const stepTo = (id: string | null) => () => { if (id) onSelect(id); };
  const nextPending = adjacentPendingDecisionId(decisions, activeId, 1);
  const previousPending = adjacentPendingDecisionId(decisions, activeId, -1);
  const nextFile = adjacentFileDecisionId(decisions, filePaths, activeFilePath, 1);
  const previousFile = adjacentFileDecisionId(decisions, filePaths, activeFilePath, -1);
  const actions: PaletteCommand[] = [
    ...(nextPending ? [{ id: 'review:next-pending', group: 'Review' as const, label: 'Next pending decision', shortcut: 'J', run: stepTo(nextPending) }] : []),
    ...(previousPending ? [{ id: 'review:previous-pending', group: 'Review' as const, label: 'Previous pending decision', shortcut: 'K', run: stepTo(previousPending) }] : []),
    ...(nextFile ? [{ id: 'review:next-file', group: 'Review' as const, label: 'Next changed file', shortcut: ']', run: stepTo(nextFile) }] : []),
    ...(previousFile ? [{ id: 'review:previous-file', group: 'Review' as const, label: 'Previous changed file', shortcut: '[', run: stepTo(previousFile) }] : []),
    ...(canMarkReviewed ? [{ id: 'review:mark-reviewed', group: 'Review' as const, label: 'Mark current decision reviewed', shortcut: 'R', run: onMarkReviewed }] : []),
    { id: 'review:reading-mode', group: 'Review', label: 'Change diff reading mode', keywords: 'split unified final whole file', shortcut: 'D', run: onToggleReadingMode },
    ...(onCollapseAll ? [{ id: 'review:collapse-all', group: 'Review' as const, label: 'Collapse all hunks', keywords: 'fold files', run: onCollapseAll }] : []),
    ...(onExpandAll ? [{ id: 'review:expand-all', group: 'Review' as const, label: 'Expand all hunks', keywords: 'unfold files', run: onExpandAll }] : []),
    ...(onCopyLink ? [{ id: 'review:copy-link', group: 'Review' as const, label: 'Copy link to this file', keywords: 'permalink share url', run: onCopyLink }] : []),
  ];
  return [...actions, ...fileCommands];
}
