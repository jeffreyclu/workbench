import type { Activity, WorkItem } from '../../shared/contracts.js';
import { describeLifecycleChange } from '../activity-log.js';
import type { WorkbenchDatabase } from '../database.js';
import type { WorkItemRepository as WorkItemTableRepository } from '../repositories/work-item-repository.js';
import type { UnitOfWork } from '../unit-of-work.js';

export interface LifecycleContext {
  actor?: Activity['actor'];
  reason?: string;
}

export interface WorkItemLifecycleCollaborators {
  get(id: string): WorkItem | null;
  addActivity(workItemId: string, actor: Activity['actor'], kind: string, body: string): Activity;
  recordLifecycleEvent(input: {
    workItemId: string; transition: string; fromStatus: WorkItem['status'] | null; toStatus: WorkItem['status'];
    isInitial: boolean; actor: Activity['actor']; source: string; reason?: string; occurredAt: string;
  }): void;
  list(): WorkItem[];
  listWorkbench(): WorkItem[];
  reorder(orderedItemIds: string[], stack?: 'attention' | 'workbench'): WorkItem[];
}

/**
 * Owns work-item lifecycle operations that atomically span the work-item row,
 * linked conversations, lifecycle events, queue position, and activity log.
 * Row-level `work_items` persistence remains in WorkItemTableRepository.
 */
export class WorkItemService {
  constructor(
    private readonly database: WorkbenchDatabase,
    private readonly unitOfWork: UnitOfWork,
    private readonly workItems: WorkItemTableRepository,
    private readonly collaborators: WorkItemLifecycleCollaborators,
  ) {}

  archive(id: string, completed: boolean, withinTransaction = false, context: LifecycleContext = {}): WorkItem | null {
    void withinTransaction;
    const item = this.collaborators.get(id);
    if (!item) return null;
    if (item.archivedAt && completed === (item.completionStatus === 'completed')) return item;
    const now = new Date().toISOString();
    return this.unitOfWork.transaction(() => {
      this.workItems.setArchived(id, { archivedAt: now, completedAt: completed ? now : null, status: completed ? 'done' : item.status, updatedAt: now });
      this.database.prepare(`UPDATE shared_conversations SET archived_at = ?, updated_at = ?
        WHERE archived_at IS NULL AND (work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL))`).run(now, now, id, id);
      this.collaborators.recordLifecycleEvent({
        workItemId: id, transition: completed ? 'completed' : 'archived', fromStatus: item.status,
        toStatus: completed ? 'done' : item.status, isInitial: false, actor: context.actor ?? 'system',
        source: 'lifecycle_action', reason: context.reason, occurredAt: now,
      });
      this.collaborators.addActivity(id, context.actor ?? 'system', completed ? 'completed' : 'archived', describeLifecycleChange(completed ? 'complete' : 'archive', context.reason));
      return this.collaborators.get(id);
    });
  }

  restore(id: string, withinTransaction = false, context: LifecycleContext = {}): WorkItem | null {
    const item = this.collaborators.get(id);
    if (!item || !item.archivedAt) return item;
    const now = new Date().toISOString();
    const status = item.status === 'done' || item.status === 'canceled' ? 'ready' : item.status;
    return this.unitOfWork.transaction(() => {
      this.workItems.setRestored(id, { status, updatedAt: now });
      this.database.prepare(`UPDATE shared_conversations SET archived_at = NULL, updated_at = ?
        WHERE work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL)`).run(now, id, id);
      this.collaborators.recordLifecycleEvent({
        workItemId: id, transition: 'restored', fromStatus: item.status, toStatus: status, isInitial: false,
        actor: context.actor ?? 'system', source: 'lifecycle_action', reason: context.reason, occurredAt: now,
      });
      // Bulk restore owns the final positioning and activity entries for all of
      // its items. Preserve that public-method contract while still composing
      // its row writes in this shared unit of work.
      if (withinTransaction) return this.collaborators.get(id);
      const stackItems = item.stack === 'workbench' ? this.collaborators.listWorkbench() : this.collaborators.list();
      this.collaborators.reorder([id, ...stackItems.map((entry) => entry.id).filter((entryId) => entryId !== id)], item.stack);
      this.collaborators.addActivity(id, context.actor ?? 'system', 'restored', describeLifecycleChange('restore', context.reason));
      return this.collaborators.get(id);
    });
  }

  delete(id: string): boolean {
    const now = new Date().toISOString();
    return this.unitOfWork.transaction(() => {
      const changed = this.workItems.softDelete(id, now);
      if (!changed) return false;
      this.database.prepare(`UPDATE shared_conversations SET deleted_at = ?, updated_at = ?
        WHERE deleted_at IS NULL AND (work_item_id = ? OR id IN (
          SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL
        ))`).run(now, now, id, id);
      return true;
    });
  }
}
