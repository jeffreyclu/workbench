import type { Assignee, SharedAttachment, WorkItem, WorkItemFilter } from '../../shared/contracts.js';
import { WORKBENCH_PROJECT_KEY, WORKBENCH_PROJECT_NAME } from '../../shared/project-name.js';
import { localCalendarDate } from '../../shared/due-date.js';
import type { UnitOfWork } from '../unit-of-work.js';

/**
 * Workbench is a project focus on the one attention queue (migration 025), so
 * membership is matched on the canonical project key rather than an exact
 * display string. `Workbench`, `workbench`, and a learned `wkbnch` are the same
 * stack; a task cannot fall out of it by being typed differently.
 *
 * The `project_key IS NULL` arm keeps rows written by an older runtime during a
 * release handoff in the right stack until this build rewrites them. COALESCE
 * keeps both arms strictly boolean so `NOT` still admits project-less tasks.
 */
export const workbenchProjectPredicate = `(COALESCE(project_key, '') = '${WORKBENCH_PROJECT_KEY}'
  OR (project_key IS NULL AND COALESCE(project_name, '') = '${WORKBENCH_PROJECT_NAME}' COLLATE NOCASE))`;
export const nonWorkbenchProjectPredicate = `NOT ${workbenchProjectPredicate}`;

export interface WorkItemRow {
  id: string;
  title: string;
  description: string;
  status: WorkItem['status'];
  priority: number;
  queue_position: number;
  source: WorkItem['source'];
  is_queued: number;
  source_identifier: string | null;
  source_url: string | null;
  machine_proposed: number;
  machine_proposal_run_id: string | null;
  machine_proposal_window_start: string | null;
  suggested_priority: number | null;
  suggested_queue_position: number | null;
  proposal_rationale: string | null;
  project_name: string | null;
  stack: WorkItem['stack'];
  workspace_path: string | null;
  attachments_json: string | null;
  strategy: string;
  assignees_json: string;
  labels_json: string;
  due_date: string | null;
  provider_payload_json: string | null;
  provider_updated_at: string | null;
  archived_at: string | null;
  completed_at: string | null;
  parent_work_item_id: string | null;
  created_at: string;
  updated_at: string;
  last_touched_at: string | null;
  version: number;
}

export function mapWorkItemRow(row: WorkItemRow): WorkItem {
  const sourceTags = new Set<string>();
  if (row.source === 'linear') sourceTags.add('Linear');
  if (row.source_url) {
    try {
      const host = new URL(row.source_url).hostname.toLowerCase();
      if (host.includes('slack.com')) sourceTags.add('Slack');
      else if (host.includes('github.com')) sourceTags.add('GitHub');
      else if (host.includes('atlassian.net') || host.includes('confluence')) sourceTags.add('Atlassian');
      else if (host.includes('figma.com')) sourceTags.add('Figma');
      else if (host.includes('claude.ai')) sourceTags.add('Claude');
    } catch { /* Preserve legacy URLs without inventing a source. */ }
  }
  if (!sourceTags.size && row.source === 'manual') sourceTags.add('Manual');
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    queuePosition: row.queue_position,
    source: row.source,
    isQueued: row.is_queued === 1,
    archivedAt: row.archived_at,
    completedAt: row.completed_at,
    parentWorkItemId: row.parent_work_item_id,
    completionStatus: row.completed_at ? 'completed' : 'incomplete',
    agentOutcome: null,
    sourceIdentifier: row.source_identifier,
    sourceUrl: row.source_url,
    sourceTags: [...sourceTags],
    machineProposed: row.machine_proposed === 1,
    machineProposalRunId: row.machine_proposal_run_id,
    machineProposalWindowStart: row.machine_proposal_window_start,
    suggestedPriority: row.suggested_priority,
    suggestedQueuePosition: row.suggested_queue_position,
    proposalRationale: row.proposal_rationale,
    projectName: row.project_name,
    stack: row.stack,
    workspacePath: row.workspace_path,
    attachments: JSON.parse(row.attachments_json ?? '[]') as SharedAttachment[],
    strategy: row.strategy,
    assignees: JSON.parse(row.assignees_json) as Assignee[],
    labels: JSON.parse(row.labels_json) as string[],
    dueDate: row.due_date,
    providerUpdatedAt: row.provider_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    lastTouchedAt: row.last_touched_at ?? row.created_at,
  };
}

export interface WorkItemPageRows {
  items: WorkItem[];
  nextCursor: string | null;
  totalCount: number;
}

