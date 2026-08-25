import { randomUUID } from 'node:crypto';

import type { Activity, QueueItemExplanation, QueueOrderChange, QueueProposal, QueueSignalKey, WorkItem } from '../../shared/contracts.js';
import { learnFeedbackWeights, planQueue, type FeedbackWeight, type QueueContext, type QueuePlan } from '../queue-intelligence.js';
import type { WorkbenchDatabase } from '../database.js';
import type { UnitOfWork } from '../unit-of-work.js';
import type { QueueRepository } from '../repositories/queue-repository.js';
import type { WorkItemRepository as WorkItemTableRepository } from '../repositories/work-item-repository.js';

export interface QueuePlanningCollaborators {
  list(): WorkItem[];
  listWorkbench(): WorkItem[];
  addActivity(workItemId: string, actor: Activity['actor'], kind: string, body: string): Activity;
}

/**
 * Owns the single attention queue's ordering, undo history, and proposal
 * lifecycle. Row-level persistence for `queue_versions`, `queue_order_history`,
 * and `queue_proposals` stays in `QueueRepository`; this service owns the
 * multi-write transactions and the ordering/version invariants layered on top
 * of them. `list`/`listWorkbench`/`addActivity` stay on the work-item
 * repository (they pull in dependency, lineage, and agent-outcome enrichment
 * that reaches well beyond queue planning), so they're injected rather than
 * duplicated here.
 */
export class QueuePlanningService {
  constructor(
    private readonly database: WorkbenchDatabase,
    private readonly unitOfWork: UnitOfWork,
    private readonly queue: QueueRepository,
    private readonly workItems: WorkItemTableRepository,
    private readonly collaborators: QueuePlanningCollaborators,
    private readonly timeZone: string,
  ) {}

  reorder(orderedItemIds: string[], stack?: 'attention' | 'workbench', change?: { actor: QueueOrderChange['actor']; reason: string }): WorkItem[] {
    const targetStack = stack ?? 'attention';
    const stackItems = targetStack === 'workbench' ? this.collaborators.listWorkbench() : this.collaborators.list();
    const currentIds = stackItems.map((item) => item.id);
    if (currentIds.length !== orderedItemIds.length || !currentIds.every((id) => orderedItemIds.includes(id))) {
      throw new Error('Queue order must contain every active queued item exactly once.');
    }
    const apply = () => {
      const now = new Date().toISOString();
      // There is one persisted order. Workbench is a filtered slice of it, so
      // reseat its IDs at their existing canonical slots instead of treating a
      // three-item Workbench drag as a replacement for every active task.
      let workbenchIndex = 0;
      const workbenchIds = new Set(orderedItemIds);
      const persistedIds = targetStack === 'workbench'
        ? this.collaborators.list().map((item) => item.id).map((id) => workbenchIds.has(id) ? orderedItemIds[workbenchIndex++]! : id)
        : orderedItemIds;
      this.workItems.setQueuePositions(persistedIds, now);
      // Movements are journalled so any of them can be undone, not just the ones
      // that arrived as a proposal. Reorders that merely re-seat a task the caller
      // just added or restored pass no `change` and are deliberately not journalled:
      // their snapshot describes a different set of tasks, so replaying it would
      // drop or resurrect work. No-ops are skipped so undo always lands on a change
      // Jeffrey would actually notice.
      if (change && currentIds.some((id, index) => id !== orderedItemIds[index])) {
        this.queue.insertOrderHistory({ stack: targetStack, actor: change.actor, reason: change.reason, previousOrder: currentIds, newOrder: orderedItemIds, createdAt: now });
      }
      this.queue.incrementVersion(targetStack);
      // A Workbench change also changes the canonical sequence used by an
      // attention proposal, so invalidate that proposal's optimistic version.
      if (targetStack === 'workbench') this.queue.incrementVersion('attention');
    };
    this.unitOfWork.transaction(apply);
    return targetStack === 'workbench' ? this.collaborators.listWorkbench() : this.collaborators.list();
  }

  listQueueHistory(stack: 'attention' | 'workbench' = 'attention', limit = 20): QueueOrderChange[] {
    return this.queue.listOrderHistory(stack, limit);
  }

