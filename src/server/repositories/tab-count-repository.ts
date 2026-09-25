import type { TabCounts, TaskStackGroupCounts } from '../../shared/contracts.js';
import type { UnitOfWork } from '../unit-of-work.js';
import { conversationViewScopes } from './conversation-repository.js';
import { workItemViewScopes } from './work-item-repository.js';

/**
 * Reads every tab count in one statement so the numbers come from a single
 * snapshot. Each count uses the same view clause as the list it labels, and
 * the stack sections split `active` by the same status rules the client uses
 * to group cards.
 */
export class TabCountRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  read(): TabCounts {
    const stack = (scope: string, prefix: string) => `
      (SELECT COUNT(*) FROM work_items WHERE ${scope} AND status = 'in_progress') AS ${prefix}_progress,
      (SELECT COUNT(*) FROM work_items WHERE ${scope} AND status = 'pinned') AS ${prefix}_pinned,
      (SELECT COUNT(*) FROM work_items WHERE ${scope} AND status NOT IN ('in_progress', 'pinned')) AS ${prefix}_attention`;
    const row = this.database.prepare(`SELECT
      ${stack(workItemViewScopes.active, 'attention')},
      ${stack(workItemViewScopes.workbench, 'workbench')},
      (SELECT COUNT(*) FROM work_items WHERE ${workItemViewScopes.archive}) AS attention_archive,
      (SELECT COUNT(*) FROM work_items WHERE ${workItemViewScopes['workbench-archive']}) AS workbench_archive,
      (SELECT COUNT(*) FROM shared_conversations WHERE ${conversationViewScopes.active}) AS conversations_active,
      (SELECT COUNT(*) FROM shared_conversations WHERE ${conversationViewScopes.archive}) AS conversations_archive
    `).get() as Record<string, number>;
    const groups = (prefix: string): TaskStackGroupCounts => ({
      progress: Number(row[`${prefix}_progress`]),
      attention: Number(row[`${prefix}_attention`]),
      pinned: Number(row[`${prefix}_pinned`]),
    });
    const attention = groups('attention');
    const workbench = groups('workbench');
    return {
      attention: { active: attention.progress + attention.attention + attention.pinned, archive: Number(row.attention_archive), groups: attention },
      workbench: { active: workbench.progress + workbench.attention + workbench.pinned, archive: Number(row.workbench_archive), groups: workbench },
      conversations: { active: Number(row.conversations_active), archive: Number(row.conversations_archive) },
    };
  }
}
