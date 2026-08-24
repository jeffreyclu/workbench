import { randomUUID } from 'node:crypto';

import type { QueueItemExplanation, QueueOrderChange, QueueProposal } from '../../shared/contracts.js';
import type { UnitOfWork } from '../unit-of-work.js';

function mapQueueOrderChange(row: Record<string, string | null>): QueueOrderChange {
  return {
    id: row.id!, stack: row.stack as QueueOrderChange['stack'], actor: row.actor as QueueOrderChange['actor'],
    reason: row.reason ?? '', previousOrder: JSON.parse(row.previous_order_json!) as string[],
    newOrder: JSON.parse(row.new_order_json!) as string[], createdAt: row.created_at!, undoneAt: row.undone_at,
  };
}

function mapProposal(row: Record<string, string | null>): QueueProposal {
  return {
    id: row.id!, status: row.status as QueueProposal['status'],
    stack: (row.stack as QueueProposal['stack']) ?? 'attention',
    previousOrder: JSON.parse(row.previous_order_json!) as string[],
    proposedOrder: JSON.parse(row.proposed_order_json!) as string[], rationale: row.rationale!,
    explanations: row.explanations_json ? JSON.parse(row.explanations_json) as QueueItemExplanation[] : [],
    createdAt: row.created_at!, resolvedAt: row.resolved_at,
  };
}

/**
 * Owns the `queue_versions`, `queue_order_history`, and `queue_proposals`
 * tables' row-level CRUD. The actual queue order lives on `work_items.
 * queue_position`, which is a work-item concern, so `reorder`'s write to that
 * column, activity logging, and proposal-acceptance side effects that reorder
 * the stack all stay in `WorkItemRepository`, calling back into the
 * primitives here inside its own `UnitOfWork` transaction. Ranking
 * (`queue-intelligence.ts`) and feedback-weight learning also stay outside
 * this repository, which only returns the raw rows they are learned from.
 */
export class QueueRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  getVersion(stack: 'attention' | 'workbench'): number {
    return Number((this.database.prepare('SELECT version FROM queue_versions WHERE stack = ?').get(stack) as { version: number } | undefined)?.version ?? 0);
  }

  incrementVersion(stack: 'attention' | 'workbench'): void {
    this.database.prepare('INSERT INTO queue_versions (stack, version) VALUES (?, 1) ON CONFLICT(stack) DO UPDATE SET version = version + 1').run(stack);
  }

  insertOrderHistory(input: { stack: 'attention' | 'workbench'; actor: QueueOrderChange['actor']; reason: string; previousOrder: string[]; newOrder: string[]; createdAt: string }): void {
    this.database.prepare(`
      INSERT INTO queue_order_history (id, stack, actor, reason, previous_order_json, new_order_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), input.stack, input.actor, input.reason, JSON.stringify(input.previousOrder), JSON.stringify(input.newOrder), input.createdAt);
  }

  listOrderHistory(stack: 'attention' | 'workbench', limit: number): QueueOrderChange[] {
    const rows = this.database.prepare('SELECT * FROM queue_order_history WHERE stack = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(stack, Math.max(1, Math.min(100, limit))) as Array<Record<string, string | null>>;
    return rows.map(mapQueueOrderChange);
  }

  /** Undoable (not-yet-undone) history entries, most recent first, capped at 25 for the undo scan. */
  listUndoableHistory(stack: 'attention' | 'workbench'): QueueOrderChange[] {
    const rows = this.database.prepare('SELECT * FROM queue_order_history WHERE stack = ? AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 25')
      .all(stack) as Array<Record<string, string | null>>;
    return rows.map(mapQueueOrderChange);
  }

  /** Highest `rowid` currently in the table, used to fence off history rows written by the undo's own replay reorder. */
  getHistoryHighWaterMark(): number {
    return Number((this.database.prepare('SELECT COALESCE(MAX(rowid), 0) AS mark FROM queue_order_history').get() as { mark: number }).mark);
  }

  markHistoryUndone(id: string, undoneAt: string): void {
    this.database.prepare('UPDATE queue_order_history SET undone_at = ? WHERE id = ? AND undone_at IS NULL').run(undoneAt, id);
  }

  /** Marks every history row written after `afterRowid` as undone, fencing off the replay reorder's own journal entry. */
  markHistoryUndoneAfter(afterRowid: number, undoneAt: string): void {
    this.database.prepare('UPDATE queue_order_history SET undone_at = ? WHERE rowid > ? AND undone_at IS NULL').run(undoneAt, afterRowid);
  }

  getPendingProposal(stack: 'attention' | 'workbench'): QueueProposal | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE status = 'pending' AND stack = ? ORDER BY created_at DESC LIMIT 1").get(stack) as Record<string, string | null> | undefined;
    return row ? mapProposal(row) : null;
  }

  /** The pending proposal for `id`, plus the queue version it was created against, for the accept/reject staleness check. */
  getPendingProposalWithVersion(id: string): { proposal: QueueProposal; queueVersion: number } | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE id = ? AND status = 'pending'").get(id) as Record<string, string | null> | undefined;
    return row ? { proposal: mapProposal(row), queueVersion: Number(row.queue_version ?? 0) } : null;
  }

  /** Supersedes pending proposals, optionally scoped to one stack (unscoped when `stack` is omitted). */
  supersedePending(resolvedAt: string, stack?: 'attention' | 'workbench'): void {
    if (stack) this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending' AND stack = ?").run(resolvedAt, stack);
    else this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending'").run(resolvedAt);
  }

  insertProposal(input: { id: string; stack: 'attention' | 'workbench'; previousOrder: string[]; proposedOrder: string[]; rationale: string; explanations: QueueItemExplanation[]; queueVersion: number; createdAt: string }): void {
    this.database.prepare(`
      INSERT INTO queue_proposals (id, stack, status, previous_order_json, proposed_order_json, rationale, explanations_json, queue_version, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.stack, JSON.stringify(input.previousOrder), JSON.stringify(input.proposedOrder), input.rationale, JSON.stringify(input.explanations), input.queueVersion, input.createdAt);
  }

  markProposalStatus(id: string, status: 'accepted' | 'rejected' | 'superseded', resolvedAt: string): boolean {
    return Number(this.database.prepare("UPDATE queue_proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(status, resolvedAt, id).changes) > 0;
  }

  /** `created_at` of the most recently created proposal, used as the "since the last plan" window. */
  getLastProposalCreatedAt(): string | null {
    return (this.database.prepare('SELECT created_at FROM queue_proposals ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined)?.created_at ?? null;
  }

  /** Raw accepted/rejected proposal rows, newest first, for the feedback-weight learner. */
  listResolvedProposalsForFeedback(limit: number): Array<{ status: 'accepted' | 'rejected'; explanationsJson: string }> {
    const rows = this.database.prepare(`
      SELECT status, explanations_json FROM queue_proposals
      WHERE status IN ('accepted', 'rejected') AND explanations_json IS NOT NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{ status: 'accepted' | 'rejected'; explanations_json: string }>;
    return rows.map((row) => ({ status: row.status, explanationsJson: row.explanations_json }));
  }
}