  /**
   * Reverses the most recent ordering change that still describes today's stack.
   * Entries whose snapshot no longer matches (a task was added, completed, or
   * archived since) are skipped rather than force-applied, because replaying a
   * stale snapshot would silently drop or resurrect tasks.
   */
  undoLastQueueChange(stack: 'attention' | 'workbench' = 'attention'): { change: QueueOrderChange; items: WorkItem[] } | null {
    const currentVersion = this.queue.getVersion(stack);
    const currentIds = (stack === 'workbench' ? this.collaborators.listWorkbench() : this.collaborators.list()).map((item) => item.id);
    const rows = this.queue.listUndoableHistory(stack);
    for (const change of rows) {
      // Version + exact-order checks prevent an undo from replaying an old
      // snapshot after any intervening queue mutation.
      const applicable = currentVersion > 0 && change.newOrder.length === currentIds.length && change.newOrder.every((id, index) => id === currentIds[index]);
      if (!applicable) continue;
      return this.unitOfWork.transaction(() => {
        // Re-read under the writer lock; another connection may have changed
        // the queue since the optimistic check above.
        if (this.queue.getVersion(stack) !== currentVersion) return null;
        const lockedIds = (stack === 'workbench' ? this.collaborators.listWorkbench() : this.collaborators.list()).map((item) => item.id);
        if (!change.newOrder.every((id, index) => id === lockedIds[index])) return null;
        const undoneAt = new Date().toISOString();
        const highWaterMark = this.queue.getHistoryHighWaterMark();
        this.queue.markHistoryUndone(change.id, undoneAt);
        this.queue.supersedePending(undoneAt, stack);
        const items = this.reorder(change.previousOrder, stack, { actor: 'jeffrey', reason: `Undo of: ${change.reason}` });
        this.queue.markHistoryUndoneAfter(highWaterMark, undoneAt);
        return { change: { ...change, undoneAt }, items };
      });
    }
    return null;
  }

  moveForAttention(id: string, destination: 'top' | 'bottom', reason: string): WorkItem[] {
    const stackItems = this.collaborators.list();
    const ids = stackItems.map((item) => item.id);
    if (!ids.includes(id) || ids.length < 2) return stackItems;
    const now = new Date().toISOString();
    this.queue.supersedePending(now);
    const without = ids.filter((itemId) => itemId !== id);
    this.reorder(destination === 'top' ? [id, ...without] : [...without, id], 'attention', { actor: 'agent', reason: `${destination === 'top' ? 'Promoted for attention' : 'Demoted while the agent works'}: ${reason}` });
    this.collaborators.addActivity(id, 'system', 'queue_moved', `${destination === 'top' ? 'Promoted for attention' : 'Demoted while the agent works'}: ${reason}`);
    return this.collaborators.list();
  }

  getPendingProposal(stack: 'attention' | 'workbench' = 'attention'): QueueProposal | null {
    return this.queue.getPendingProposal(stack);
  }