export interface WorkItemInsertBase {
  id: string;
  title: string;
  description: string;
  status: WorkItem['status'];
  priority: number;
  position: number;
  createdAt: string;
}

export interface ManualWorkItemInsert extends WorkItemInsertBase {
  projectName: string | null;
  projectKey: string | null;
  stack: WorkItem['stack'];
  workspacePath: string | null;
  dueDate: string | null;
  sourceUrl: string | null;
  parentWorkItemId: string | null;
  attachments: SharedAttachment[];
}

export interface MachineProposalWorkItemInsert extends ManualWorkItemInsert {
  runId: string;
  windowStart: string;
  suggestedPriority: number;
  suggestedQueuePosition: number;
  rationale: string;
}

export interface ProviderWorkItemInsert extends WorkItemInsertBase {
  sourceIdentifier: string;
  sourceUrl: string | null;
  projectName: string | null;
  projectKey: string | null;
  labels: string[];
  dueDate: string | null;
  providerPayload: unknown;
  providerUpdatedAt: string;
}

/**
 * Owns the `work_items` table's row-level CRUD: row mapping, get/list/search
 * queries scoped to that one table, insert, field-level updates, and (soft)
 * delete. Everything that composes `work_items` with another table or repo —
 * dependency-graph writes, lineage, activity logging, lifecycle-event
 * recording, execution-plan mapping, bulk-edit logging, and provider-sync
 * overrides — stays in `WorkItemRepository` (the facade in repository.ts),
 * which calls back into these primitives inside its own `UnitOfWork`
 * transaction.
 */
