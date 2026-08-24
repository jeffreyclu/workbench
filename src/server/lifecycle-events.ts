import { randomUUID } from 'node:crypto';

import type { Activity, WorkItem } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';

export interface LifecycleEventInput {
  workItemId: string;
  transition: string;
  fromStatus: WorkItem['status'] | null;
  toStatus: WorkItem['status'];
  isInitial: boolean;
  actor: Activity['actor'];
  source: string;
  reason?: string;
  occurredAt: string;
}

/** Appends to the immutable lifecycle audit trail; shared by every writer that moves a work item's status. */
export function recordLifecycleEvent(database: WorkbenchDatabase, input: LifecycleEventInput): void {
  database.prepare(`INSERT INTO work_item_lifecycle_events
    (id, work_item_id, transition, from_status, to_status, is_initial, actor, source, reason, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.workItemId, input.transition, input.fromStatus, input.toStatus, input.isInitial ? 1 : 0,
      input.actor, input.source, input.reason ?? null, input.occurredAt);
}
