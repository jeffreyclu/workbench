import type { ConsolidationProposalItem } from '../../../shared/contracts';

export type KeepItem = Extract<ConsolidationProposalItem, { verdict: 'keep' }>;
export type ActionableItem = Exclude<ConsolidationProposalItem, KeepItem>;

/** Splits a proposal into the items that need a decision and the keeps that change nothing. */
export function summarizeConsolidation(items: ConsolidationProposalItem[]) {
  const actionable: ActionableItem[] = [];
  const keeps: KeepItem[] = [];
  for (const item of items) {
    if (item.verdict === 'keep') keeps.push(item);
    else actionable.push(item);
  }
  const archiveCount = actionable.filter((item) => item.verdict === 'archive_then_remove').length;
  return { actionable, keeps, archiveCount, promoteCount: actionable.length - archiveCount, total: items.length };
}