  createProposal(orderedItemIds: string[], rationale: string, explanations: QueueItemExplanation[] = []): QueueProposal {
    const canonicalStack = 'attention';
    const previousOrder = this.collaborators.list().map((item) => item.id);
    if (previousOrder.length !== orderedItemIds.length || !previousOrder.every((id) => orderedItemIds.includes(id))) {
      throw new Error('Proposal must contain every active queued item exactly once.');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.unitOfWork.transaction(() => {
      this.queue.supersedePending(now, canonicalStack);
      this.queue.insertProposal({ id, stack: canonicalStack, previousOrder, proposedOrder: orderedItemIds, rationale, explanations, queueVersion: this.queue.getVersion(canonicalStack), createdAt: now });
    });
    return this.getPendingProposal(canonicalStack)!;
  }

  /**
   * Gathers everything the ranking engine needs in a fixed number of queries.
   * Kept alongside proposal creation so `queue-intelligence.ts` stays pure and
   * testable.
   */
  buildQueueContext(now = Date.now()): QueueContext {
    const openChildren = new Map<string, number>();
    for (const row of this.database.prepare(`
      SELECT parent_work_item_id AS parent, COUNT(*) AS count FROM work_items
      WHERE parent_work_item_id IS NOT NULL AND archived_at IS NULL AND status NOT IN ('done', 'canceled')
      GROUP BY parent_work_item_id
    `).all() as Array<{ parent: string; count: number }>) openChildren.set(row.parent, Number(row.count));

    const activeRuns = new Map<string, number>();
    for (const row of this.database.prepare(`
      SELECT work_item_id AS id, COUNT(*) AS count FROM agent_runs
      WHERE status IN ('queued', 'running') GROUP BY work_item_id
    `).all() as Array<{ id: string; count: number }>) activeRuns.set(row.id, Number(row.count));

    // An item is treated as blocked in practice when its most recent narrative
    // activity is a blocker note that no later progress or decision resolved.
    const unresolvedBlockers = new Set<string>();
    for (const row of this.database.prepare(`
      SELECT work_item_id AS id, kind FROM activities
      WHERE kind IN ('blocker', 'progress', 'decision', 'handoff')
        AND created_at = (
          SELECT MAX(created_at) FROM activities inner_activities
          WHERE inner_activities.work_item_id = activities.work_item_id
            AND inner_activities.kind IN ('blocker', 'progress', 'decision', 'handoff')
        )
    `).all() as Array<{ id: string; kind: string }>) if (row.kind === 'blocker') unresolvedBlockers.add(row.id);

    // Only still-open dependents count: once a dependent is done or canceled,
    // finishing its blocker no longer unblocks anything, so the critical-path
    // promotion must decay on its own rather than linger on a stale edge.
    const openDependents = new Map<string, number>();
    for (const row of this.database.prepare(`
      SELECT dependency.blocker_work_item_id AS blocker, COUNT(*) AS count
      FROM work_item_dependencies dependency
      JOIN work_items dependent ON dependent.id = dependency.work_item_id
      WHERE dependent.deleted_at IS NULL AND dependent.archived_at IS NULL
        AND dependent.completed_at IS NULL AND dependent.status NOT IN ('done', 'canceled')
      GROUP BY dependency.blocker_work_item_id
    `).all() as Array<{ blocker: string; count: number }>) openDependents.set(row.blocker, Number(row.count));

    // "Since the last plan" is the window that makes source movement meaningful:
    // anything older was already visible when the previous order was agreed.
    const since = this.queue.getLastProposalCreatedAt() ?? new Date(now - 86_400_000).toISOString();
    const sourceChanges = new Map<string, string>();
    for (const row of this.database.prepare('SELECT id, source FROM work_items WHERE provider_updated_at IS NOT NULL AND provider_updated_at > ? AND is_queued = 1').all(since) as Array<{ id: string; source: string }>) {
      sourceChanges.set(row.id, `its ${row.source} source changed since the last plan`);
    }
    for (const row of this.database.prepare("SELECT work_item_id AS id, provider FROM discovery_candidates WHERE work_item_id IS NOT NULL AND updated_at > ? AND status IN ('converted', 'merged')").all(since) as Array<{ id: string; provider: string }>) {
      sourceChanges.set(row.id, `new ${row.provider} activity landed since the last plan`);
    }

    return { now, openChildren, openDependents, activeRuns, unresolvedBlockers, sourceChanges, feedback: this.getQueueFeedbackWeights(), timeZone: this.timeZone };
  }

  /** Weights learned from the proposals Jeffrey accepted or rejected. */
  getQueueFeedbackWeights(limit = 20): Map<QueueSignalKey, FeedbackWeight> {
    const rows = this.queue.listResolvedProposalsForFeedback(limit);
    return learnFeedbackWeights(rows.flatMap((row) => {
      try { return [{ status: row.status, explanations: JSON.parse(row.explanationsJson) as QueueItemExplanation[] }]; }
      catch { return []; }
    }));
  }

  /** Ranks the current stack without touching it. Backs the "why this order" view. */
  explainQueue(now = Date.now()): QueuePlan {
    return planQueue(this.collaborators.list(), this.buildQueueContext(now));
  }

  buildDailyProposal(now = Date.now()): QueueProposal {
    const items = this.collaborators.list();
    if (!items.length) throw new Error('Add at least one task before planning the stack.');
    const plan = planQueue(items, this.buildQueueContext(now));
    return this.createProposal(plan.orderedItemIds, plan.rationale, plan.explanations);
  }

  resolveProposal(id: string, resolution: 'accepted' | 'rejected'): QueueProposal | null {
    const pending = this.queue.getPendingProposalWithVersion(id);
    if (!pending) return null;
    const { proposal, queueVersion: proposalVersion } = pending;
    return this.unitOfWork.transaction(() => {
      // Both choices are version-guarded. A stale reject has no queue side
      // effect, and a stale accept cannot overwrite a manual reorder.
      if (this.queue.getVersion(proposal.stack) !== proposalVersion) {
        const resolvedAt = new Date().toISOString();
        this.queue.markProposalStatus(id, 'superseded', resolvedAt);
        return { ...proposal, status: 'superseded', resolvedAt };
      }
      if (resolution === 'accepted') this.reorder(proposal.proposedOrder, proposal.stack, { actor: 'agent', reason: `Accepted the ${proposal.stack} stack proposal.` });
      const resolvedAt = new Date().toISOString();
      this.queue.markProposalStatus(id, resolution, resolvedAt);
      return { ...proposal, status: resolution, resolvedAt };
    });
  }
}