export class WorkItemRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  get(id: string): WorkItem | null {
    const row = this.database.prepare('SELECT * FROM work_items WHERE id = ? AND deleted_at IS NULL').get(id) as WorkItemRow | undefined;
    return row ? mapWorkItemRow(row) : null;
  }

  getBySourceIdentifier(sourceIdentifier: string): WorkItem | null {
    const row = this.database.prepare("SELECT * FROM work_items WHERE source = 'linear' AND source_identifier = ?").get(sourceIdentifier) as WorkItemRow | undefined;
    return row ? mapWorkItemRow(row) : null;
  }

  listStack(stack: 'attention' | 'workbench'): WorkItem[] {
    const focus = stack === 'workbench' ? `AND ${workbenchProjectPredicate}` : '';
    const rows = this.database
      .prepare(`
        SELECT * FROM work_items
        WHERE is_queued = 1 AND archived_at IS NULL AND deleted_at IS NULL AND status != 'done'
          ${focus}
        ORDER BY queue_position ASC, created_at ASC
      `)
      .all() as unknown as WorkItemRow[];
    return rows.map(mapWorkItemRow);
  }

  listArchived(): WorkItem[] {
    const rows = this.database.prepare(`SELECT * FROM work_items WHERE archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC`).all() as unknown as WorkItemRow[];
    return rows.map(mapWorkItemRow);
  }

  listByParent(parentWorkItemId: string): WorkItem[] {
    const rows = this.database.prepare('SELECT * FROM work_items WHERE parent_work_item_id = ? ORDER BY created_at ASC').all(parentWorkItemId) as unknown as WorkItemRow[];
    return rows.map(mapWorkItemRow);
  }

  counts(): { active: number; workbench: number; archive: number; attentionArchive: number; workbenchArchive: number } {
    const row = this.database.prepare(`SELECT
      SUM(CASE WHEN is_queued = 1 AND archived_at IS NULL AND status != 'done' AND ${nonWorkbenchProjectPredicate} THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN is_queued = 1 AND archived_at IS NULL AND status != 'done' AND ${workbenchProjectPredicate} THEN 1 ELSE 0 END) AS workbench,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archive,
      SUM(CASE WHEN archived_at IS NOT NULL AND ${nonWorkbenchProjectPredicate} THEN 1 ELSE 0 END) AS attention_archive,
      SUM(CASE WHEN archived_at IS NOT NULL AND ${workbenchProjectPredicate} THEN 1 ELSE 0 END) AS workbench_archive
      FROM work_items WHERE deleted_at IS NULL`).get() as { active: number | null; workbench: number | null; archive: number | null; attention_archive: number | null; workbench_archive: number | null };
    return {
      active: Number(row.active ?? 0),
      workbench: Number(row.workbench ?? 0),
      archive: Number(row.archive ?? 0),
      attentionArchive: Number(row.attention_archive ?? 0),
      workbenchArchive: Number(row.workbench_archive ?? 0),
    };
  }

  searchLinear(query: string, limit = 20): WorkItem[] {
    const needle = `%${query.trim()}%`;
    const rows = this.database
      .prepare(`
        SELECT * FROM work_items
        WHERE source = 'linear'
          AND deleted_at IS NULL AND archived_at IS NULL
          AND (title LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE OR project_name LIKE ? COLLATE NOCASE
            OR source_identifier LIKE ? COLLATE NOCASE OR source_url LIKE ? COLLATE NOCASE)
        ORDER BY is_queued DESC, priority ASC, provider_updated_at DESC, rowid ASC
        LIMIT ?
      `)
      .all(needle, needle, needle, needle, needle, limit) as unknown as WorkItemRow[];
    return rows.map(mapWorkItemRow);
  }

  searchDependencyCandidates(workItemId: string, query = '', limit = 50): WorkItem[] {
    const needle = `%${query.trim()}%`;
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = this.database.prepare(`
      SELECT * FROM work_items
      WHERE id != ? AND deleted_at IS NULL AND archived_at IS NULL
        AND (? = '%%' OR title LIKE ? COLLATE NOCASE OR source_identifier LIKE ? COLLATE NOCASE)
      ORDER BY CASE WHEN completed_at IS NULL AND status NOT IN ('done', 'canceled') THEN 0 ELSE 1 END,
        updated_at DESC, title COLLATE NOCASE ASC, rowid ASC
      LIMIT ?
    `).all(workItemId, needle, needle, needle, safeLimit) as unknown as WorkItemRow[];
    return rows.map(mapWorkItemRow);
  }

  /**
   * Cursor-paginated `work_items` query behind `active`/`workbench`/`archive`
   * views, with the free-text/project/status/source/assignee/label/due-state
   * filter set. Purely a `work_items` read: dependency, lineage, agent-outcome
   * decoration, and the queue proposal all stay in the facade's `listPage`.
   */
  listPage(view: 'active' | 'workbench' | 'archive' | 'workbench-archive', limit: number, cursor: string | null, filter: WorkItemFilter, timeZone: string): WorkItemPageRows {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const normalizedFilter = { ...filter, projectNames: [...new Set(filter.projectNames)].sort(), statuses: [...new Set(filter.statuses)].sort(), assignees: [...new Set(filter.assignees)].sort(), sources: [...new Set(filter.sources)].sort(), labels: [...new Set(filter.labels)].sort(), dueStates: [...new Set(filter.dueStates)].sort() };
    const fingerprint = JSON.stringify(normalizedFilter);
    const needle = normalizedFilter.query ? `%${normalizedFilter.query}%` : null;
    type WorkItemCursor = { position?: number; archivedAt?: string; archivedGroup?: number; updatedAt?: string; id: string; view: string; fingerprint: string };
    let cursorValues: WorkItemCursor | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as WorkItemCursor; } catch { throw new Error('Invalid work-item cursor.'); }
      if (!cursorValues?.id || cursorValues.view !== view || cursorValues.fingerprint !== fingerprint) throw new Error('Work-item cursor does not match this view and filter.');
    }
    const search = `(? IS NULL OR title LIKE ? COLLATE NOCASE OR source_identifier LIKE ? COLLATE NOCASE OR project_name LIKE ? COLLATE NOCASE)`;
    const searchArgs = [needle, needle, needle, needle];
    const active = `is_queued = 1 AND archived_at IS NULL AND deleted_at IS NULL AND status NOT IN ('done', 'canceled')`;
    const workbench = `${active} AND ${workbenchProjectPredicate}`;
    const attention = `${active} AND ${nonWorkbenchProjectPredicate}`;
    const archived = 'archived_at IS NOT NULL AND deleted_at IS NULL';
    const projectScope = view === 'workbench' || view === 'workbench-archive' ? workbenchProjectPredicate : nonWorkbenchProjectPredicate;
    // A free-text search spans both the active and archived halves of the
    // current project scope (Workbench vs. attention) — the tab still names
    // which scope, but no longer confines the results to just that half.
    const isSearchQuery = needle !== null;
    // Archive is a filter within its parent stack: attention excludes
    // Workbench-project work, while Workbench archive includes only that work.
    const where = isSearchQuery ? `${projectScope} AND deleted_at IS NULL`
      : view === 'active' ? attention : view === 'workbench' ? workbench
        : view === 'workbench-archive' ? `${archived} AND ${workbenchProjectPredicate}`
          : `${archived} AND ${nonWorkbenchProjectPredicate}`;
    const clauses: string[] = []; const args: string[] = [];
    const addIn = (column: string, values: string[]) => { if (values.length) { clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`); args.push(...values); } };
    addIn('project_name', normalizedFilter.projectNames); addIn('status', normalizedFilter.statuses); addIn('source', normalizedFilter.sources);
    if (normalizedFilter.assignees.length) { clauses.push(`EXISTS (SELECT 1 FROM json_each(work_items.assignees_json) WHERE value IN (${normalizedFilter.assignees.map(() => '?').join(', ')}))`); args.push(...normalizedFilter.assignees); }
    if (normalizedFilter.labels.length) { clauses.push(`EXISTS (SELECT 1 FROM json_each(work_items.labels_json) WHERE value IN (${normalizedFilter.labels.map(() => '?').join(', ')}))`); args.push(...normalizedFilter.labels); }
    if (normalizedFilter.dueStates.length) {
      const today = localCalendarDate(Date.now(), timeZone); const due: string[] = [];
      if (normalizedFilter.dueStates.includes('overdue')) { due.push(`due_date IS NOT NULL AND date(due_date) < date(?)`); args.push(today); }
      if (normalizedFilter.dueStates.includes('due_today')) { due.push(`due_date IS NOT NULL AND date(due_date) = date(?)`); args.push(today); }
      if (normalizedFilter.dueStates.includes('due_later')) { due.push(`due_date IS NOT NULL AND date(due_date) > date(?)`); args.push(today); }
      if (normalizedFilter.dueStates.includes('unscheduled')) due.push(`(due_date IS NULL OR due_date = '')`);
      clauses.push(`(${due.join(' OR ')})`);
    }
    const filters = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
    const isArchive = !isSearchQuery && (view === 'archive' || view === 'workbench-archive');
    const archivedGroup = `(CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END)`;
    const cursorClause = isSearchQuery
      ? `(? IS NULL OR ${archivedGroup} > ? OR (${archivedGroup} = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))`
      : !isArchive ? `(? IS NULL OR queue_position > ? OR (queue_position = ? AND id > ?))` : `(? IS NULL OR archived_at < ? OR (archived_at = ? AND id < ?))`;
    const cursorArgs = isSearchQuery
      ? [cursorValues?.id ?? null, cursorValues?.archivedGroup ?? null, cursorValues?.archivedGroup ?? null, cursorValues?.updatedAt ?? null, cursorValues?.updatedAt ?? null, cursorValues?.id ?? null]
      : !isArchive ? [cursorValues?.id ?? null, cursorValues?.position ?? null, cursorValues?.position ?? null, cursorValues?.id ?? null] : [cursorValues?.id ?? null, cursorValues?.archivedAt ?? null, cursorValues?.archivedAt ?? null, cursorValues?.id ?? null];
    const order = isSearchQuery ? `${archivedGroup} ASC, updated_at DESC, id DESC` : !isArchive ? 'queue_position ASC, id ASC' : 'archived_at DESC, id DESC';
    const rows = this.database.prepare(`SELECT * FROM work_items WHERE ${where} AND ${search}${filters} AND ${cursorClause} ORDER BY ${order} LIMIT ?`).all(...searchArgs, ...args, ...cursorArgs, safeLimit + 1) as unknown as WorkItemRow[];
    const pageRows = rows.slice(0, safeLimit); const last = pageRows.at(-1);
    const nextCursor = rows.length > safeLimit && last
      ? Buffer.from(JSON.stringify(isSearchQuery ? { archivedGroup: last.archived_at ? 1 : 0, updatedAt: last.updated_at, id: last.id, view, fingerprint }
        : !isArchive ? { position: last.queue_position, id: last.id, view, fingerprint } : { archivedAt: last.archived_at, id: last.id, view, fingerprint })).toString('base64url')
      : null;
    const totalCount = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM work_items WHERE ${where} AND ${search}${filters}`).get(...searchArgs, ...args) as { count: number }).count);
    return { items: pageRows.map(mapWorkItemRow), nextCursor, totalCount };
  }

  nextQueuePosition(): number {
    return Number((this.database.prepare('SELECT COALESCE(MAX(queue_position), 0) + 1 AS value FROM work_items').get() as { value: number }).value);
  }

  insertManual(input: ManualWorkItemInsert): void {
    this.database
      .prepare(`
        INSERT INTO work_items (
          id, title, description, status, priority, queue_position, source, is_queued,
          project_name, project_key, stack, workspace_path, due_date, source_url, parent_work_item_id, attachments_json, created_at, updated_at, last_touched_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id, input.title, input.description, input.status, input.priority, input.position,
        input.projectName, input.projectKey, input.stack, input.workspacePath, input.dueDate, input.sourceUrl, input.parentWorkItemId, JSON.stringify(input.attachments),
        input.createdAt, input.createdAt, input.createdAt,
      );
  }

  insertMachineProposal(input: MachineProposalWorkItemInsert): void {
    this.database.prepare(`
      INSERT INTO work_items (
        id, title, description, status, priority, queue_position, source, is_queued,
        project_name, project_key, stack, workspace_path, due_date, source_url, parent_work_item_id,
        machine_proposed, machine_proposal_run_id, machine_proposal_window_start,
        suggested_priority, suggested_queue_position, proposal_rationale,
        created_at, updated_at, last_touched_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.title, input.description, input.status, input.priority, input.position,
      input.projectName, input.projectKey, input.stack, input.workspacePath, input.dueDate, input.sourceUrl, input.parentWorkItemId,
      input.runId, input.windowStart, input.suggestedPriority, input.suggestedQueuePosition, input.rationale,
      input.createdAt, input.createdAt, input.createdAt,
    );
  }

  insertProviderItem(input: ProviderWorkItemInsert): void {
    this.database
      .prepare(`
        INSERT INTO work_items (
          id, title, description, status, priority, queue_position, source, is_queued,
          source_identifier, source_url, project_name, project_key, labels_json, due_date,
          provider_payload_json, provider_updated_at, created_at, updated_at, last_touched_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'linear', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id, input.title, input.description, input.status, input.priority, input.position,
        input.sourceIdentifier, input.sourceUrl, input.projectName, input.projectKey, JSON.stringify(input.labels), input.dueDate,
        JSON.stringify(input.providerPayload), input.providerUpdatedAt, input.createdAt, input.createdAt, input.createdAt,
      );
  }

  /**
   * Generic field-level `work_items` update: applies `assignments` verbatim,
   * always bumps `version` and `updated_at`/`last_touched_at`, and optionally
   * guards on the caller's `expectedVersion`. Column selection and the
   * decision of what to write live in the facade's `update()`; this is only
   * the primitive that executes the write and reports rows changed.
   */
  updateFields(id: string, assignments: Array<[string, string | number | null]>, options: { manualAssignees?: boolean; expectedVersion?: number } = {}): number {
    if (!assignments.length) return 0;
    const setClause = assignments.map(([column]) => `${column} = ?`).join(', ');
    const values = assignments.map(([, value]) => value);
    const assignmentMode = options.manualAssignees ? ", agent_assignment_mode = 'manual'" : '';
    const now = new Date().toISOString();
    const versionGuard = options.expectedVersion !== undefined ? ' AND version = ?' : '';
    const guardValues = options.expectedVersion !== undefined ? [options.expectedVersion] : [];
    const result = this.database
      .prepare(`UPDATE work_items SET ${setClause}${assignmentMode}, version = version + 1, updated_at = ?, last_touched_at = ? WHERE id = ?${versionGuard}`)
      .run(...values, now, now, id, ...guardValues);
    return Number(result.changes);
  }

  /** Soft delete: flags the row so it drops out of every list/get query but stays recoverable in the database. */
  softDelete(id: string, deletedAt: string): boolean {
    return Number(this.database.prepare('UPDATE work_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(deletedAt, id).changes) > 0;
  }

  setArchived(id: string, fields: { archivedAt: string; completedAt: string | null; status: WorkItem['status']; updatedAt: string }): void {
    this.database.prepare('UPDATE work_items SET archived_at = ?, completed_at = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(fields.archivedAt, fields.completedAt, fields.status, fields.updatedAt, id);
  }

  setRestored(id: string, fields: { status: WorkItem['status']; updatedAt: string }): void {
    this.database.prepare('UPDATE work_items SET archived_at = NULL, completed_at = NULL, status = ?, is_queued = 1, updated_at = ? WHERE id = ?')
      .run(fields.status, fields.updatedAt, id);
  }

  setQueued(id: string, updatedAt: string): void {
    this.database.prepare('UPDATE work_items SET is_queued = 1, updated_at = ? WHERE id = ?').run(updatedAt, id);
  }

  /** Batch queue-position rewrite shared by `reorder()` and `bulkUpdate()`'s stack moves. */
  setQueuePositions(orderedIds: string[], updatedAt: string): void {
    const statement = this.database.prepare('UPDATE work_items SET queue_position = ?, updated_at = ? WHERE id = ?');
    orderedIds.forEach((id, index) => statement.run(index + 1, updatedAt, id));
  }
}
