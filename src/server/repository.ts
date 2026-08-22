import { randomUUID } from 'node:crypto';

import { isSelfAssigned, workItemFilterSchema, type Activity, type AgentRun, type ArtifactSummary, type Assignee, type AuditLogEntry, type AuditLogPage, type BulkWorkItemAction, type BulkWorkItemResult, type ConversationPage, type DiagnosticEvent, type DiscoveryCandidate, type DiscoveryCandidateStatus, type DiscoveryInbox, type DiscoveryRun, type ExecutionPlan, type LinearProviderConfig, type PlannedTask, type ProviderSyncConflict, type ProviderSyncConflictResolution, type ProviderSyncField, type QueueItemExplanation, type QueueOrderChange, type QueueProposal, type QueueSignalKey, type RunInsights, type SavedWorkItemFilter, type SavedWorkItemFilterView, type SharedAttachment, type SharedConversation, type SharedMessage, type SharedMessagePage, type SharedSearchResult, type SourceConnection, type SourceProvider, type TaskClassification, type WorkItem, type WorkItemDependency, type WorkItemFilter, type WorkItemLineage, type WorkItemPage, type WorkItemReference, type WorkItemReferenceType } from '../shared/contracts.js';
import { learnFeedbackWeights, planQueue, type FeedbackWeight, type QueueContext, type QueuePlan } from './queue-intelligence.js';
import type { WorkbenchDatabase } from './database.js';
import { ArtifactLibrary } from './artifact-library.js';
import { DEFAULT_WORKBENCH_TIMEZONE, localCalendarDate } from '../shared/due-date.js';
import { describeLifecycleChange, summarizeWorkItemChanges } from './activity-log.js';
import { summarizeCursing } from './profanity.js';
import { estimateModelCost, resolveModelRate } from './model-pricing.js';

/** Who applied a lifecycle move, and what forced it when Workbench applied it as a cascade. */
export interface LifecycleContext { actor?: Activity['actor']; reason?: string }

interface WorkItemRow {
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
  project_name: string | null;
  stack: WorkItem['stack'];
  workspace_path: string | null;
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
}

interface ActivityRow {
  id: string;
  work_item_id: string;
  actor: Activity['actor'];
  kind: string;
  body: string;
  created_at: string;
}

interface RunPatch {
  agent?: AgentRun['agent'];
  status?: AgentRun['status'];
  output?: string;
  error?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  model?: string;
  executionProfile?: NonNullable<AgentRun['executionProfile']>;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
  fallbackFrom?: AgentRun['agent'] | null;
  fallbackReason?: string | null;
  ownerId?: string | null;
  leaseExpiresAt?: string | null;
  nextAttemptAt?: string | null;
  attempt?: number;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

/**
 * Removes only the most exceptional values using Tukey's outer fences. This
 * keeps a task that genuinely took longer in the data set while preventing a
 * stale task completed long after it was created from defining the insight.
 */
function excludeExtremeOutliers(values: number[]): number[] {
  if (values.length < 5) return values;

  const sorted = [...values].sort((left, right) => left - right);
  const lowerQuartile = percentile(sorted, 0.25);
  const upperQuartile = percentile(sorted, 0.75);
  if (lowerQuartile === null || upperQuartile === null) return values;

  const interquartileRange = upperQuartile - lowerQuartile;
  const lowerFence = lowerQuartile - 3 * interquartileRange;
  const upperFence = upperQuartile + 3 * interquartileRange;
  return values.filter((value) => value >= lowerFence && value <= upperFence);
}

interface SavedWorkItemFilterRow {
  id: string; name: string; view: SavedWorkItemFilterView; filter_json: string;
  sort_order: number; created_at: string; updated_at: string;
}

function mapSavedWorkItemFilter(row: SavedWorkItemFilterRow): SavedWorkItemFilter {
  return { id: row.id, name: row.name, view: row.view, filter: workItemFilterSchema.parse(JSON.parse(row.filter_json)), sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapWorkItem(row: WorkItemRow): WorkItem {
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
    projectName: row.project_name,
    stack: row.stack,
    workspacePath: row.workspace_path,
    strategy: row.strategy,
    assignees: JSON.parse(row.assignees_json) as Assignee[],
    labels: JSON.parse(row.labels_json) as string[],
    dueDate: row.due_date,
    providerUpdatedAt: row.provider_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTouchedAt: row.last_touched_at ?? row.created_at,
  };
}

export interface ProviderWorkItem {
  sourceIdentifier: string;
  sourceUrl: string | null;
  title: string;
  description: string;
  status: WorkItem['status'];
  priority: number;
  projectName: string | null;
  labels: string[];
  dueDate: string | null;
  providerUpdatedAt: string;
  providerPayload: unknown;
}

type ProviderFieldValue = string | string[] | null;
type ProviderSnapshotValues = Record<ProviderSyncField, ProviderFieldValue>;

interface ProviderSnapshotRow {
  normalized_json: string;
  raw_payload_json: string;
  provider_updated_at: string | null;
  synced_at: string;
}

interface ProviderOverrideRow {
  field: ProviderSyncField;
  provider_baseline_json: string;
  conflicted_at: string | null;
}

const providerSyncFields: readonly ProviderSyncField[] = ['title', 'description', 'status', 'projectName', 'labels', 'dueDate'];
const providerFieldColumns: Record<ProviderSyncField, string> = {
  title: 'title', description: 'description', status: 'status', projectName: 'project_name', labels: 'labels_json', dueDate: 'due_date',
};

function normalizeLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort((left, right) => left.localeCompare(right));
}

function providerValues(value: Pick<WorkItem, ProviderSyncField> | ProviderWorkItem | WorkItemRow): ProviderSnapshotValues {
  if ('project_name' in value) {
    return {
      title: value.title, description: value.description, status: value.status, projectName: value.project_name,
      labels: normalizeLabels(JSON.parse(value.labels_json) as string[]), dueDate: value.due_date,
    };
  }
  return {
    title: value.title, description: value.description, status: value.status, projectName: value.projectName,
    labels: normalizeLabels(value.labels), dueDate: value.dueDate,
  };
}

function sameProviderValue(left: ProviderFieldValue, right: ProviderFieldValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function databaseProviderValue(field: ProviderSyncField, value: ProviderFieldValue): string | null {
  return field === 'labels' ? JSON.stringify(value) : value as string | null;
}

function parseProviderValue(value: string): ProviderFieldValue {
  return JSON.parse(value) as ProviderFieldValue;
}

export class WorkItemDependencyError extends Error {
  readonly code = 'INVALID_DEPENDENCIES';
}

export class WorkItemRepository {
  private transactionDepth = 0;

  constructor(private readonly database: WorkbenchDatabase, private readonly timeZone = process.env.WORKBENCH_TIMEZONE ?? DEFAULT_WORKBENCH_TIMEZONE) {}

  /**
   * Repository operations compose through this boundary. SQLite has no nested
   * BEGIN transaction, so compound operations must share their caller's unit
   * of work rather than opening a second transaction underneath it.
   */
  transaction<T>(operation: () => T): T {
    const outermost = this.transactionDepth === 0;
    if (outermost) this.database.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.transactionDepth -= 1;
      if (outermost) this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (outermost) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private queueVersion(stack: 'attention' | 'workbench'): number {
    return Number((this.database.prepare('SELECT version FROM queue_versions WHERE stack = ?').get(stack) as { version: number } | undefined)?.version ?? 0);
  }

  private incrementQueueVersion(stack: 'attention' | 'workbench'): void {
    this.database.prepare('INSERT INTO queue_versions (stack, version) VALUES (?, 1) ON CONFLICT(stack) DO UPDATE SET version = version + 1').run(stack);
  }

  getDiscoveryInbox(view: 'pending' | 'reviewed' = 'pending'): DiscoveryInbox {
    const now = new Date().toISOString();
    this.database.prepare("UPDATE discovery_candidates SET status = 'pending', snoozed_until = NULL, updated_at = ? WHERE status = 'snoozed' AND snoozed_until <= ?").run(now, now);
    const where = view === 'pending' ? "status = 'pending'" : "status IN ('converted', 'merged', 'dismissed', 'snoozed')";
    const candidates = (this.database.prepare(`SELECT * FROM discovery_candidates WHERE ${where} ORDER BY ${view === 'pending' ? 'relevance DESC, COALESCE(occurred_at, discovered_at) DESC' : 'updated_at DESC'}`).all() as Array<Record<string, string | number | null>>).map((row) => this.mapDiscoveryCandidate(row));
    const counts = this.database.prepare(`SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status IN ('converted', 'merged', 'dismissed', 'snoozed') THEN 1 ELSE 0 END) reviewed FROM discovery_candidates`).get() as { pending: number | null; reviewed: number | null };
    const run = this.database.prepare('SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 1').get() as Record<string, string | number | null> | undefined;
    return { candidates, pendingCount: Number(counts.pending ?? 0), reviewedCount: Number(counts.reviewed ?? 0), lastRun: run ? this.mapDiscoveryRun(run) : null, running: run?.status === 'running', queueProposal: this.getPendingProposal() };
  }

  startDiscoveryRun(): DiscoveryRun {
    const running = this.database.prepare("SELECT * FROM discovery_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get() as Record<string, string | number | null> | undefined;
    if (running) return this.mapDiscoveryRun(running);
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare("INSERT INTO discovery_runs (id, status, started_at) VALUES (?, 'running', ?)").run(id, now);
    return { id, status: 'running', startedAt: now, completedAt: null, candidateCount: 0, errors: [] };
  }

  finishDiscoveryRun(id: string, candidateCount: number, errors: string[], failed = false): void {
    this.database.prepare('UPDATE discovery_runs SET status = ?, completed_at = ?, candidate_count = ?, errors_json = ? WHERE id = ?')
      .run(failed ? 'failed' : 'completed', new Date().toISOString(), candidateCount, JSON.stringify(errors), id);
  }

  upsertDiscoveryCandidate(input: { fingerprint: string; provider: string; title: string; description: string; sourceUrl: string | null; occurredAt: string | null; runId: string; relevance?: number }): boolean {
    const now = new Date().toISOString();
    const suggested = input.sourceUrl ? this.database.prepare(`SELECT id FROM work_items WHERE source_url = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY is_queued DESC, updated_at DESC LIMIT 1`).get(input.sourceUrl) as { id: string } | undefined : undefined;
    const existing = this.database.prepare('SELECT status FROM discovery_candidates WHERE fingerprint = ?').get(input.fingerprint) as { status: DiscoveryCandidateStatus } | undefined;
    if (existing) {
      this.database.prepare(`UPDATE discovery_candidates SET title = ?, description = ?, source_url = ?, occurred_at = ?, updated_at = ?, run_id = ?, relevance = ?, suggested_work_item_id = ? WHERE fingerprint = ?`)
        .run(input.title, input.description, input.sourceUrl, input.occurredAt, now, input.runId, input.relevance ?? 1, suggested?.id ?? null, input.fingerprint);
      return false;
    }
    this.database.prepare(`INSERT INTO discovery_candidates (id, fingerprint, provider, title, description, source_url, occurred_at, status, discovered_at, updated_at, run_id, relevance, suggested_work_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(randomUUID(), input.fingerprint, input.provider, input.title, input.description, input.sourceUrl, input.occurredAt, now, now, input.runId, input.relevance ?? 1, suggested?.id ?? null);
    return true;
  }

  resolveDiscoveryCandidate(id: string, action: 'convert' | 'dismiss' | 'snooze' | 'merge', workItemId?: string): DiscoveryCandidate | null {
    return this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ? AND status = \'pending\'').get(id) as Record<string, string | null> | undefined;
      if (!row) return null;
      const candidate = this.mapDiscoveryCandidate(row); const now = new Date().toISOString();
      let linkedId = workItemId ?? null;
      if (action === 'convert') {
        const item = this.create({ title: candidate.title, description: candidate.description, priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null, sourceUrl: candidate.sourceUrl });
        linkedId = item.id;
        this.addActivity(item.id, 'system', 'discovered', `Discovered overnight from ${candidate.provider}.`);
      } else if (action === 'merge') {
        const item = linkedId ? this.get(linkedId) : null;
        if (!item) throw new Error('Choose an existing task to merge into.');
        this.addActivity(item.id, 'system', 'discovered', `${candidate.provider}: ${candidate.title}${candidate.sourceUrl ? `\n${candidate.sourceUrl}` : ''}`);
      }
      const status = action === 'convert' ? 'converted' : action === 'merge' ? 'merged' : action === 'dismiss' ? 'dismissed' : 'snoozed';
      const snoozedUntil = action === 'snooze' ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
      this.database.prepare("UPDATE discovery_candidates SET status = ?, work_item_id = ?, snoozed_until = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(status, linkedId, snoozedUntil, now, id);
      return this.mapDiscoveryCandidate(this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ?').get(id) as Record<string, string | null>);
    });
  }

  updateDiscoveryCandidate(id: string, changes: { title?: string; description?: string }): DiscoveryCandidate | null {
    const entries = Object.entries(changes).filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (!entries.length) return null;
    const columns: Record<string, string> = { title: 'title', description: 'description' };
    const now = new Date().toISOString();
    const changed = this.database.prepare(`UPDATE discovery_candidates SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(...entries.map(([, value]) => value), now, id).changes;
    if (!changed) return null;
    return this.mapDiscoveryCandidate(this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ?').get(id) as Record<string, string | null>);
  }

  resolveDiscoveryCandidates(ids: string[], action: 'convert' | 'dismiss' | 'snooze'): DiscoveryCandidate[] {
    const resolved: DiscoveryCandidate[] = [];
    for (const id of ids) {
      const pending = this.database.prepare('SELECT suggested_work_item_id FROM discovery_candidates WHERE id = ?').get(id) as { suggested_work_item_id: string | null } | undefined;
      const candidate = action === 'convert' && pending?.suggested_work_item_id
        ? this.resolveDiscoveryCandidate(id, 'merge', pending.suggested_work_item_id)
        : this.resolveDiscoveryCandidate(id, action);
      if (candidate) resolved.push(candidate);
    }
    return resolved;
  }

  restoreDiscoveryCandidate(id: string): DiscoveryCandidate | null {
    const now = new Date().toISOString();
    const changed = this.database.prepare("UPDATE discovery_candidates SET status = 'pending', snoozed_until = NULL, updated_at = ? WHERE id = ? AND status IN ('dismissed', 'snoozed')").run(now, id).changes;
    if (!changed) return null;
    return this.mapDiscoveryCandidate(this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ?').get(id) as Record<string, string | number | null>);
  }

  private mapDiscoveryCandidate(row: Record<string, string | number | null>): DiscoveryCandidate {
    return { id: String(row.id), provider: String(row.provider), title: String(row.title), description: String(row.description ?? ''), sourceUrl: row.source_url ? String(row.source_url) : null, occurredAt: row.occurred_at ? String(row.occurred_at) : null,
      status: row.status as DiscoveryCandidateStatus, discoveredAt: String(row.discovered_at), updatedAt: String(row.updated_at), snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : null, workItemId: row.work_item_id ? String(row.work_item_id) : null, relevance: Number(row.relevance ?? 1), suggestedWorkItemId: row.suggested_work_item_id ? String(row.suggested_work_item_id) : null };
  }

  private mapDiscoveryRun(row: Record<string, string | number | null>): DiscoveryRun {
    return { id: String(row.id), status: row.status as DiscoveryRun['status'], startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : null,
      candidateCount: Number(row.candidate_count ?? 0), errors: JSON.parse(String(row.errors_json ?? '[]')) as string[] };
  }

  listConversations(view: 'active' | 'archive' | 'all' = 'active'): SharedConversation[] {
    return (this.database.prepare(`
      SELECT shared_conversations.*,
        EXISTS (
          SELECT 1 FROM shared_messages
          WHERE shared_messages.conversation_id = shared_conversations.id
            AND shared_messages.status = 'running'
        ) AS is_active,
        EXISTS (
          SELECT 1 FROM shared_messages
          WHERE shared_messages.conversation_id = shared_conversations.id
            AND shared_messages.status IN ('queued', 'running')
        ) AS is_working,
        EXISTS (
          SELECT 1 FROM shared_messages
          WHERE shared_messages.conversation_id = shared_conversations.id
            AND shared_messages.author IN ('codex', 'claude')
            AND shared_messages.created_at > COALESCE(shared_conversations.last_read_at, '')
        ) AS is_unread
      FROM shared_conversations
      WHERE deleted_at IS NULL AND (? = 'all' OR (? = 'active' AND archived_at IS NULL) OR (? = 'archive' AND archived_at IS NOT NULL))
      ORDER BY is_working DESC, updated_at DESC
    `).all(view, view, view) as Array<Record<string, string | number | null>>).map((row) => this.withConversationState({
      id: String(row.id), title: String(row.title), workItemId: row.work_item_id ? String(row.work_item_id) : null,
      forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, sharedBrief: String(row.shared_brief ?? ''), preferredExecutionProfile: row.preferred_execution_profile as SharedConversation['preferredExecutionProfile'] ?? null, isUnread: Boolean(row.is_unread), createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
    }));
  }

  getConversation(id: string): SharedConversation | null {
    return this.listConversations('all').find((conversation) => conversation.id === id) ?? null;
  }

  listConversationPage(limit: number, cursor: string | null, view: 'active' | 'archive' = 'active'): ConversationPage {
    const safeLimit = Math.max(1, Math.min(100, limit));
    let cursorValues: { isWorking: boolean; updatedAt: string; id: string } | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { isWorking: boolean; updatedAt: string; id: string }; }
      catch { throw new Error('Invalid conversation cursor.'); }
      if (!cursorValues?.updatedAt || !cursorValues.id || typeof cursorValues.isWorking !== 'boolean') throw new Error('Invalid conversation cursor.');
    }
    const rows = this.database.prepare(`
      WITH conversations AS (
        SELECT shared_conversations.*,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.status = 'running') AS is_active,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.status IN ('queued', 'running')) AS is_working,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.author IN ('codex', 'claude') AND shared_messages.created_at > COALESCE(shared_conversations.last_read_at, '')) AS is_unread
        FROM shared_conversations
      )
      SELECT * FROM conversations
      WHERE deleted_at IS NULL AND ((? = 'active' AND archived_at IS NULL) OR (? = 'archive' AND archived_at IS NOT NULL))
        AND (? IS NULL OR is_working < ? OR (is_working = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))
      ORDER BY is_working DESC, updated_at DESC, id DESC LIMIT ?
    `).all(view, view, cursorValues?.id ?? null, Number(cursorValues?.isWorking ?? false), Number(cursorValues?.isWorking ?? false), cursorValues?.updatedAt ?? null, cursorValues?.updatedAt ?? null, cursorValues?.id ?? null, safeLimit + 1) as Array<Record<string, string | number | null>>;
    const hasMore = rows.length > safeLimit;
    const conversations = rows.slice(0, safeLimit).map((row) => this.withConversationState({
      id: String(row.id), title: String(row.title), workItemId: row.work_item_id ? String(row.work_item_id) : null,
      forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, sharedBrief: String(row.shared_brief ?? ''), preferredExecutionProfile: row.preferred_execution_profile as SharedConversation['preferredExecutionProfile'] ?? null, isUnread: Boolean(row.is_unread), createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
    }));
    const last = conversations.at(-1);
    return { conversations, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ isWorking: last.state === 'working', updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null,
      totalCount: Number((this.database.prepare(`SELECT COUNT(*) AS count FROM shared_conversations WHERE deleted_at IS NULL AND (${view === 'active' ? 'archived_at IS NULL' : 'archived_at IS NOT NULL'})`).get() as { count: number }).count) };
  }

  createConversation(title = 'New conversation', workItemId: string | null = null): SharedConversation {
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare('INSERT INTO shared_conversations (id, title, work_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, title, workItemId, now, now);
    return { id, title, workItemId, forkedFromConversationId: null, archivedAt: null, sharedBrief: '', preferredExecutionProfile: null, isUnread: false, createdAt: now, updatedAt: now, isActive: false };
  }

  markConversationRead(id: string): SharedConversation | null {
    const changed = this.database.prepare('UPDATE shared_conversations SET last_read_at = ? WHERE id = ?').run(new Date().toISOString(), id).changes;
    return changed ? this.getConversation(id) : null;
  }

  setConversationSharedBrief(id: string, brief: string): SharedConversation | null {
    const changed = this.database.prepare('UPDATE shared_conversations SET shared_brief = ?, updated_at = ? WHERE id = ?').run(brief, new Date().toISOString(), id).changes;
    return changed ? this.getConversation(id) : null;
  }

  countActiveConversations(): number {
    return Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM shared_conversations WHERE archived_at IS NULL AND deleted_at IS NULL
    `).get() as { count: number }).count);
  }

  countUnreadConversations(): number {
    return Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM shared_conversations
      WHERE archived_at IS NULL AND deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM shared_messages
        WHERE shared_messages.conversation_id = shared_conversations.id
          AND shared_messages.author IN ('codex', 'claude')
          AND shared_messages.created_at > COALESCE(shared_conversations.last_read_at, '')
      )
    `).get() as { count: number }).count);
  }

  private withConversationState(conversation: SharedConversation): SharedConversation {
    const hasLiveWork = Boolean(this.database.prepare(`
      SELECT 1 FROM shared_messages
      WHERE conversation_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(conversation.id));
    const latest = this.database.prepare(`
      SELECT status FROM shared_messages
      WHERE conversation_id = ? AND author IN ('codex', 'claude')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(conversation.id) as { status: SharedMessage['status'] } | undefined;
    if (hasLiveWork || conversation.isActive || latest?.status === 'running' || latest?.status === 'queued') return { ...conversation, state: 'working' };
    if (latest?.status === 'failed' || latest?.status === 'canceled') return { ...conversation, state: 'needs_attention' };
    if (conversation.workItemId && this.getPendingExecutionPlan(conversation.workItemId)) return { ...conversation, state: 'waiting_approval' };
    if (latest?.status === 'completed') return { ...conversation, state: 'finished' };
    return { ...conversation, state: null };
  }

  setConversationExecutionProfile(id: string, profile: SharedConversation['preferredExecutionProfile']): SharedConversation | null {
    const before = this.getConversation(id);
    if (!before) return null;
    const now = new Date().toISOString();
    const changed = this.database.prepare('UPDATE shared_conversations SET preferred_execution_profile = ?, updated_at = ? WHERE id = ?').run(profile ?? null, now, id).changes;
    if (!changed) return null;
    if (before.workItemId && before.preferredExecutionProfile !== profile) {
      this.addActivity(before.workItemId, 'jeffrey', 'model_preference',
        profile ? `Set the model tier preference to ${profile}.` : 'Cleared the model tier preference (back to auto).');
    }
    return this.getConversation(id);
  }

  setConversationWorkItem(id: string, workItemId: string | null): SharedConversation | null {
    const before = this.getConversation(id);
    if (!before) return null;
    if (workItemId && !this.get(workItemId)) return null;
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.database.prepare('UPDATE shared_conversations SET work_item_id = ?, updated_at = ? WHERE id = ?').run(workItemId, now, id).changes;
      if (!changed) { this.database.exec('ROLLBACK'); return null; }
      if (before.workItemId && before.workItemId !== workItemId) {
        this.database.prepare('DELETE FROM agent_runs WHERE work_item_id = ? AND adopted_conversation_id = ?').run(before.workItemId, id);
        this.database.prepare('UPDATE agent_handoffs SET work_item_id = NULL WHERE conversation_id = ?').run(id);
        this.database.prepare('UPDATE shared_brief_entries SET work_item_id = NULL WHERE conversation_id = ?').run(id);
        this.addActivity(before.workItemId, 'jeffrey', 'conversation_unlinked', `Unlinked conversation “${before.title}” and removed its adopted agent-run history.`);
      }
      if (workItemId) {
        // Linking must carry the existing chat's decisions and handoffs into
        // the task scope; unlinking above is the exact inverse.
        this.database.prepare('UPDATE agent_handoffs SET work_item_id = ? WHERE conversation_id = ?').run(workItemId, id);
        this.database.prepare('UPDATE shared_brief_entries SET work_item_id = ? WHERE conversation_id = ?').run(workItemId, id);
        const adopted = this.adoptConversationAgentRuns(workItemId, id);
        if (before.workItemId !== workItemId || adopted) this.addActivity(workItemId, 'jeffrey', 'conversation_linked', `Linked conversation “${before.title}” and adopted ${adopted} agent ${adopted === 1 ? 'run' : 'runs'} as task execution history.`);
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return this.getConversation(id);
  }

  /** Materializes pre-existing chat replies as task runs so either surface has the same execution history. */
  adoptConversationAgentRuns(workItemId: string, conversationId: string): number {
    const kind = this.getClassification(workItemId)?.kind ?? 'analysis';
    const agentReplies = this.listAllSharedMessages(conversationId).filter((message) => message.author === 'codex' || message.author === 'claude');
    const insertRun = this.database.prepare(`
      INSERT INTO agent_runs (id, work_item_id, kind, requested_target, requested_agent, agent, status, instructions, output, error, started_at, completed_at, created_at, conversation_id, message_id, model, execution_profile, input_tokens, output_tokens, estimated_cost_usd, fallback_from, fallback_reason, adopted_conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let adopted = 0;
    for (const message of agentReplies) {
      const existing = this.database.prepare('SELECT 1 FROM agent_runs WHERE message_id = ?').get(message.id);
      if (existing) continue;
      insertRun.run(randomUUID(), workItemId, kind, message.author, message.author, message.author, message.status, 'Adopted from linked conversation.', message.body, message.error, message.createdAt, message.completedAt, message.createdAt, conversationId, message.id, message.model, message.executionProfile, message.inputTokens, message.outputTokens, message.estimatedCostUsd, message.fallbackFrom, message.fallbackReason, conversationId);
      adopted++;
    }
    return adopted;
  }

  /** Repairs conversations linked before run adoption existed. Safe to call on every process startup. */
  backfillConversationRunAdoptions(): number {
    const rows = this.database.prepare(`SELECT shared_conversations.id, shared_conversations.work_item_id
      FROM shared_conversations
      INNER JOIN work_items ON work_items.id = shared_conversations.work_item_id
      WHERE shared_conversations.deleted_at IS NULL AND work_items.deleted_at IS NULL`).all() as Array<{ id: string; work_item_id: string }>;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const adopted = rows.reduce((total, row) => total + this.adoptConversationAgentRuns(row.work_item_id, row.id), 0);
      this.database.exec('COMMIT');
      return adopted;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  setConversationArchived(id: string, archived: boolean): SharedConversation | null {
    const now = new Date().toISOString();
    const existing = this.listConversations('all').find((conversation) => conversation.id === id);
    if (!existing) return null;
    this.database.exec('BEGIN IMMEDIATE');
    let changed = false;
    try {
      // A task-backed conversation is the task's execution history. Removing that
      // history from the active workspace must remove its task from the active stack
      // in the same transaction, while preserving that it was not completed.
      if (archived && existing.workItemId) {
        const linkedTask = this.get(existing.workItemId);
        if (linkedTask && !linkedTask.archivedAt) this.archive(linkedTask.id, false, true, { actor: 'jeffrey', reason: 'its conversation was archived' });
      }
      changed = Number(this.database.prepare('UPDATE shared_conversations SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? now : null, now, id).changes) > 0;
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return changed ? this.listConversations('all').find((conversation) => conversation.id === id) ?? null : null;
  }

  forkConversation(id: string): SharedConversation | null {
    const source = this.listConversations('all').find((conversation) => conversation.id === id);
    if (!source) return null;
    const fork = this.createConversation(`${source.title} · fork`, source.workItemId);
    this.database.prepare('UPDATE shared_conversations SET forked_from_conversation_id = ? WHERE id = ?').run(source.id, fork.id);
    const messages = this.listAllSharedMessages(source.id);
    for (const message of messages) this.createSharedMessage(message.author, message.body, message.status === 'running' || message.status === 'queued' ? 'completed' : message.status, fork.id, message.attachments, 'none');
    // The fork inherits the task link; keeping the source linked too would leave two
    // conversations claiming to be the task's execution history, so the source is unlinked.
    if (source.workItemId) this.setConversationWorkItem(source.id, null);
    return this.listConversations('all').find((conversation) => conversation.id === fork.id) ?? null;
  }

  getOrCreateWorkConversation(workItemId: string, title: string): SharedConversation {
    return this.listConversations().find((conversation) => conversation.workItemId === workItemId) ?? this.createConversation(title, workItemId);
  }

  ensureDefaultConversation(): SharedConversation {
    const existing = this.listConversations().at(-1);
    if (existing) return existing;
    const conversation = this.createConversation('Workbench');
    this.database.prepare('UPDATE shared_messages SET conversation_id = ? WHERE conversation_id IS NULL').run(conversation.id);
    return conversation;
  }

  /** Soft delete: flags the conversation row so it drops out of every list/get query but stays recoverable in the database. Messages are left in place for the same reason. */
  deleteConversation(id: string): boolean {
    return Number(this.database.prepare('UPDATE shared_conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND work_item_id IS NULL').run(new Date().toISOString(), id).changes) > 0;
  }

  listSourceConnections(): SourceConnection[] {
    const rows = this.database.prepare('SELECT provider, label, last_scanned_at, last_error FROM source_connections WHERE deleted_at IS NULL ORDER BY provider').all() as Array<Record<string, string | null>>;
    return rows.map((row) => ({ provider: row.provider as SourceProvider, connected: true, label: row.label!, lastScannedAt: row.last_scanned_at, lastError: row.last_error, configurationState: row.last_error ? 'reauth_required' as const : 'connected' as const, health: row.last_error ? 'unavailable' as const : row.last_scanned_at ? 'healthy' as const : 'unknown' as const }));
  }

  getSourceSettings(provider: SourceProvider): Record<string, string> | null {
    const row = this.database.prepare('SELECT settings_json FROM source_connections WHERE provider = ? AND deleted_at IS NULL').get(provider) as { settings_json: string } | undefined;
    return row ? JSON.parse(row.settings_json) as Record<string, string> : null;
  }

  setSourceConnection(provider: SourceProvider, label: string, settings: Record<string, string>): SourceConnection {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO source_connections (provider, label, settings_json, connected_at, last_error)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET label = excluded.label, settings_json = excluded.settings_json, connected_at = excluded.connected_at, last_error = NULL, deleted_at = NULL`)
      .run(provider, label, JSON.stringify(settings), now);
    return this.listSourceConnections().find((connection) => connection.provider === provider)!;
  }

  updateSourceScan(provider: SourceProvider, error: string | null): void {
    this.database.prepare('UPDATE source_connections SET last_scanned_at = ?, last_error = ? WHERE provider = ? AND deleted_at IS NULL').run(new Date().toISOString(), error, provider);
  }

  markSourceReauthRequired(provider: SourceProvider, message: string): void {
    this.database.prepare('UPDATE source_connections SET last_scanned_at = ?, last_error = ? WHERE provider = ? AND deleted_at IS NULL').run(new Date().toISOString(), message, provider);
  }

  /** Soft delete: flags the row so it drops out of connection listings but stays recoverable in the database. Reconnecting the same provider (setSourceConnection) clears the flag. */
  removeSourceConnection(provider: SourceProvider): boolean {
    return Number(this.database.prepare('UPDATE source_connections SET deleted_at = ? WHERE provider = ? AND deleted_at IS NULL').run(new Date().toISOString(), provider).changes) > 0;
  }

  private mapSharedMessageRow(row: Record<string, string | number | null>): SharedMessage {
    return {
      id: String(row.id), conversationId: String(row.conversation_id ?? ''), author: row.author as SharedMessage['author'], body: String(row.body),
      pinned: row.pinned === 1, status: row.status as SharedMessage['status'], error: String(row.error),
      createdAt: String(row.created_at), completedAt: row.completed_at ? String(row.completed_at) : null, attachments: JSON.parse(String(row.attachments_json ?? '[]')) as SharedAttachment[],
      model: row.model ? String(row.model) : null,
      executionProfile: row.execution_profile as SharedMessage['executionProfile'] ?? null,
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens), outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      estimatedCostUsd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
      fallbackFrom: row.fallback_from as SharedMessage['fallbackFrom'] ?? null, fallbackReason: row.fallback_reason ? String(row.fallback_reason) : null,
      dispatchTarget: row.dispatch_target as SharedMessage['dispatchTarget'] ?? 'none',
      attempt: Number(row.attempt ?? 0), maxAttempts: Number(row.max_attempts ?? 3),
      nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    };
  }

  /**
   * Cursor-based pagination mirroring listConversationPage: page 1 (no cursor)
   * returns the most recent `limit` messages in ascending (oldest-first) order
   * for direct rendering; nextCursor, when present, fetches the next-older page
   * (messages strictly before the oldest message already returned).
   */
  listSharedMessages(limit = 100, cursor: string | null = null, conversationId?: string): SharedMessagePage {
    const safeLimit = Math.max(1, Math.min(200, limit));
    let cursorValues: { createdAt: string; rowid: number } | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt: string; rowid: number }; }
      catch { throw new Error('Invalid message cursor.'); }
      if (!cursorValues?.createdAt || !cursorValues.rowid) throw new Error('Invalid message cursor.');
    }
    // Tiebreak on rowid (insertion order), not id: several messages can share
    // the same millisecond-resolution created_at, and id is a random UUID that
    // would otherwise reorder same-timestamp messages arbitrarily.
    const rows = this.database.prepare(`
      SELECT rowid AS rowid, * FROM shared_messages
      WHERE (? IS NULL OR conversation_id = ?)
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND rowid < ?))
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(
      conversationId ?? null, conversationId ?? null,
      cursorValues?.rowid ?? null, cursorValues?.createdAt ?? null, cursorValues?.createdAt ?? null, cursorValues?.rowid ?? null,
      safeLimit + 1,
    ) as Array<Record<string, string | number | null>>;
    const hasMore = rows.length > safeLimit;
    const page = rows.slice(0, safeLimit).reverse();
    const messages = page.map((row) => this.mapSharedMessageRow(row));
    const oldestRow = page[0];
    const nextCursor = hasMore && oldestRow ? Buffer.from(JSON.stringify({ createdAt: String(oldestRow.created_at), rowid: Number(oldestRow.rowid) })).toString('base64url') : null;
    const totalCount = Number((this.database.prepare('SELECT COUNT(*) AS count FROM shared_messages WHERE (? IS NULL OR conversation_id = ?)')
      .get(conversationId ?? null, conversationId ?? null) as { count: number }).count);
    return { messages, nextCursor, totalCount };
  }

  /**
   * Loops listSharedMessages page by page until exhausted. For internal logic
   * that genuinely needs the whole conversation (or, with no conversationId,
   * the whole table) rather than a bounded page — use sparingly, and prefer a
   * targeted lookup (getSharedMessageById, listQueuedConversationIds) when one
   * exists instead of pulling everything into memory.
   */
  listAllSharedMessages(conversationId?: string): SharedMessage[] {
    const batches: SharedMessage[][] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = this.listSharedMessages(500, cursor, conversationId);
      batches.push(page.messages);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return batches.reverse().flat();
  }

  getSharedMessageById(id: string): SharedMessage | null {
    const row = this.database.prepare('SELECT * FROM shared_messages WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return row ? this.mapSharedMessageRow(row) : null;
  }

  /**
   * Turns a raw user query into a safe FTS5 MATCH expression: every
   * whitespace-separated token is individually double-quoted (with internal
   * `"` doubled per SQLite string-escaping rules), which makes FTS5 treat it
   * as a literal string rather than syntax — so special characters and
   * reserved keywords (`*`, `:`, `AND`, `OR`, `NOT`, unbalanced quotes, ...)
   * can never produce a MATCH syntax error. Quoted tokens are implicitly
   * ANDed by FTS5, i.e. "find rows containing all of these words".
   */
  private buildFtsMatchQuery(query: string): string | null {
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
  }

  /**
   * Combined, ranked full-text search over shared conversation titles and
   * message bodies (see the conversations_fts/messages_fts tables and their
   * sync triggers in database.ts). Each side is queried and ranked
   * separately with FTS5 bm25() (lower = more relevant), then merged and
   * re-sorted in application code — simplest way to produce one ranked list
   * from two independent FTS tables without a fragile cross-table UNION.
   */
  searchShared(query: string, limit = 20): SharedSearchResult[] {
    const matchQuery = this.buildFtsMatchQuery(query);
    if (!matchQuery) return [];
    const safeLimit = Math.max(1, Math.min(100, limit));

    const conversationRows = this.database.prepare(`
      SELECT
        shared_conversations.id AS conversation_id,
        shared_conversations.title AS conversation_title,
        snippet(conversations_fts, 1, '[', ']', '…', 10) AS snippet,
        bm25(conversations_fts) AS rank
      FROM conversations_fts
      JOIN shared_conversations ON shared_conversations.id = conversations_fts.id
      WHERE conversations_fts MATCH ? AND shared_conversations.deleted_at IS NULL
      ORDER BY rank LIMIT ?
    `).all(matchQuery, safeLimit) as Array<{ conversation_id: string; conversation_title: string; snippet: string; rank: number }>;

    const messageRows = this.database.prepare(`
      SELECT
        shared_messages.id AS message_id,
        shared_messages.conversation_id AS conversation_id,
        COALESCE(shared_conversations.title, '') AS conversation_title,
        snippet(messages_fts, 1, '[', ']', '…', 10) AS snippet,
        bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN shared_messages ON shared_messages.id = messages_fts.id
      LEFT JOIN shared_conversations ON shared_conversations.id = shared_messages.conversation_id
      WHERE messages_fts MATCH ? AND (shared_conversations.id IS NULL OR shared_conversations.deleted_at IS NULL)
      ORDER BY rank LIMIT ?
    `).all(matchQuery, safeLimit) as Array<{ message_id: string; conversation_id: string | null; conversation_title: string; snippet: string; rank: number }>;

    const results: SharedSearchResult[] = [
      ...conversationRows.map((row) => ({
        type: 'conversation' as const,
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        messageId: null,
        snippet: row.snippet,
        rank: row.rank,
      })),
      ...messageRows
        .filter((row) => row.conversation_id !== null)
        .map((row) => ({
          type: 'message' as const,
          conversationId: row.conversation_id as string,
          conversationTitle: row.conversation_title,
          messageId: row.message_id,
          snippet: row.snippet,
          rank: row.rank,
        })),
    ];
    results.sort((a, b) => a.rank - b.rank);
    return results.slice(0, safeLimit);
  }

  /** Read-only retrieval over the complete durable Workbench record for agents. */
  searchActivityMemory(query: string, limit = 40): Array<{ source: 'message' | 'activity' | 'run'; title: string; body: string; createdAt: string }> {
    const needle = `%${query.trim().replace(/[%_]/g, '')}%`;
    if (query.trim().length < 2) return [];
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = this.database.prepare(`
      SELECT 'message' AS source, COALESCE(c.title, 'Conversation') AS title, m.body AS body, m.created_at AS created_at
        FROM shared_messages m LEFT JOIN shared_conversations c ON c.id = m.conversation_id
        WHERE m.body LIKE ? AND (c.deleted_at IS NULL OR c.id IS NULL)
      UNION ALL
      SELECT 'activity', w.title, a.body, a.created_at FROM activities a JOIN work_items w ON w.id = a.work_item_id
        WHERE a.body LIKE ? OR w.title LIKE ?
      UNION ALL
      SELECT 'run', w.title, COALESCE(r.output, r.instructions, r.error), r.created_at FROM agent_runs r JOIN work_items w ON w.id = r.work_item_id
        WHERE r.output LIKE ? OR r.instructions LIKE ? OR r.error LIKE ? OR w.title LIKE ?
      ORDER BY created_at DESC LIMIT ?
    `).all(needle, needle, needle, needle, needle, needle, needle, safeLimit) as Array<{ source: 'message' | 'activity' | 'run'; title: string; body: string; created_at: string }>;
    return rows.map((row) => ({ source: row.source, title: row.title, body: row.body.slice(0, 4_000), createdAt: row.created_at }));
  }

  listQueuedConversationIds(): string[] {
    const rows = this.database.prepare("SELECT DISTINCT conversation_id FROM shared_messages WHERE status = 'queued'").all() as Array<{ conversation_id: string | null }>;
    return rows.map((row) => row.conversation_id).filter((id): id is string => id !== null);
  }

  createSharedMessage(author: SharedMessage['author'], body: string, status: SharedMessage['status'] = 'completed', conversationId?: string, attachments: SharedAttachment[] = [], dispatchTarget = 'none', executionProfile: AgentRun['executionProfile'] = null): SharedMessage {
    const conversation = conversationId ? this.listConversations('all').find((item) => item.id === conversationId) : this.ensureDefaultConversation();
    if (!conversation) throw new Error('Conversation not found.');
    const message: SharedMessage = {
      id: randomUUID(), conversationId: conversation.id, author, body, pinned: false, status, error: '', createdAt: new Date().toISOString(), completedAt: ['completed', 'failed', 'canceled'].includes(status) ? new Date().toISOString() : null, attachments, model: null, executionProfile, inputTokens: null, outputTokens: null, estimatedCostUsd: null, fallbackFrom: null, fallbackReason: null, dispatchTarget: dispatchTarget as SharedMessage['dispatchTarget'],
      attempt: 0, maxAttempts: 3, nextAttemptAt: null,
    };
    this.database.prepare(`
      INSERT INTO shared_messages (id, conversation_id, author, body, pinned, status, error, attachments_json, dispatch_target, created_at, completed_at, execution_profile)
      VALUES (?, ?, ?, ?, 0, ?, '', ?, ?, ?, ?, ?)
    `).run(message.id, message.conversationId, author, body, status, JSON.stringify(attachments), dispatchTarget, message.createdAt, message.completedAt, executionProfile);
    this.database.prepare('UPDATE shared_conversations SET updated_at = ?, title = CASE WHEN title = ? AND ? = ? THEN substr(?, 1, 80) ELSE title END WHERE id = ?')
      .run(message.createdAt, 'New conversation', author, 'jeffrey', body, message.conversationId);
    return message;
  }

  nextQueuedSharedTurn(conversationId: string, busyAgents: ReadonlySet<AgentRun['agent']> = new Set()): { message: SharedMessage; dispatchTarget: 'auto' | 'codex' | 'claude' | 'both' } | null {
    const rows = this.database.prepare(`SELECT id, dispatch_target FROM shared_messages
      WHERE conversation_id = ? AND author = 'jeffrey' AND status = 'queued'
      ORDER BY created_at ASC, rowid ASC`).all(conversationId) as Array<{ id: string; dispatch_target: string }>;
    for (const row of rows) {
      if (!['auto', 'codex', 'claude', 'both'].includes(row.dispatch_target)) continue;
      const dispatchTarget = row.dispatch_target as 'auto' | 'codex' | 'claude' | 'both';
      const agents = dispatchTarget === 'both' ? ['codex', 'claude'] as const
        : dispatchTarget === 'auto' ? [this.selectBalancedAgent('codex')] : [dispatchTarget];
      if (agents.some((agent) => busyAgents.has(agent))) continue;
      const message = this.getSharedMessageById(row.id);
      if (message) return { message, dispatchTarget };
    }
    return null;
  }

  promoteQueuedSharedMessage(id: string): SharedMessage | null {
    const message = this.getSharedMessageById(id);
    if (!message || message.status !== 'queued') return null;
    const earliest = this.database.prepare(`SELECT MIN(created_at) AS value FROM shared_messages WHERE conversation_id = ? AND status = 'queued'`)
      .get(message.conversationId) as { value: string | null };
    const promotedAt = earliest.value && earliest.value <= message.createdAt
      ? new Date(new Date(earliest.value).getTime() - 1).toISOString()
      : message.createdAt;
    this.database.prepare('UPDATE shared_messages SET created_at = ? WHERE id = ?').run(promotedAt, id);
    return this.getSharedMessageById(id);
  }

  updateSharedMessage(id: string, changes: { pinned?: boolean; body?: string; status?: SharedMessage['status']; error?: string; author?: SharedMessage['author']; model?: string; executionProfile?: SharedMessage['executionProfile']; inputTokens?: number | null; outputTokens?: number | null; estimatedCostUsd?: number | null; fallbackFrom?: AgentRun['agent'] | null; fallbackReason?: string | null; completedAt?: string | null }): SharedMessage | null {
    // A retry reuses the same message row. Never let the error from the prior
    // attempt survive a successful or user-canceled terminal transition.
    const error = changes.error ?? (changes.status === 'completed' || changes.status === 'canceled' ? '' : undefined);
    const entries = Object.entries({
      pinned: changes.pinned === undefined ? undefined : Number(changes.pinned),
      body: changes.body, status: changes.status, error, author: changes.author, model: changes.model, execution_profile: changes.executionProfile,
      input_tokens: changes.inputTokens, output_tokens: changes.outputTokens, estimated_cost_usd: changes.estimatedCostUsd, fallback_from: changes.fallbackFrom, fallback_reason: changes.fallbackReason,
      completed_at: changes.completedAt ?? (changes.status && ['completed', 'failed', 'canceled'].includes(changes.status) ? new Date().toISOString() : undefined),
    }).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
    if (entries.length) this.database.prepare(`UPDATE shared_messages SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    return this.getSharedMessageById(id);
  }

  /**
   * Persists a completed agent result as a scoped handoff. This is deliberately
   * separate from the transcript: the next Codex or Claude process gets the
   * same bounded, durable record even after a restart or a task continuation.
   */
  recordAgentHandoff(conversationId: string, messageId: string, author: 'codex' | 'claude' | 'system', body: string): void {
    const text = body.trim();
    if (!text) return;
    const conversation = this.listConversations('all').find((item) => item.id === conversationId);
    this.database.prepare(`INSERT INTO agent_handoffs (id, conversation_id, work_item_id, message_id, author, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET author = excluded.author, body = excluded.body, created_at = excluded.created_at`)
      .run(randomUUID(), conversationId, conversation?.workItemId ?? null, messageId, author, text.slice(0, 4_000), new Date().toISOString());
    this.recordSharedBriefEntry(conversationId, messageId, author, author === 'system' ? 'synthesis' : 'agent_handoff', text);
  }

  /** A concise, structured ledger of user decisions and agent evidence. */
  recordSharedBriefEntry(conversationId: string, messageId: string, author: string, kind: 'decision' | 'agent_handoff' | 'synthesis', body: string): void {
    const text = body.trim().slice(0, 4_000);
    if (!text) return;
    const conversation = this.listConversations('all').find((item) => item.id === conversationId);
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const matching = (expression: RegExp) => lines.filter((line) => expression.test(line)).slice(0, 12).join('\n');
    const facts = kind === 'decision' ? '' : text;
    const decisions = kind === 'decision' ? text : matching(/\b(?:decid|will |should |must |approved?|use |do not|don't)\b/i);
    const blockers = matching(/\b(?:blocked|blocker|cannot|can't|unable|failed|missing|error)\b/i);
    const evidence = matching(/\b(?:verified|test(?:ed|s)?|passed|ran |build|changed|edited|fixed)\b/i);
    this.database.prepare(`INSERT INTO shared_brief_entries (id, conversation_id, work_item_id, message_id, author, kind, facts, decisions, blockers, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET author = excluded.author, kind = excluded.kind, facts = excluded.facts, decisions = excluded.decisions, blockers = excluded.blockers, evidence = excluded.evidence, created_at = excluded.created_at`)
      .run(randomUUID(), conversationId, conversation?.workItemId ?? null, messageId, author, kind, facts, decisions, blockers, evidence, new Date().toISOString());
  }

  /**
   * Returns only handoffs relevant to this conversation or its linked task.
   * Scope is explicit so unrelated rooms cannot leak context into an agent run.
   */
  getSharedContext(_excludeConversationId?: string, scope?: { workItemId?: string; conversationId?: string }): string {
    // Compatibility-only diagnostic path. Agent runners always provide a
    // scope; never use this global scrape to build an agent prompt.
    if (!scope?.conversationId && !scope?.workItemId) {
      const recent = this.listSharedMessages(120).messages.filter((message) => message.status === 'completed' && message.body).slice(-2);
      return ['Recent shared room:', recent.map((message) => `${message.author}: ${message.body.slice(0, 600)}`).join('\n') || 'No recent conversation.'].join('\n');
    }
    const rows = this.database.prepare(`SELECT author, kind, facts, decisions, blockers, evidence, created_at FROM shared_brief_entries
      WHERE (? IS NOT NULL AND conversation_id = ?) OR (? IS NOT NULL AND work_item_id = ?)
      ORDER BY created_at DESC LIMIT 10`)
      .all(scope.conversationId ?? null, scope.conversationId ?? null, scope.workItemId ?? null, scope.workItemId ?? null) as Array<{ author: string; kind: string; facts: string; decisions: string; blockers: string; evidence: string; created_at: string }>;
    const entries = rows.reverse().map((row) => [
      `- ${row.kind} from ${row.author}:`,
      row.facts ? `  Facts: ${row.facts.slice(0, 1_200)}` : '',
      row.decisions ? `  Decisions: ${row.decisions.slice(0, 700)}` : '',
      row.blockers ? `  Blockers: ${row.blockers.slice(0, 700)}` : '',
      row.evidence ? `  Evidence: ${row.evidence.slice(0, 700)}` : '',
    ].filter(Boolean).join('\n'));
    const editableBrief = scope.conversationId ? this.getConversation(scope.conversationId)?.sharedBrief?.trim() : '';
    return ['Structured shared brief for Codex and Claude:', editableBrief ? `Jeffrey's maintained brief:\n${editableBrief}` : '', entries.length ? entries.join('\n\n') : 'No completed handoffs or decisions yet.'].filter(Boolean).join('\n\n');
  }

  list(): WorkItem[] {
    return this.listStack('attention');
  }

  listWorkbench(): WorkItem[] {
    return this.listStack('workbench');
  }

  private listStack(stack: 'attention' | 'workbench'): WorkItem[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM work_items
        WHERE is_queued = 1 AND archived_at IS NULL AND deleted_at IS NULL AND status NOT IN ('done', 'canceled')
          AND stack = ?
        ORDER BY queue_position ASC, created_at ASC
      `)
      .all(stack) as unknown as WorkItemRow[];
    return this.withDependencies(this.withLineage(rows.map((row) => this.withAgentOutcome(mapWorkItem(row)))));
  }

  listArchived(): WorkItem[] {
    const rows = this.database.prepare(`SELECT * FROM work_items WHERE archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC`).all() as unknown as WorkItemRow[];
    return this.withDependencies(this.withLineage(rows.map((row) => this.withAgentOutcome(mapWorkItem(row)))));
  }

  listPage(view: 'active' | 'workbench' | 'archive', limit: number, cursor: string | null, filter: WorkItemFilter): WorkItemPage {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const normalizedFilter = { ...filter, projectNames: [...new Set(filter.projectNames)].sort(), statuses: [...new Set(filter.statuses)].sort(), assignees: [...new Set(filter.assignees)].sort(), sources: [...new Set(filter.sources)].sort(), labels: [...new Set(filter.labels)].sort(), dueStates: [...new Set(filter.dueStates)].sort() };
    const fingerprint = JSON.stringify(normalizedFilter);
    const needle = normalizedFilter.query ? `%${normalizedFilter.query}%` : null;
    type WorkItemCursor = { position?: number; archivedAt?: string; id: string; view: string; fingerprint: string };
    let cursorValues: WorkItemCursor | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as WorkItemCursor; } catch { throw new Error('Invalid work-item cursor.'); }
      if (!cursorValues?.id || cursorValues.view !== view || cursorValues.fingerprint !== fingerprint) throw new Error('Work-item cursor does not match this view and filter.');
    }
    const search = `(? IS NULL OR title LIKE ? COLLATE NOCASE OR source_identifier LIKE ? COLLATE NOCASE OR project_name LIKE ? COLLATE NOCASE)`;
    const searchArgs = [needle, needle, needle, needle];
    const active = `is_queued = 1 AND archived_at IS NULL AND deleted_at IS NULL AND status NOT IN ('done', 'canceled') AND stack = 'attention'`;
    const workbench = `is_queued = 1 AND archived_at IS NULL AND deleted_at IS NULL AND status NOT IN ('done', 'canceled') AND stack = 'workbench'`;
    const where = view === 'active' ? active : view === 'workbench' ? workbench : 'archived_at IS NOT NULL AND deleted_at IS NULL';
    const clauses: string[] = []; const args: string[] = [];
    const addIn = (column: string, values: string[]) => { if (values.length) { clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`); args.push(...values); } };
    addIn('project_name', normalizedFilter.projectNames); addIn('status', normalizedFilter.statuses); addIn('source', normalizedFilter.sources);
    if (normalizedFilter.assignees.length) { clauses.push(`EXISTS (SELECT 1 FROM json_each(work_items.assignees_json) WHERE value IN (${normalizedFilter.assignees.map(() => '?').join(', ')}))`); args.push(...normalizedFilter.assignees); }
    if (normalizedFilter.labels.length) { clauses.push(`EXISTS (SELECT 1 FROM json_each(work_items.labels_json) WHERE value IN (${normalizedFilter.labels.map(() => '?').join(', ')}))`); args.push(...normalizedFilter.labels); }
    if (normalizedFilter.dueStates.length) {
      const today = localCalendarDate(Date.now(), this.timeZone); const due: string[] = [];
      if (normalizedFilter.dueStates.includes('overdue')) { due.push(`due_date IS NOT NULL AND date(due_date) < date(?)`); args.push(today); }
      if (normalizedFilter.dueStates.includes('due_today')) { due.push(`due_date IS NOT NULL AND date(due_date) = date(?)`); args.push(today); }
      if (normalizedFilter.dueStates.includes('due_later')) { due.push(`due_date IS NOT NULL AND date(due_date) > date(?)`); args.push(today); }
      if (normalizedFilter.dueStates.includes('unscheduled')) due.push(`(due_date IS NULL OR due_date = '')`);
      clauses.push(`(${due.join(' OR ')})`);
    }
    const filters = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
    const cursorClause = view !== 'archive' ? `(? IS NULL OR queue_position > ? OR (queue_position = ? AND id > ?))` : `(? IS NULL OR archived_at < ? OR (archived_at = ? AND id < ?))`;
    const cursorArgs = view !== 'archive' ? [cursorValues?.id ?? null, cursorValues?.position ?? null, cursorValues?.position ?? null, cursorValues?.id ?? null] : [cursorValues?.id ?? null, cursorValues?.archivedAt ?? null, cursorValues?.archivedAt ?? null, cursorValues?.id ?? null];
    const order = view !== 'archive' ? 'queue_position ASC, id ASC' : 'archived_at DESC, id DESC';
    const rows = this.database.prepare(`SELECT * FROM work_items WHERE ${where} AND ${search}${filters} AND ${cursorClause} ORDER BY ${order} LIMIT ?`).all(...searchArgs, ...args, ...cursorArgs, safeLimit + 1) as unknown as WorkItemRow[];
    const pageRows = rows.slice(0, safeLimit); const last = pageRows.at(-1);
    const nextCursor = rows.length > safeLimit && last ? Buffer.from(JSON.stringify(view !== 'archive' ? { position: last.queue_position, id: last.id, view, fingerprint } : { archivedAt: last.archived_at, id: last.id, view, fingerprint })).toString('base64url') : null;
    const totalCount = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM work_items WHERE ${where} AND ${search}${filters}`).get(...searchArgs, ...args) as { count: number }).count);
    return { items: this.withDependencies(this.withLineage(pageRows.map((row) => this.withAgentOutcome(mapWorkItem(row))))), nextCursor, totalCount, proposal: view === 'active' ? this.getPendingProposal('attention') : view === 'workbench' ? this.getPendingProposal('workbench') : null };
  }

  listSavedFilters(view?: SavedWorkItemFilterView): SavedWorkItemFilter[] {
    const rows = this.database.prepare(`SELECT * FROM saved_work_item_filters ${view ? 'WHERE view = ?' : ''} ORDER BY sort_order ASC, created_at ASC, id ASC`).all(...(view ? [view] : [])) as unknown as SavedWorkItemFilterRow[];
    return rows.map(mapSavedWorkItemFilter);
  }

  createSavedFilter(input: { name: string; view: SavedWorkItemFilterView; filter: WorkItemFilter }): SavedWorkItemFilter {
    const now = new Date().toISOString(); const id = randomUUID(); const sortOrder = Number((this.database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM saved_work_item_filters WHERE view = ?').get(input.view) as { value: number }).value);
    this.database.prepare('INSERT INTO saved_work_item_filters (id, name, view, filter_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, input.name, input.view, JSON.stringify(input.filter), sortOrder, now, now);
    return this.listSavedFilters(input.view).find((filter) => filter.id === id)!;
  }

  updateSavedFilter(id: string, changes: { name?: string; filter?: WorkItemFilter; sortOrder?: number }): SavedWorkItemFilter | null {
    const current = this.database.prepare('SELECT * FROM saved_work_item_filters WHERE id = ?').get(id) as SavedWorkItemFilterRow | undefined;
    if (!current) return null;
    const entries: Array<[string, string | number]> = [];
    if (changes.name !== undefined) entries.push(['name', changes.name]); if (changes.filter !== undefined) entries.push(['filter_json', JSON.stringify(changes.filter)]); if (changes.sortOrder !== undefined) entries.push(['sort_order', changes.sortOrder]);
    this.database.prepare(`UPDATE saved_work_item_filters SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value), new Date().toISOString(), id);
    return this.listSavedFilters(current.view).find((filter) => filter.id === id)!;
  }

  deleteSavedFilter(id: string): boolean { return Number(this.database.prepare('DELETE FROM saved_work_item_filters WHERE id = ?').run(id).changes) > 0; }

  getWorkItemCounts(): { active: number; workbench: number; archive: number } {
    const row = this.database.prepare(`SELECT
      SUM(CASE WHEN is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled') AND stack = 'attention' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled') AND stack = 'workbench' THEN 1 ELSE 0 END) AS workbench,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archive FROM work_items WHERE deleted_at IS NULL`).get() as { active: number | null; workbench: number | null; archive: number | null };
    return { active: Number(row.active ?? 0), workbench: Number(row.workbench ?? 0), archive: Number(row.archive ?? 0) };
  }

  get(id: string): WorkItem | null {
    const row = this.database.prepare('SELECT * FROM work_items WHERE id = ? AND deleted_at IS NULL').get(id) as
      | WorkItemRow
      | undefined;
    return row ? this.withDependencies(this.withLineage([this.withAgentOutcome(mapWorkItem(row))]))[0] : null;
  }

  private dependencyFromItem(item: WorkItem): WorkItemDependency {
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      archivedAt: item.archivedAt,
      completedAt: item.completedAt,
      // Archiving incomplete work does not satisfy a prerequisite. Only an
      // explicit terminal lifecycle state opens the execution gate.
      isOpen: item.completedAt === null && item.status !== 'done' && item.status !== 'canceled',
    };
  }

  /** Adds dependency summaries in one query so queue reads stay bounded. */
  private withDependencies(items: WorkItem[]): WorkItem[] {
    if (!items.length) return items;
    const ids = items.map((item) => item.id);
    const rows = this.database.prepare(`
      SELECT dependency.work_item_id AS dependent_id, blocker.*
      FROM work_item_dependencies dependency
      JOIN work_items blocker ON blocker.id = dependency.blocker_work_item_id
      WHERE dependency.work_item_id IN (${ids.map(() => '?').join(', ')})
        AND blocker.deleted_at IS NULL AND blocker.archived_at IS NULL
      ORDER BY dependency.created_at ASC, blocker.title COLLATE NOCASE ASC, blocker.rowid ASC
    `).all(...ids) as unknown as Array<WorkItemRow & { dependent_id: string }>;
    const byDependent = new Map<string, WorkItemDependency[]>();
    for (const row of rows) {
      const dependencies = byDependent.get(row.dependent_id) ?? [];
      dependencies.push(this.dependencyFromItem(mapWorkItem(row)));
      byDependent.set(row.dependent_id, dependencies);
    }
    return items.map((item) => ({ ...item, blockedBy: byDependent.get(item.id) ?? [] }));
  }

  listDependencies(id: string): WorkItemDependency[] {
    return this.get(id)?.blockedBy ?? [];
  }

  listOpenDependencies(id: string): WorkItemDependency[] {
    return this.listDependencies(id).filter((dependency) => dependency.isOpen);
  }

  listBlockedWork(id: string): WorkItemDependency[] {
    const rows = this.database.prepare(`
      SELECT dependent.* FROM work_item_dependencies dependency
      JOIN work_items dependent ON dependent.id = dependency.work_item_id
      WHERE dependency.blocker_work_item_id = ? AND dependent.deleted_at IS NULL AND dependent.archived_at IS NULL
      ORDER BY dependent.title COLLATE NOCASE ASC, dependent.rowid ASC
    `).all(id) as unknown as WorkItemRow[];
    return rows.map((row) => this.dependencyFromItem(mapWorkItem(row)));
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
    return this.withDependencies(this.withLineage(rows.map((row) => this.withAgentOutcome(mapWorkItem(row)))));
  }

  private replaceDependencyRows(workItemId: string, blockerIds: string[]): void {
    const uniqueIds = [...new Set(blockerIds)];
    if (uniqueIds.includes(workItemId)) throw new WorkItemDependencyError('A task cannot depend on itself.');
    if (uniqueIds.length) {
      const rows = this.database.prepare(`SELECT id FROM work_items WHERE id IN (${uniqueIds.map(() => '?').join(', ')}) AND deleted_at IS NULL AND archived_at IS NULL`).all(...uniqueIds) as Array<{ id: string }>;
      if (rows.length !== uniqueIds.length) throw new WorkItemDependencyError('Every prerequisite must reference an existing task.');
    }

    this.database.prepare('DELETE FROM work_item_dependencies WHERE work_item_id = ?').run(workItemId);
    const insert = this.database.prepare('INSERT INTO work_item_dependencies (work_item_id, blocker_work_item_id, created_at) VALUES (?, ?, ?)');
    const now = new Date().toISOString();
    for (const blockerId of uniqueIds) insert.run(workItemId, blockerId, now);

    const cycle = this.database.prepare(`
      WITH RECURSIVE reachable(start_id, next_id) AS (
        SELECT work_item_id, blocker_work_item_id FROM work_item_dependencies
        UNION
        SELECT reachable.start_id, dependency.blocker_work_item_id
        FROM reachable
        JOIN work_item_dependencies dependency ON dependency.work_item_id = reachable.next_id
      )
      SELECT 1 AS found FROM reachable WHERE start_id = next_id LIMIT 1
    `).get() as { found: number } | undefined;
    if (cycle) throw new WorkItemDependencyError('Task dependencies cannot contain a cycle.');
  }

  replaceDependencies(workItemId: string, blockerIds: string[]): WorkItemDependency[] {
    if (!this.get(workItemId)) throw new WorkItemDependencyError('Work item not found.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.replaceDependencyRows(workItemId, blockerIds);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.listDependencies(workItemId);
  }

  /** Adds compact relationship context without changing queue order. */
  private withLineage(items: WorkItem[]): WorkItem[] {
    if (!items.length) return items;
    const ids = items.map((item) => item.id);
    const placeholders = ids.map(() => '?').join(', ');
    const countRows = this.database.prepare(`
      SELECT parent_work_item_id AS parentId, COUNT(*) AS followUpCount,
        SUM(CASE WHEN archived_at IS NULL AND status NOT IN ('done', 'canceled') THEN 1 ELSE 0 END) AS openFollowUpCount
      FROM work_items WHERE parent_work_item_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY parent_work_item_id
    `).all(...ids) as Array<{ parentId: string; followUpCount: number; openFollowUpCount: number }>;
    const parentIds = [...new Set(items.flatMap((item) => item.parentWorkItemId ? [item.parentWorkItemId] : []))];
    const parentTitles = new Map<string, string>();
    if (parentIds.length) {
      const parentPlaceholders = parentIds.map(() => '?').join(', ');
      const parents = this.database.prepare(`SELECT id, title FROM work_items WHERE id IN (${parentPlaceholders}) AND deleted_at IS NULL AND archived_at IS NULL`).all(...parentIds) as Array<{ id: string; title: string }>;
      for (const parent of parents) parentTitles.set(parent.id, parent.title);
    }
    const counts = new Map(countRows.map((row) => [row.parentId, row]));
    return items.map((item) => {
      const count = counts.get(item.id);
      const lineage: WorkItemLineage = {
        parentTitle: item.parentWorkItemId ? parentTitles.get(item.parentWorkItemId) ?? null : null,
        followUpCount: count?.followUpCount ?? 0,
        openFollowUpCount: count?.openFollowUpCount ?? 0,
      };
      return { ...item, lineage };
    });
  }

  private withAgentOutcome(item: WorkItem): WorkItem {
    const discoveredProviders = this.database.prepare("SELECT DISTINCT provider FROM discovery_candidates WHERE work_item_id = ? AND status IN ('converted', 'merged') ORDER BY provider").all(item.id) as Array<{ provider: string }>;
    const normalizedProviders = discoveredProviders.map(({ provider }) => provider === 'github' ? 'GitHub' : provider === 'confluence' ? 'Atlassian' : provider.charAt(0).toUpperCase() + provider.slice(1));
    const classification = this.getClassification(item.id);
    const latest = this.database.prepare(`SELECT created_at, kind FROM agent_runs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(item.id) as { created_at: string; kind: AgentRun['kind'] } | undefined;
    item = {
      ...item,
      sourceTags: [...new Set([...item.sourceTags.filter((tag) => tag !== 'Manual' || normalizedProviders.length === 0), ...normalizedProviders])],
      classificationKind: classification?.kind ?? null,
      classificationComplex: classification?.complex ?? false,
    };
    if (!latest) return item;
    const recentStatuses = this.database.prepare(`
      SELECT status FROM agent_runs
      WHERE work_item_id = ? AND julianday(created_at) >= julianday(?) - (2.0 / 86400.0)
    `).all(item.id, latest.created_at) as Array<{ status: AgentRun['status'] }>;
    const agentOutcome: WorkItem['agentOutcome'] =
      recentStatuses.some(({ status }) => status === 'queued' || status === 'running') ? null
        : recentStatuses.some(({ status }) => status === 'failed' || status === 'canceled') ? 'needs_attention'
          : recentStatuses.some(({ status }) => status === 'completed')
            ? (this.getPendingExecutionPlan(item.id) ? 'follow_ups' : 'finished')
            : null;
    return { ...item, agentOutcome };
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
    return this.withDependencies(this.withLineage(rows.map((row) => this.withAgentOutcome(mapWorkItem(row)))));
  }

  queueLinearItem(id: string): WorkItem | null {
    const item = this.get(id);
    if (!item || item.source !== 'linear') return null;
    this.database
      .prepare('UPDATE work_items SET is_queued = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    this.reorder([id, ...this.list().map((queued) => queued.id).filter((queuedId) => queuedId !== id)]);
    this.addActivity(id, 'system', 'queued', 'Added to the Workbench queue.');
    return this.get(id);
  }

  reorder(orderedItemIds: string[], stack?: 'attention' | 'workbench', change?: { actor: QueueOrderChange['actor']; reason: string }): WorkItem[] {
    const inferredStack = stack ?? this.get(orderedItemIds[0] ?? '')?.stack ?? 'attention';
    const stackItems = inferredStack === 'workbench' ? this.listWorkbench() : this.list();
    const currentIds = stackItems.map((item) => item.id);
    if (currentIds.length !== orderedItemIds.length || !currentIds.every((id) => orderedItemIds.includes(id))) {
      throw new Error('Queue order must contain every active queued item exactly once.');
    }
    const apply = () => {
      const statement = this.database.prepare('UPDATE work_items SET queue_position = ?, updated_at = ? WHERE id = ?');
      const now = new Date().toISOString();
      orderedItemIds.forEach((id, index) => statement.run(index + 1, now, id));
      // Movements are journalled so any of them can be undone, not just the ones
      // that arrived as a proposal. Reorders that merely re-seat a task the caller
      // just added or restored pass no `change` and are deliberately not journalled:
      // their snapshot describes a different set of tasks, so replaying it would
      // drop or resurrect work. No-ops are skipped so undo always lands on a change
      // Jeffrey would actually notice.
      if (change && currentIds.some((id, index) => id !== orderedItemIds[index])) {
        this.database.prepare(`
          INSERT INTO queue_order_history (id, stack, actor, reason, previous_order_json, new_order_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), inferredStack, change.actor, change.reason, JSON.stringify(currentIds), JSON.stringify(orderedItemIds), now);
      }
      this.incrementQueueVersion(inferredStack);
    };
    this.transaction(apply);
    return inferredStack === 'workbench' ? this.listWorkbench() : this.list();
  }

  listQueueHistory(stack: 'attention' | 'workbench' = 'attention', limit = 20): QueueOrderChange[] {
    const rows = this.database.prepare('SELECT * FROM queue_order_history WHERE stack = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(stack, Math.max(1, Math.min(100, limit))) as Array<Record<string, string | null>>;
    return rows.map((row) => this.mapQueueOrderChange(row));
  }

  /**
   * Reverses the most recent ordering change that still describes today's stack.
   * Entries whose snapshot no longer matches (a task was added, completed, or
   * archived since) are skipped rather than force-applied, because replaying a
   * stale snapshot would silently drop or resurrect tasks.
   */
  undoLastQueueChange(stack: 'attention' | 'workbench' = 'attention'): { change: QueueOrderChange; items: WorkItem[] } | null {
    const currentVersion = this.queueVersion(stack);
    const currentIds = (stack === 'workbench' ? this.listWorkbench() : this.list()).map((item) => item.id);
    const rows = this.database.prepare('SELECT * FROM queue_order_history WHERE stack = ? AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 25')
      .all(stack) as Array<Record<string, string | null>>;
    for (const row of rows) {
      const change = this.mapQueueOrderChange(row);
      // Version + exact-order checks prevent an undo from replaying an old
      // snapshot after any intervening queue mutation.
      const applicable = currentVersion > 0 && change.newOrder.length === currentIds.length && change.newOrder.every((id, index) => id === currentIds[index]);
      if (!applicable) continue;
      return this.transaction(() => {
        // Re-read under the writer lock; another connection may have changed
        // the queue since the optimistic check above.
        if (this.queueVersion(stack) !== currentVersion) return null;
        const lockedIds = (stack === 'workbench' ? this.listWorkbench() : this.list()).map((item) => item.id);
        if (!change.newOrder.every((id, index) => id === lockedIds[index])) return null;
        const undoneAt = new Date().toISOString();
        const highWaterMark = Number((this.database.prepare('SELECT COALESCE(MAX(rowid), 0) AS mark FROM queue_order_history').get() as { mark: number }).mark);
        this.database.prepare('UPDATE queue_order_history SET undone_at = ? WHERE id = ? AND undone_at IS NULL').run(undoneAt, change.id);
        this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending' AND stack = ?").run(undoneAt, stack);
        const items = this.reorder(change.previousOrder, stack, { actor: 'jeffrey', reason: `Undo of: ${change.reason}` });
        this.database.prepare('UPDATE queue_order_history SET undone_at = ? WHERE rowid > ? AND undone_at IS NULL').run(undoneAt, highWaterMark);
        return { change: { ...change, undoneAt }, items };
      });
    }
    return null;
  }

  private mapQueueOrderChange(row: Record<string, string | null>): QueueOrderChange {
    return {
      id: row.id!, stack: row.stack as QueueOrderChange['stack'], actor: row.actor as QueueOrderChange['actor'],
      reason: row.reason ?? '', previousOrder: JSON.parse(row.previous_order_json!) as string[],
      newOrder: JSON.parse(row.new_order_json!) as string[], createdAt: row.created_at!, undoneAt: row.undone_at,
    };
  }

  move(itemId: string, neighbor: { beforeId?: string; afterId?: string }): WorkItem[] {
    const stack = this.get(itemId)?.stack ?? 'attention';
    const ids = (stack === 'workbench' ? this.listWorkbench() : this.list()).map((item) => item.id);
    const from = ids.indexOf(itemId);
    const neighborId = neighbor.beforeId ?? neighbor.afterId;
    const target = neighborId ? ids.indexOf(neighborId) : -1;
    if (from < 0 || target < 0 || itemId === neighborId) throw new Error('Queue item or neighbor not found.');
    ids.splice(from, 1);
    const updatedTarget = ids.indexOf(neighborId!);
    ids.splice(updatedTarget + (neighbor.afterId ? 1 : 0), 0, itemId);
    return this.reorder(ids, stack, { actor: 'jeffrey', reason: `Manually moved “${this.get(itemId)?.title ?? itemId}”.` });
  }

  moveForAttention(id: string, destination: 'top' | 'bottom', reason: string): WorkItem[] {
    const stack = this.get(id)?.stack ?? 'attention';
    const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
    const ids = stackItems.map((item) => item.id);
    if (!ids.includes(id) || ids.length < 2) return stackItems;
    const now = new Date().toISOString();
    this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending'").run(now);
    const without = ids.filter((itemId) => itemId !== id);
    this.reorder(destination === 'top' ? [id, ...without] : [...without, id], stack, { actor: 'agent', reason: `${destination === 'top' ? 'Promoted for attention' : 'Demoted while the agent works'}: ${reason}` });
    this.addActivity(id, 'system', 'queue_moved', `${destination === 'top' ? 'Promoted for attention' : 'Demoted while the agent works'}: ${reason}`);
    return stack === 'workbench' ? this.listWorkbench() : this.list();
  }

  getPendingProposal(stack: 'attention' | 'workbench' = 'attention'): QueueProposal | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE status = 'pending' AND stack = ? ORDER BY created_at DESC LIMIT 1").get(stack) as Record<string, string | null> | undefined;
    return row ? this.mapProposal(row) : null;
  }

  createProposal(orderedItemIds: string[], rationale: string, explanations: QueueItemExplanation[] = [], stack: 'attention' | 'workbench' = 'attention'): QueueProposal {
    const previousOrder = (stack === 'workbench' ? this.listWorkbench() : this.list()).map((item) => item.id);
    if (previousOrder.length !== orderedItemIds.length || !previousOrder.every((id) => orderedItemIds.includes(id))) {
      throw new Error('Proposal must contain every active queued item exactly once.');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.transaction(() => {
      this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending' AND stack = ?").run(now, stack);
      this.database.prepare(`
        INSERT INTO queue_proposals (id, stack, status, previous_order_json, proposed_order_json, rationale, explanations_json, queue_version, created_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(id, stack, JSON.stringify(previousOrder), JSON.stringify(orderedItemIds), rationale, JSON.stringify(explanations), this.queueVersion(stack), now);
    });
    return this.getPendingProposal(stack)!;
  }

  /**
   * Gathers everything the ranking engine needs in a fixed number of queries.
   * Kept in the repository so `queue-intelligence.ts` stays pure and testable.
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
    const lastPlan = this.database.prepare('SELECT created_at FROM queue_proposals ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined;
    const since = lastPlan?.created_at ?? new Date(now - 86_400_000).toISOString();
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
    const rows = this.database.prepare(`
      SELECT status, explanations_json FROM queue_proposals
      WHERE status IN ('accepted', 'rejected') AND explanations_json IS NOT NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{ status: 'accepted' | 'rejected'; explanations_json: string }>;
    return learnFeedbackWeights(rows.flatMap((row) => {
      try { return [{ status: row.status, explanations: JSON.parse(row.explanations_json) as QueueItemExplanation[] }]; }
      catch { return []; }
    }));
  }

  /** Ranks the current stack without touching it. Backs the "why this order" view. */
  explainQueue(now = Date.now()): QueuePlan {
    return planQueue(this.list(), this.buildQueueContext(now));
  }

  buildDailyProposal(now = Date.now(), stack: 'attention' | 'workbench' = 'attention'): QueueProposal {
    const items = stack === 'workbench' ? this.listWorkbench() : this.list();
    if (!items.length) throw new Error('Add at least one task before planning the stack.');
    const plan = planQueue(items, this.buildQueueContext(now));
    return this.createProposal(plan.orderedItemIds, plan.rationale, plan.explanations, stack);
  }

  getPendingExecutionPlan(workItemId: string): ExecutionPlan | null {
    const row = this.database.prepare("SELECT * FROM execution_plans WHERE work_item_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(workItemId) as Record<string, string | null> | undefined;
    return row ? this.mapExecutionPlan(row) : null;
  }

  listExecutionPlans(workItemId: string, status?: ExecutionPlan['status']): ExecutionPlan[] {
    const rows = this.database.prepare(`
      SELECT * FROM execution_plans
      WHERE work_item_id = ? AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC, id DESC
    `).all(workItemId, status ?? null, status ?? null) as Array<Record<string, string | null>>;
    return rows.map((row) => this.mapExecutionPlan(row));
  }

  private mapExecutionPlan(row: Record<string, string | null>): ExecutionPlan {
    return {
      id: row.id!, workItemId: row.work_item_id!, status: row.status as ExecutionPlan['status'],
      summary: row.summary!, tasks: JSON.parse(row.tasks_json!) as PlannedTask[],
      createdAt: row.created_at!, resolvedAt: row.resolved_at,
    };
  }

  createExecutionPlan(workItemId: string, summary: string, tasks: PlannedTask[]): ExecutionPlan {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare("UPDATE execution_plans SET status = 'rejected', resolved_at = ? WHERE work_item_id = ? AND status = 'pending'").run(now, workItemId);
    this.database.prepare(`INSERT INTO execution_plans (id, work_item_id, status, summary, tasks_json, created_at) VALUES (?, ?, 'pending', ?, ?, ?)`)
      .run(id, workItemId, summary, JSON.stringify(tasks), now);
    return this.getPendingExecutionPlan(workItemId)!;
  }

  resolveExecutionPlan(id: string, resolution: 'accepted' | 'rejected', selectedTaskIndexes?: number[], archiveParent = false): ExecutionPlan | null {
    const row = this.database.prepare("SELECT work_item_id FROM execution_plans WHERE id = ? AND status = 'pending'").get(id) as { work_item_id: string } | undefined;
    if (!row) return null;
    const plan = this.getPendingExecutionPlan(row.work_item_id);
    if (!plan) return null;
    return this.transaction(() => {
    if (resolution === 'accepted') {
      const parent = this.get(plan.workItemId)!;
      if (parent.archivedAt) return null;
      const selectedTasks = selectedTaskIndexes === undefined ? plan.tasks : plan.tasks.filter((_, index) => selectedTaskIndexes.includes(index));
      if (!selectedTasks.length) return null;
      const children = selectedTasks.map((task) => this.create({
        title: task.title, description: task.description, priority: 2, status: 'ready',
        projectName: parent.projectName, stack: parent.stack, workspacePath: task.workspacePath ?? parent.workspacePath, dueDate: null,
        parentWorkItemId: parent.id,
      }));
      const stack = parent.stack;
      const current = stack === 'workbench' ? this.listWorkbench() : this.list();
      const childIds = children.map((item) => item.id);
      const ordered = current.flatMap((item) => item.id === parent.id ? [item.id, ...childIds] : childIds.includes(item.id) ? [] : [item.id]);
      this.reorder(ordered, stack);
      this.addActivity(parent.id, 'jeffrey', 'decomposed', `Approved plan created ${selectedTasks.length} of ${plan.tasks.length} proposed tasks.`);
      if (archiveParent) this.archive(parent.id, false, true, { reason: 'the approved plan replaced it with follow-up tasks' });
    } else {
      // Rejecting a plan is as much a decision as approving one, and it used to
      // leave the task looking untouched after an agent had proposed a breakdown.
      this.addActivity(plan.workItemId, 'jeffrey', 'decomposed', `Rejected the proposed breakdown into ${plan.tasks.length} tasks.`);
    }
    const resolvedAt = new Date().toISOString();
    const changed = this.database.prepare('UPDATE execution_plans SET status = ?, resolved_at = ? WHERE id = ? AND status = \'pending\'').run(resolution, resolvedAt, id).changes;
    if (!changed) return null;
    return { ...plan, status: resolution, resolvedAt };
    });
  }

  resolveProposal(id: string, resolution: 'accepted' | 'rejected'): QueueProposal | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE id = ? AND status = 'pending'").get(id) as Record<string, string | null> | undefined;
    if (!row) return null;
    const proposal = this.mapProposal(row);
    const proposalVersion = Number(row.queue_version ?? 0);
    return this.transaction(() => {
      // Both choices are version-guarded. A stale reject has no queue side
      // effect, and a stale accept cannot overwrite a manual reorder.
      if (this.queueVersion(proposal.stack) !== proposalVersion) {
        const resolvedAt = new Date().toISOString();
        this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE id = ? AND status = 'pending'").run(resolvedAt, id);
        return { ...proposal, status: 'superseded', resolvedAt };
      }
      if (resolution === 'accepted') this.reorder(proposal.proposedOrder, proposal.stack, { actor: 'agent', reason: `Accepted the ${proposal.stack} stack proposal.` });
      const resolvedAt = new Date().toISOString();
      this.database.prepare('UPDATE queue_proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = \'pending\'').run(resolution, resolvedAt, id);
      return { ...proposal, status: resolution, resolvedAt };
    });
  }

  private mapProposal(row: Record<string, string | null>): QueueProposal {
    return {
      id: row.id!, status: row.status as QueueProposal['status'],
      stack: (row.stack as QueueProposal['stack']) ?? 'attention',
      previousOrder: JSON.parse(row.previous_order_json!) as string[],
      proposedOrder: JSON.parse(row.proposed_order_json!) as string[], rationale: row.rationale!,
      explanations: row.explanations_json ? JSON.parse(row.explanations_json) as QueueItemExplanation[] : [],
      createdAt: row.created_at!, resolvedAt: row.resolved_at,
    };
  }

  create(input: {
    title: string;
    description: string;
    priority: number;
    status: WorkItem['status'];
    projectName: string | null;
    stack?: WorkItem['stack'];
    workspacePath: string | null;
    dueDate: string | null;
    sourceUrl?: string | null;
    parentWorkItemId?: string | null;
  }): WorkItem {
    // Callers that predate the explicit field still express intent through the
    // project name, so it seeds the stack once here. After this insert the
    // stored value is authoritative and project renames never move the task.
    const stack: WorkItem['stack'] = input.stack ?? (input.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention');
    const id = randomUUID();
    const now = new Date().toISOString();
    const position = Number(
      (this.database.prepare('SELECT COALESCE(MAX(queue_position), 0) + 1 AS value FROM work_items').get() as {
        value: number;
      }).value,
    );

    this.database
      .prepare(`
        INSERT INTO work_items (
          id, title, description, status, priority, queue_position, source, is_queued,
          project_name, stack, workspace_path, due_date, source_url, parent_work_item_id, created_at, updated_at, last_touched_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.title,
        input.description,
        input.status,
        input.priority,
        position,
        input.projectName,
        stack,
        input.workspacePath,
        input.dueDate,
        input.sourceUrl ?? null,
        input.parentWorkItemId ?? null,
        now,
        now,
        now,
      );

    this.addActivity(id, 'system', 'created', 'Manual work item created.');
    const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
    this.reorder([id, ...stackItems.map((item) => item.id).filter((itemId) => itemId !== id)], stack);
    return this.get(id)!;
  }

  createFollowUp(parentId: string, title: string, description: string): WorkItem | null {
    const parent = this.get(parentId);
    if (!parent) return null;
    const followUp = this.create({
      title, description, priority: 2, status: 'ready', projectName: parent.projectName, stack: parent.stack,
      workspacePath: parent.workspacePath, dueDate: null, sourceUrl: null, parentWorkItemId: parent.id,
    });
    const stack = parent.stack;
    const activeIds = (stack === 'workbench' ? this.listWorkbench() : this.list()).map((item) => item.id);
    const withoutFollowUp = activeIds.filter((id) => id !== followUp.id);
    const parentIndex = withoutFollowUp.indexOf(parentId);
    withoutFollowUp.splice(parentIndex >= 0 ? parentIndex + 1 : 0, 0, followUp.id);
    this.reorder(withoutFollowUp, stack);
    this.addActivity(parentId, 'jeffrey', 'follow_up', `Created follow-up task: ${title}`);
    this.addActivity(followUp.id, 'system', 'follow_up', `Created as a follow-up to: ${parent.title}`);
    return this.get(followUp.id);
  }

  /**
   * `context` names who applied the move and, for cascades, what forced it. The
   * repository is the only place every archive path converges, so logging here
   * covers the HTTP routes, the MCP tool, bulk actions, and internal cascades.
   */
  archive(id: string, completed: boolean, withinTransaction = false, context: LifecycleContext = {}): WorkItem | null {
    const item = this.get(id);
    if (!item) return null;
    // Re-applying the state a task is already in is a no-op, mirroring restore().
    // Without this a double-tapped Archive button re-stamps archived_at and logs
    // the lifecycle line twice. Archived
    // incomplete → completed is still a real transition and falls through.
    if (item.archivedAt && completed === (item.completionStatus === 'completed')) return item;
    const now = new Date().toISOString();
    const ownsTransaction = !withinTransaction && this.transactionDepth === 0;
    if (ownsTransaction) this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE work_items SET archived_at = ?, completed_at = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(now, completed ? now : null, completed ? 'done' : item.status, now, id);
      this.database.prepare(`UPDATE shared_conversations SET archived_at = ?, updated_at = ?
        WHERE archived_at IS NULL AND (work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL))`).run(now, now, id, id);
      if (ownsTransaction) this.database.exec('COMMIT');
    } catch (error) {
      if (ownsTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
    this.addActivity(id, context.actor ?? 'system', completed ? 'completed' : 'archived',
      describeLifecycleChange(completed ? 'complete' : 'archive', context.reason));
    return this.get(id);
  }

  restore(id: string, withinTransaction = false, context: LifecycleContext = {}): WorkItem | null {
    const item = this.get(id);
    if (!item) return null;
    if (!item.archivedAt) return item;
    const now = new Date().toISOString();
    const status = item.status === 'done' || item.status === 'canceled' ? 'ready' : item.status;
    if (!withinTransaction) this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE work_items SET archived_at = NULL, completed_at = NULL, status = ?, is_queued = 1, updated_at = ? WHERE id = ?')
        .run(status, now, id);
      this.database.prepare(`UPDATE shared_conversations SET archived_at = NULL, updated_at = ?
        WHERE work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL)`).run(now, id, id);
      if (!withinTransaction) this.database.exec('COMMIT');
    } catch (error) {
      if (!withinTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
    // Unlike archive(), restore() cannot log from inside a caller's transaction:
    // this early return exists to skip reorder(), which opens its own. Callers
    // that pass withinTransaction must write their own entry — bulkUpdate does.
    if (withinTransaction) return this.get(id);
    const stack = item.stack;
    const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
    this.reorder([id, ...stackItems.map((entry) => entry.id).filter((entryId) => entryId !== id)], stack);
    this.addActivity(id, context.actor ?? 'system', 'restored', describeLifecycleChange('restore', context.reason));
    return this.get(id);
  }

  /** Soft delete: flags the row so it drops out of every list/get query but stays recoverable in the database. */
  delete(id: string): boolean {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const changed = Number(this.database.prepare('UPDATE work_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id).changes) > 0;
      if (!changed) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.database.prepare(`UPDATE shared_conversations SET deleted_at = ?, updated_at = ?
        WHERE deleted_at IS NULL AND (work_item_id = ? OR id IN (
          SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL
        ))`).run(now, now, id, id);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private logBulkEdit(before: WorkItem, after: WorkItem | null): void {
    if (!after) return;
    const edits = summarizeWorkItemChanges(before, after);
    if (edits.length) this.addActivity(after.id, 'jeffrey', 'edited', `${edits.join(' · ')}.`);
  }

  bulkUpdate(input: BulkWorkItemAction): BulkWorkItemResult {
    const conflicts: BulkWorkItemResult['conflicts'] = []; const eligible: WorkItem[] = [];
    for (const id of input.ids) {
      const item = this.get(id);
      if (!item) { conflicts.push({ id, reason: 'not_found' }); continue; }
      if (this.activeRunsForItem(id).length) { conflicts.push({ id, reason: 'active_run' }); continue; }
      if (input.action === 'archive' && item.archivedAt) { conflicts.push({ id, reason: 'invalid_state' }); continue; }
      if (input.action === 'restore' && !item.archivedAt) { conflicts.push({ id, reason: 'invalid_state' }); continue; }
      eligible.push(item);
    }
    if (!eligible.length) return { appliedIds: [], conflicts };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of eligible) {
        if (input.action === 'archive') this.archive(item.id, false, true, { actor: 'jeffrey' });
        else if (input.action === 'restore') this.restore(item.id, true);
        else if (input.action === 'set_status') this.logBulkEdit(item, this.update(item.id, { status: input.status }));
        else if (input.action === 'set_assignees') this.logBulkEdit(item, this.update(item.id, { assignees: input.assignees }));
        else if (input.action === 'set_stack') this.update(item.id, { stack: input.stack }, true);
        else this.logBulkEdit(item, this.update(item.id, { projectName: input.projectName }, true));
      }
      const restored = eligible.filter((item) => input.action === 'restore');
      for (const stack of ['attention', 'workbench'] as const) {
        const restoredIds = restored.filter((item) => item.stack === stack).map((item) => item.id);
        if (!restoredIds.length) continue;
        const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
        const orderedIds = [...restoredIds].reverse().concat(stackItems.map((item) => item.id).filter((id) => !restoredIds.includes(id)));
        const statement = this.database.prepare('UPDATE work_items SET queue_position = ?, updated_at = ? WHERE id = ?');
        const now = new Date().toISOString();
        orderedIds.forEach((id, index) => statement.run(index + 1, now, id));
      }
      if (input.action === 'set_stack') {
        const movedIds = eligible.filter((item) => item.stack !== input.stack).map((item) => item.id);
        if (movedIds.length) {
          const statement = this.database.prepare('UPDATE work_items SET queue_position = ?, updated_at = ? WHERE id = ?');
          const now = new Date().toISOString();
          const target = this.listStack(input.stack).map((item) => item.id);
          [...movedIds, ...target.filter((id) => !movedIds.includes(id))].forEach((id, index) => statement.run(index + 1, now, id));
          const source = input.stack === 'workbench' ? 'attention' : 'workbench';
          this.listStack(source).forEach((item, index) => statement.run(index + 1, now, item.id));
          for (const id of movedIds) this.addActivity(id, 'system', 'stack_changed', `Moved to the ${input.stack} stack.`);
        }
      }
      // restore() skips its own logging inside a transaction (see the note there), so this is the only entry for a bulk restore.
      for (const item of restored) this.addActivity(item.id, 'jeffrey', 'restored', describeLifecycleChange('restore'));
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return { appliedIds: eligible.map(({ id }) => id), conflicts };
  }

  /**
   * Remembers what the provider last said about a field that was just edited by
   * hand, so the next sync can tell a real conflict (both sides moved) from a
   * plain fast-forward. The baseline is the provider snapshot when one exists and
   * the pre-edit local value otherwise, and it is written once: a later edit only
   * refreshes `updated_at`, because the row must keep pointing at the first
   * divergence rather than chase each successive local value. An edit that
   * restores the provider value drops the row, since there is no longer a local
   * override to defend. `conflicted_at` stays null here — only a sync that finds
   * the provider has also moved is in a position to set it.
   */
  private recordLocalProviderOverrides(
    workItemId: string,
    localBaseline: ProviderSnapshotValues,
    changes: Partial<Record<ProviderSyncField, ProviderFieldValue>>,
    fields: readonly ProviderSyncField[],
    now: string,
  ): void {
    const snapshotRow = this.database
      .prepare('SELECT normalized_json FROM provider_work_item_snapshots WHERE work_item_id = ?')
      .get(workItemId) as Pick<ProviderSnapshotRow, 'normalized_json'> | undefined;
    const snapshot = snapshotRow ? JSON.parse(snapshotRow.normalized_json) as ProviderSnapshotValues : null;

    const upsert = this.database.prepare(`
      INSERT INTO provider_field_overrides (work_item_id, field, provider_baseline_json, conflicted_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(work_item_id, field) DO UPDATE SET updated_at = excluded.updated_at
    `);
    const clear = this.database.prepare('DELETE FROM provider_field_overrides WHERE work_item_id = ? AND field = ?');

    for (const field of fields) {
      const baseline = snapshot ? snapshot[field] : localBaseline[field];
      const next = field === 'labels' && Array.isArray(changes.labels) ? normalizeLabels(changes.labels) : changes[field];
      if (next !== undefined && sameProviderValue(baseline, next)) {
        clear.run(workItemId, field);
        continue;
      }
      upsert.run(workItemId, field, JSON.stringify(baseline), now, now);
    }
  }

  update(id: string, changes: Partial<Pick<WorkItem, 'title' | 'description' | 'priority' | 'status' | 'projectName' | 'stack' | 'workspacePath' | 'dueDate' | 'labels' | 'strategy' | 'assignees' | 'queuePosition'>> & { blockedByIds?: string[] }, withinTransaction = false): WorkItem | null {
    const before = this.get(id);
    if (!before) return null;
    const columns = new Map<string, string | number | null | undefined>([
      ['title', changes.title],
      ['description', changes.description],
      ['priority', changes.priority],
      ['status', changes.status],
      ['project_name', changes.projectName],
      ['stack', changes.stack],
      ['workspace_path', changes.workspacePath],
      ['due_date', changes.dueDate],
      ['labels_json', changes.labels !== undefined ? JSON.stringify(normalizeLabels(changes.labels)) : undefined],
      ['strategy', changes.strategy],
      ['assignees_json', changes.assignees ? JSON.stringify(changes.assignees) : undefined],
      ['queue_position', changes.queuePosition],
    ]);
    const entries = [...columns].filter(
      (entry): entry is [string, string | number | null] => entry[1] !== undefined,
    );
    if (entries.length === 0 && changes.blockedByIds === undefined) return this.get(id);

    const locallyChangedProviderFields = before.source === 'linear'
      ? providerSyncFields.filter((field) => changes[field as keyof typeof changes] !== undefined
        && !sameProviderValue(providerValues(before)[field], changes[field as keyof typeof changes] as ProviderFieldValue))
      : [];
    const managesTransaction = (changes.blockedByIds !== undefined || locallyChangedProviderFields.length > 0) && !withinTransaction;
    if (managesTransaction) this.database.exec('BEGIN IMMEDIATE');
    try {
      if (changes.blockedByIds !== undefined) this.replaceDependencyRows(id, changes.blockedByIds);
      if (entries.length) {
        const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
        const values = entries.map(([, value]) => value);
        const assignmentMode = changes.assignees ? ", agent_assignment_mode = 'manual'" : '';
        const now = new Date().toISOString();
        this.database
          .prepare(`UPDATE work_items SET ${assignments}${assignmentMode}, updated_at = ?, last_touched_at = ? WHERE id = ?`)
          .run(...values, now, now, id);
        if (locallyChangedProviderFields.length) {
          this.recordLocalProviderOverrides(id, providerValues(before), changes, locallyChangedProviderFields, now);
        }
        if (changes.title !== undefined || changes.description !== undefined) {
          this.database.prepare("DELETE FROM work_item_classifications WHERE work_item_id = ? AND source != 'manual'").run(id);
        }
      }
      if (managesTransaction) this.database.exec('COMMIT');
    } catch (error) {
      if (managesTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
    // Queue positions are numbered per stack, so a task that changes stack is
    // still carrying a position from the stack it left. Reseat it at the top of
    // its new stack and close the gap in the old one. Callers already inside a
    // transaction renumber themselves, because reorder opens its own.
    if (changes.stack !== undefined && changes.stack !== before.stack && !withinTransaction) {
      const target = this.listStack(changes.stack);
      this.reorder([id, ...target.map((item) => item.id).filter((itemId) => itemId !== id)], changes.stack);
      this.reorder(this.listStack(before.stack).map((item) => item.id), before.stack);
      this.addActivity(id, 'system', 'stack_changed', `Moved to the ${changes.stack} stack.`);
    }
    return this.get(id);
  }

  getClassification(workItemId: string): TaskClassification | null {
    const row = this.database.prepare('SELECT * FROM work_item_classifications WHERE work_item_id = ?').get(workItemId) as
      { kind: AgentRun['kind']; agent: AgentRun['agent']; complex: number; instructions: string; classified_at: string; source: TaskClassification['source']; classifier_version: number } | undefined;
    if (row?.source === 'automatic' && row.classifier_version < 2) return null;
    return row ? { kind: row.kind, agent: row.agent, complex: row.complex === 1, instructions: row.instructions, classifiedAt: row.classified_at, source: row.source } : null;
  }

  setClassification(workItemId: string, classification: Omit<TaskClassification, 'classifiedAt' | 'source'>, source: TaskClassification['source'] = 'automatic'): TaskClassification {
    const classifiedAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO work_item_classifications (work_item_id, kind, agent, complex, instructions, classified_at, source, classifier_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 2) ON CONFLICT(work_item_id) DO UPDATE SET kind = excluded.kind, agent = excluded.agent,
      complex = excluded.complex, instructions = excluded.instructions, classified_at = excluded.classified_at, source = excluded.source, classifier_version = excluded.classifier_version`)
      .run(workItemId, classification.kind, classification.agent, classification.complex ? 1 : 0, classification.instructions, classifiedAt, source);
    return { ...classification, classifiedAt, source };
  }

  getExplicitAgentAssignees(id: string): AgentRun['agent'][] {
    const row = this.database.prepare('SELECT assignees_json, agent_assignment_mode FROM work_items WHERE id = ?').get(id) as
      { assignees_json: string; agent_assignment_mode: string } | undefined;
    if (!row || row.agent_assignment_mode !== 'manual') return [];
    return (JSON.parse(row.assignees_json) as Assignee[]).filter((assignee): assignee is AgentRun['agent'] => assignee === 'codex' || assignee === 'claude');
  }

  updateAutomaticAgentAssignees(id: string, agents: AgentRun['agent'][]): WorkItem | null {
    const item = this.get(id);
    if (!item) return null;
    // A task Jeffrey owns is his alone: never auto-attach an agent alongside him.
    // Callers gate on this too, so reaching here means something bypassed the gate.
    if (isSelfAssigned(item.assignees)) return item;
    const assignees = [...agents];
    this.database.prepare("UPDATE work_items SET assignees_json = ?, agent_assignment_mode = 'auto', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(assignees), new Date().toISOString(), id);
    return this.get(id);
  }

  listActivity(workItemId: string): Activity[] {
    const rows = this.database
      // created_at only has millisecond resolution, and a routing decision plus the
      // model choice it leads to are often written inside the same millisecond. rowid
      // breaks the tie by insertion order so the timeline never renders backwards.
      .prepare('SELECT * FROM activities WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(workItemId) as unknown as ActivityRow[];
    return rows.map((row) => ({
      id: row.id,
      workItemId: row.work_item_id,
      actor: row.actor,
      kind: row.kind,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  addActivity(workItemId: string, actor: Activity['actor'], kind: string, body: string): Activity {
    const activity: Activity = {
      id: randomUUID(),
      workItemId,
      actor,
      kind,
      body,
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare('INSERT INTO activities (id, work_item_id, actor, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(activity.id, activity.workItemId, activity.actor, activity.kind, activity.body, activity.createdAt);
    if (kind !== 'queue_moved') this.database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(activity.createdAt, workItemId);
    return activity;
  }

  listRuns(workItemId: string): AgentRun[] {
    return this.database
      .prepare('SELECT * FROM agent_runs WHERE work_item_id = ? ORDER BY created_at DESC')
      .all(workItemId)
      .map((value) => {
        const row = value as Record<string, string | null>;
        return {
          id: row.id!, workItemId: row.work_item_id!, kind: row.kind as AgentRun['kind'],
          requestedTarget: row.requested_target as AgentRun['requestedTarget'],
          requestedAgent: (row.requested_agent ?? row.agent) as AgentRun['agent'], agent: row.agent as AgentRun['agent'],
          status: row.status as AgentRun['status'], instructions: row.instructions!, output: row.output!, error: row.error!,
          startedAt: row.started_at, completedAt: row.completed_at, createdAt: row.created_at!,
          conversationId: row.conversation_id, messageId: row.message_id,
          model: row.model, executionProfile: row.execution_profile as AgentRun['executionProfile'],
          inputTokens: row.input_tokens === null ? null : Number(row.input_tokens), outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
          estimatedCostUsd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
          fallbackFrom: row.fallback_from as AgentRun['fallbackFrom'] ?? null, fallbackReason: row.fallback_reason,
          attempt: Number(row.attempt ?? 0), maxAttempts: Number(row.max_attempts ?? 3),
          nextAttemptAt: row.next_attempt_at ?? null,
        };
      });
  }

  getRun(id: string): AgentRun | null {
    const row = this.database.prepare('SELECT work_item_id FROM agent_runs WHERE id = ?').get(id) as { work_item_id: string } | undefined;
    return row ? this.listRuns(row.work_item_id).find((run) => run.id === id) ?? null : null;
  }

  getRunByMessage(messageId: string): AgentRun | null {
    const row = this.database.prepare(`SELECT agent_runs.id
      FROM agent_runs
      LEFT JOIN shared_messages ON shared_messages.id = ?
      WHERE agent_runs.message_id = ?
        OR (
          agent_runs.message_id IS NULL
          AND agent_runs.conversation_id = shared_messages.conversation_id
          AND agent_runs.agent = shared_messages.author
          AND agent_runs.status IN ('queued', 'running')
        )
      ORDER BY CASE WHEN agent_runs.message_id = ? THEN 0 ELSE 1 END, agent_runs.created_at DESC
      LIMIT 1`).get(messageId, messageId, messageId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : null;
  }

  createRun(workItemId: string, kind: AgentRun['kind'], requestedTarget: AgentRun['requestedTarget'], agent: AgentRun['agent'], instructions: string, conversationId: string | null = null, messageId: string | null = null): AgentRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO agent_runs (id, work_item_id, kind, requested_target, requested_agent, agent, status, instructions, created_at, conversation_id, message_id)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(id, workItemId, kind, requestedTarget, agent, agent, instructions, createdAt, conversationId, messageId);
    return this.listRuns(workItemId).find((run) => run.id === id)!;
  }

  selectBalancedAgent(preferred: AgentRun['agent']): AgentRun['agent'] {
    const rows = this.database.prepare(`
      SELECT agent, SUM(weight) AS load
      FROM (
        SELECT agent, 100 AS weight FROM agent_runs WHERE status IN ('queued', 'running')
        UNION ALL
        SELECT author AS agent, 100 AS weight FROM shared_messages
        WHERE author IN ('codex', 'claude') AND status = 'running'
        UNION ALL
        SELECT agent, 1 AS weight FROM (
          SELECT agent FROM agent_runs WHERE requested_target = 'auto' AND status = 'completed'
          ORDER BY completed_at DESC, rowid DESC LIMIT 20
        )
      )
      GROUP BY agent
    `).all() as Array<{ agent: AgentRun['agent']; load: number }>;
    const load = { codex: 0, claude: 0 };
    for (const row of rows) load[row.agent] = Number(row.load);
    if (load.codex === 0 && load.claude === 0) return preferred;
    if (load.codex === load.claude) {
      const latest = this.database.prepare(`
        SELECT agent FROM agent_runs
        WHERE requested_target = 'auto'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get() as { agent: AgentRun['agent'] } | undefined;
      return latest?.agent === 'codex' ? 'claude' : 'codex';
    }
    return load.codex < load.claude ? 'codex' : 'claude';
  }

  private runPatchEntries(changes: RunPatch): Array<[string, string | number | null]> {
    // Runs are retried in place, so clear any error left by the previous
    // attempt as soon as the reused run completes or is canceled.
    const error = changes.error ?? (changes.status === 'completed' || changes.status === 'canceled' ? '' : undefined);
    const columns = new Map<string, string | number | null | undefined>([
      ['agent', changes.agent], ['status', changes.status], ['output', changes.output], ['error', error], ['model', changes.model], ['execution_profile', changes.executionProfile],
      ['input_tokens', changes.inputTokens], ['output_tokens', changes.outputTokens], ['estimated_cost_usd', changes.estimatedCostUsd], ['fallback_from', changes.fallbackFrom], ['fallback_reason', changes.fallbackReason],
      ['started_at', changes.startedAt], ['completed_at', changes.completedAt], ['owner_id', changes.ownerId], ['lease_expires_at', changes.leaseExpiresAt],
      ['next_attempt_at', changes.nextAttemptAt], ['attempt', changes.attempt],
    ]);
    return [...columns].filter((entry): entry is [string, string | number | null] => entry[1] !== undefined);
  }

  updateRun(id: string, changes: RunPatch): void {
    const entries = this.runPatchEntries(changes);
    if (!entries.length) return;
    this.database.prepare(`UPDATE agent_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  /** Reopens the same failed attempt and linked chat bubble instead of forking a second execution. */
  prepareRunRetry(id: string): AgentRun | null {
    const run = this.getRun(id);
    if (!run || (run.status !== 'failed' && run.status !== 'canceled')) return null;
    const changed = this.database.prepare(`UPDATE agent_runs
      SET status = 'queued', error = '', started_at = NULL, completed_at = NULL,
          owner_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL, attempt = attempt + 1,
          cancel_requested = 0, cancel_requested_at = NULL
      WHERE id = ? AND status IN ('failed', 'canceled')`).run(id).changes;
    if (!changed) return null;
    if (run.messageId) this.database.prepare(`UPDATE shared_messages
      SET status = 'running', error = '', completed_at = NULL, owner_id = NULL, lease_expires_at = NULL,
          attempt = attempt + 1, next_attempt_at = NULL
      WHERE id = ? AND status IN ('failed', 'canceled')`).run(run.messageId);
    return this.getRun(id);
  }

  prepareSharedMessageRetry(id: string): SharedMessage | null {
    const changed = this.database.prepare(`UPDATE shared_messages
      SET status = 'running', error = '', completed_at = NULL, owner_id = NULL, lease_expires_at = NULL,
          attempt = attempt + 1, next_attempt_at = NULL
      WHERE id = ? AND author IN ('codex', 'claude') AND status IN ('failed', 'canceled')`).run(id).changes;
    return changed ? this.getSharedMessageById(id) : null;
  }

  upsertLinearItem(input: ProviderWorkItem): 'imported' | 'updated' | 'skipped' {
    const existing = this.database
      .prepare("SELECT * FROM work_items WHERE source = 'linear' AND source_identifier = ?")
      .get(input.sourceIdentifier) as WorkItemRow | undefined;

    const now = new Date().toISOString();
    const incoming = providerValues(input);

    if (existing) {
      const snapshotRow = this.database.prepare('SELECT * FROM provider_work_item_snapshots WHERE work_item_id = ?').get(existing.id) as ProviderSnapshotRow | undefined;
      if (existing.provider_updated_at === input.providerUpdatedAt && snapshotRow) return 'skipped';
      const previousSnapshot = snapshotRow ? JSON.parse(snapshotRow.normalized_json) as ProviderSnapshotValues : null;
      const overrides = this.database.prepare('SELECT field, provider_baseline_json, conflicted_at FROM provider_field_overrides WHERE work_item_id = ?').all(existing.id) as unknown as ProviderOverrideRow[];
      const overrideByField = new Map(overrides.map((override) => [override.field, override]));
      const effective = providerValues(existing);
      const assignments: string[] = [];
      const values: Array<string | null> = [];
      let visibleChanged = false;

      this.transaction(() => {
        for (const field of providerSyncFields) {
          const override = overrideByField.get(field);
          if (!override) {
            // Existing installations have no trustworthy normalized base. Keep
            // a differing local value and make it reviewable rather than lose it.
            if (!previousSnapshot && !sameProviderValue(effective[field], incoming[field])) {
              this.database.prepare(`INSERT INTO provider_field_overrides (work_item_id, field, provider_baseline_json, conflicted_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
                .run(existing.id, field, JSON.stringify(effective[field]), now, now, now);
              continue;
            }
            if (!sameProviderValue(effective[field], incoming[field])) {
              assignments.push(`${providerFieldColumns[field]} = ?`);
              values.push(databaseProviderValue(field, incoming[field]));
              visibleChanged = true;
            }
            continue;
          }
          const baseline = parseProviderValue(override.provider_baseline_json);
          if (sameProviderValue(effective[field], incoming[field])) {
            this.database.prepare('DELETE FROM provider_field_overrides WHERE work_item_id = ? AND field = ?').run(existing.id, field);
          } else if (!sameProviderValue(baseline, incoming[field])) {
            this.database.prepare('UPDATE provider_field_overrides SET conflicted_at = COALESCE(conflicted_at, ?), updated_at = ? WHERE work_item_id = ? AND field = ?')
              .run(now, now, existing.id, field);
          }
        }
        const metadataAssignments = ['source_url = ?', 'provider_payload_json = ?', 'provider_updated_at = ?'];
        const metadataValues: Array<string | null> = [input.sourceUrl, JSON.stringify(input.providerPayload), input.providerUpdatedAt];
        if (visibleChanged) {
          assignments.push('updated_at = ?', 'last_touched_at = ?');
          values.push(now, now);
        }
        this.database.prepare(`UPDATE work_items SET ${[...assignments, ...metadataAssignments].join(', ')} WHERE id = ?`)
          .run(...values, ...metadataValues, existing.id);
        this.database.prepare(`INSERT INTO provider_work_item_snapshots (work_item_id, provider, normalized_json, raw_payload_json, provider_updated_at, synced_at)
          VALUES (?, 'linear', ?, ?, ?, ?)
          ON CONFLICT(work_item_id) DO UPDATE SET normalized_json = excluded.normalized_json, raw_payload_json = excluded.raw_payload_json,
            provider_updated_at = excluded.provider_updated_at, synced_at = excluded.synced_at`)
          .run(existing.id, JSON.stringify(incoming), JSON.stringify(input.providerPayload), input.providerUpdatedAt, now);
      });
      return 'updated';
    }

    const id = randomUUID();
    const position = Number(
      (this.database.prepare('SELECT COALESCE(MAX(queue_position), 0) + 1 AS value FROM work_items').get() as {
        value: number;
      }).value,
    );
    this.database
      .prepare(`
        INSERT INTO work_items (
          id, title, description, status, priority, queue_position, source, is_queued,
          source_identifier, source_url, project_name, labels_json, due_date,
          provider_payload_json, provider_updated_at, created_at, updated_at, last_touched_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'linear', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.title,
        input.description,
        input.status,
        input.priority,
        position,
        input.sourceIdentifier,
        input.sourceUrl,
        input.projectName,
        JSON.stringify(input.labels),
        input.dueDate,
        JSON.stringify(input.providerPayload),
        input.providerUpdatedAt,
        now,
        now,
        now,
      );
    this.addActivity(id, 'system', 'imported', `Imported from Linear as ${input.sourceIdentifier}.`);
    this.database.prepare(`INSERT INTO provider_work_item_snapshots (work_item_id, provider, normalized_json, raw_payload_json, provider_updated_at, synced_at)
      VALUES (?, 'linear', ?, ?, ?, ?)`)
      .run(id, JSON.stringify(incoming), JSON.stringify(input.providerPayload), input.providerUpdatedAt, now);
    return 'imported';
  }

  /** Sync a Linear page atomically; individual upserts compose with this transaction. */
  upsertLinearItems(inputs: ProviderWorkItem[]): Array<'imported' | 'updated' | 'skipped'> {
    return this.transaction(() => inputs.map((input) => this.upsertLinearItem(input)));
  }

  listProviderConflicts(workItemId: string): ProviderSyncConflict[] {
    const item = this.get(workItemId);
    if (!item) return [];
    const snapshot = this.database.prepare('SELECT normalized_json FROM provider_work_item_snapshots WHERE work_item_id = ?').get(workItemId) as Pick<ProviderSnapshotRow, 'normalized_json'> | undefined;
    if (!snapshot) return [];
    const provider = JSON.parse(snapshot.normalized_json) as ProviderSnapshotValues;
    return (this.database.prepare('SELECT field, provider_baseline_json, conflicted_at FROM provider_field_overrides WHERE work_item_id = ? AND conflicted_at IS NOT NULL ORDER BY conflicted_at DESC').all(workItemId) as unknown as ProviderOverrideRow[])
      .map((row) => ({ field: row.field, localValue: providerValues(item)[row.field], providerValue: provider[row.field], providerBaseline: parseProviderValue(row.provider_baseline_json), conflictedAt: row.conflicted_at! }));
  }

  countProviderConflicts(): number {
    return (this.database.prepare('SELECT COUNT(*) AS count FROM provider_field_overrides WHERE conflicted_at IS NOT NULL').get() as { count: number }).count;
  }

  resolveProviderConflict(workItemId: string, field: ProviderSyncField, resolution: ProviderSyncConflictResolution): WorkItem | null {
    const item = this.get(workItemId);
    const snapshotRow = this.database.prepare('SELECT normalized_json FROM provider_work_item_snapshots WHERE work_item_id = ?').get(workItemId) as Pick<ProviderSnapshotRow, 'normalized_json'> | undefined;
    const override = this.database.prepare('SELECT field, provider_baseline_json, conflicted_at FROM provider_field_overrides WHERE work_item_id = ? AND field = ? AND conflicted_at IS NOT NULL').get(workItemId, field) as ProviderOverrideRow | undefined;
    if (!item || !snapshotRow || !override) return null;
    const provider = JSON.parse(snapshotRow.normalized_json) as ProviderSnapshotValues;
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (resolution === 'use_provider') {
        this.database.prepare(`UPDATE work_items SET ${providerFieldColumns[field]} = ?, updated_at = ?, last_touched_at = ? WHERE id = ?`)
          .run(databaseProviderValue(field, provider[field]), now, now, workItemId);
        this.database.prepare('DELETE FROM provider_field_overrides WHERE work_item_id = ? AND field = ?').run(workItemId, field);
      } else {
        this.database.prepare('UPDATE provider_field_overrides SET provider_baseline_json = ?, conflicted_at = NULL, updated_at = ? WHERE work_item_id = ? AND field = ?')
          .run(JSON.stringify(provider[field]), now, workItemId, field);
      }
      this.addActivity(workItemId, 'jeffrey', 'provider_conflict_resolved', `${resolution === 'use_provider' ? 'Accepted Linear' : 'Kept local'} ${field} after a sync conflict.`);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return this.get(workItemId);
  }

  getLinearConfig(): LinearProviderConfig {
    const row = this.database
      .prepare("SELECT metadata_json FROM sync_state WHERE provider = 'linear'")
      .get() as { metadata_json: string | null } | undefined;
    if (!row?.metadata_json) return { teamIds: [], projectIds: [] };
    try {
      const value = JSON.parse(row.metadata_json) as Partial<LinearProviderConfig>;
      return {
        teamIds: Array.isArray(value.teamIds) ? value.teamIds : [],
        projectIds: Array.isArray(value.projectIds) ? value.projectIds : [],
      };
    } catch {
      return { teamIds: [], projectIds: [] };
    }
  }

  // --- Task relationship graph ----------------------------------------------
  //
  // parentWorkItemId (children here), shared_conversations.work_item_id, and
  // published_artifacts.work_item_id are all foreign keys onto a soft-deleted
  // (archived_at flag) work_items row, so they already survive archive,
  // restore, and conversation forks for free — a fork shares its source
  // conversation's work_item_id, so it shows up here automatically. The only
  // Arbitrary external references live in work_item_references. Peer task
  // relationships are stored once in canonical ID order, so they surface from
  // either task without a second write.

  listChildren(workItemId: string): WorkItem[] {
    const rows = this.database.prepare('SELECT * FROM work_items WHERE parent_work_item_id = ? ORDER BY created_at ASC').all(workItemId) as unknown as WorkItemRow[];
    return rows.map((row) => this.withAgentOutcome(mapWorkItem(row)));
  }

  listConversationsForWorkItem(workItemId: string): SharedConversation[] {
    const rows = this.database.prepare(`
      SELECT shared_conversations.*,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.status = 'running') AS is_active
      FROM shared_conversations
      WHERE deleted_at IS NULL AND (work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL))
      ORDER BY created_at ASC
    `).all(workItemId, workItemId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id), title: String(row.title), workItemId: row.work_item_id ? String(row.work_item_id) : null,
      forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, preferredExecutionProfile: row.preferred_execution_profile as SharedConversation['preferredExecutionProfile'] ?? null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
    }));
  }

  // The artifact library owns artifact reads; the task graph just asks it for the
  // live shares belonging to this task.
  listArtifactsForWorkItem(workItemId: string): ArtifactSummary[] {
    return new ArtifactLibrary(this.database).listForWorkItem(workItemId).filter((artifact) => !artifact.revokedAt);
  }

  listLinkedTasks(workItemId: string): WorkItem[] {
    const rows = this.database.prepare(`
      SELECT work_items.* FROM work_item_links
      JOIN work_items ON work_items.id = CASE
        WHEN work_item_links.work_item_id = ? THEN work_item_links.linked_work_item_id
        ELSE work_item_links.work_item_id
      END
      WHERE work_item_links.work_item_id = ? OR work_item_links.linked_work_item_id = ?
      ORDER BY work_item_links.created_at ASC
    `).all(workItemId, workItemId, workItemId) as unknown as WorkItemRow[];
    return rows.map((row) => this.withAgentOutcome(mapWorkItem(row)));
  }

  addTaskLink(workItemId: string, linkedWorkItemId: string): WorkItem {
    if (workItemId === linkedWorkItemId) throw new Error('A task cannot link to itself.');
    const item = this.get(workItemId);
    const linked = this.get(linkedWorkItemId);
    if (!item || !linked) throw new Error('Task not found.');
    const [firstId, secondId] = workItemId < linkedWorkItemId ? [workItemId, linkedWorkItemId] : [linkedWorkItemId, workItemId];
    const result = this.database.prepare('INSERT OR IGNORE INTO work_item_links (work_item_id, linked_work_item_id, created_at) VALUES (?, ?, ?)')
      .run(firstId, secondId, new Date().toISOString());
    if (result.changes) {
      this.addActivity(workItemId, 'jeffrey', 'task_linked', `Linked task: ${linked.title}`);
      this.addActivity(linkedWorkItemId, 'jeffrey', 'task_linked', `Linked task: ${item.title}`);
    }
    return linked;
  }

  removeTaskLink(workItemId: string, linkedWorkItemId: string): boolean {
    const [firstId, secondId] = workItemId < linkedWorkItemId ? [workItemId, linkedWorkItemId] : [linkedWorkItemId, workItemId];
    return Number(this.database.prepare('DELETE FROM work_item_links WHERE work_item_id = ? AND linked_work_item_id = ?').run(firstId, secondId).changes) > 0;
  }

  listReferences(workItemId: string): WorkItemReference[] {
    const rows = this.database.prepare('SELECT * FROM work_item_references WHERE work_item_id = ? ORDER BY created_at DESC').all(workItemId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({ id: row.id!, workItemId: row.work_item_id!, type: row.type as WorkItemReferenceType, url: row.url!, title: row.title!, createdAt: row.created_at! }));
  }

  addReference(workItemId: string, input: { type: WorkItemReferenceType; url: string; title: string }): WorkItemReference {
    if (!this.get(workItemId)) throw new Error('Task not found.');
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = input.title.trim() || this.deriveReferenceTitle(input.url);
    this.database.prepare('INSERT INTO work_item_references (id, work_item_id, type, url, title, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, workItemId, input.type, input.url, title, now);
    this.addActivity(workItemId, 'jeffrey', 'reference_added', `Linked ${input.type.replace('_', ' ')}: ${title}`);
    return this.listReferences(workItemId).find((reference) => reference.id === id)!;
  }

  removeReference(workItemId: string, referenceId: string): boolean {
    return Number(this.database.prepare('DELETE FROM work_item_references WHERE id = ? AND work_item_id = ?').run(referenceId, workItemId).changes) > 0;
  }

  private deriveReferenceTitle(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  setLinearConfig(config: LinearProviderConfig): LinearProviderConfig {
    this.database
      .prepare(`
        INSERT INTO sync_state (provider, metadata_json)
        VALUES ('linear', ?)
        ON CONFLICT(provider) DO UPDATE SET metadata_json = excluded.metadata_json
      `)
      .run(JSON.stringify(config));
    return config;
  }

  // --- Reliability: lease + retry primitives -------------------------------
  //
  // A "claim" is an atomic conditional UPDATE: only the caller whose WHERE
  // clause matches (correct status, and no other owner holding a live lease)
  // gets to proceed. This is what makes it safe for two processes (an old
  // one that hasn't noticed it should stop, and a new one after a restart)
  // to both be looking at the same row without doing the work twice.

  claimRun(id: string, ownerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE agent_runs SET owner_id = ?, lease_expires_at = ?, status = 'running'
      WHERE id = ? AND status = 'queued' AND cancel_requested = 0 AND (owner_id IS NULL OR lease_expires_at < ?)
    `).run(ownerId, leaseExpiresAt, id, now).changes;
    return Number(changed) > 0;
  }

  claimSharedMessage(id: string, ownerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE shared_messages SET owner_id = ?, lease_expires_at = ?
      WHERE id = ? AND status = 'running' AND (owner_id IS NULL OR lease_expires_at < ?)
    `).run(ownerId, leaseExpiresAt, id, now).changes;
    return Number(changed) > 0;
  }

  /** Atomically promote exactly one queued jeffrey turn to running-dispatch, guarding against double dispatch. */
  claimQueuedTurn(id: string): boolean {
    const changed = this.database.prepare(`
      UPDATE shared_messages SET status = 'completed' WHERE id = ? AND status = 'queued' AND author = 'jeffrey'
    `).run(id).changes;
    if (!Number(changed)) return false;
    const message = this.getSharedMessageById(id);
    if (message) this.recordSharedBriefEntry(message.conversationId, message.id, 'jeffrey', 'decision', message.body);
    return true;
  }

  renewLeases(ownerId: string, leaseMs: number): void {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    this.database.prepare(`UPDATE agent_runs SET lease_expires_at = ? WHERE owner_id = ? AND status = 'running' AND cancel_requested = 0 AND lease_expires_at >= ?`).run(leaseExpiresAt, ownerId, now);
    this.database.prepare(`UPDATE shared_messages SET lease_expires_at = ? WHERE owner_id = ? AND status = 'running' AND lease_expires_at >= ?`).run(leaseExpiresAt, ownerId, now);
  }

  renewRunLease(id: string, ownerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE agent_runs SET lease_expires_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'running' AND cancel_requested = 0 AND lease_expires_at >= ?
    `).run(leaseExpiresAt, id, ownerId, now).changes;
    return Number(changed) > 0;
  }

  requestRunCancellation(id: string): boolean {
    const requestedAt = new Date().toISOString();
    const changed = this.database.prepare(`
      UPDATE agent_runs SET cancel_requested = 1, cancel_requested_at = ?
      WHERE id = ? AND status IN ('queued', 'running') AND cancel_requested = 0
    `).run(requestedAt, id).changes;
    return Number(changed) > 0;
  }

  isCancellationRequested(id: string): boolean {
    const row = this.database.prepare('SELECT cancel_requested FROM agent_runs WHERE id = ?').get(id) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  /**
   * The owner may publish a terminal result or retry only while it still owns
   * the live, uncanceled attempt. The conditional write is the commit point;
   * callers must suppress every downstream side effect when it returns false.
   */
  finishRun(id: string, ownerId: string, patch: RunPatch): boolean {
    const entries = this.runPatchEntries(patch);
    if (!entries.length) return false;
    const changed = this.database.prepare(`
      UPDATE agent_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND owner_id = ? AND status = 'running' AND cancel_requested = 0 AND lease_expires_at >= ?
    `).run(...entries.map(([, value]) => value), id, ownerId, new Date().toISOString()).changes;
    return Number(changed) > 0;
  }

  /** Commit recovery only if the same interrupted owner still has an expired lease. */
  private finishExpiredRun(id: string, ownerId: string, recoveryCutoff: string, patch: RunPatch): boolean {
    const entries = this.runPatchEntries(patch);
    if (!entries.length) return false;
    const changed = this.database.prepare(`
      UPDATE agent_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND owner_id = ? AND status = 'running' AND cancel_requested = 0
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(...entries.map(([, value]) => value), id, ownerId, recoveryCutoff).changes;
    return Number(changed) > 0;
  }

  finishRunCancellation(id: string, ownerId: string): boolean {
    const changed = this.database.prepare(`
      UPDATE agent_runs SET status = 'canceled', error = '', completed_at = ?, owner_id = NULL, lease_expires_at = NULL
      WHERE id = ? AND owner_id = ? AND status = 'running' AND cancel_requested = 1
    `).run(new Date().toISOString(), id, ownerId).changes;
    return Number(changed) > 0;
  }

  finishQueuedRunCancellation(id: string): boolean {
    const changed = this.database.prepare(`UPDATE agent_runs
      SET status = 'canceled', error = '', completed_at = ?
      WHERE id = ? AND status = 'queued' AND cancel_requested = 1`).run(new Date().toISOString(), id).changes;
    return Number(changed) > 0;
  }

  renewSharedMessageLease(id: string, ownerId: string, leaseMs: number): boolean {
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE shared_messages SET lease_expires_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'running'
    `).run(leaseExpiresAt, id, ownerId).changes;
    return Number(changed) > 0;
  }

  /** Schedule a bounded retry for a run that failed transiently. Returns false when attempts are exhausted. */
  scheduleRunRetry(id: string, ownerId: string, delayMs: number): boolean {
    const row = this.database.prepare('SELECT attempt, max_attempts FROM agent_runs WHERE id = ?').get(id) as { attempt: number; max_attempts: number } | undefined;
    if (!row || row.attempt + 1 >= row.max_attempts) return false;
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    return this.finishRun(id, ownerId, {
      status: 'queued', ownerId: null, leaseExpiresAt: null,
      attempt: row.attempt + 1, nextAttemptAt,
    });
  }

  /**
   * Reclaim work whose lease expired without the owner finishing it (crash or restart).
   * `execute` runs perform non-idempotent filesystem edits, so they are never silently
   * re-run: they are marked failed for Jeffrey to re-trigger deliberately.
   */
  reclaimExpired(graceMs = 3 * 60_000): { recoveredRunIds: string[]; failedRunIds: string[]; recoveredMessageIds: string[] } {
    const now = new Date().toISOString();
    // A missed heartbeat is not proof of a restart. Wait through a grace period
    // before recovery changes user-visible state.
    const recoveryCutoff = new Date(Date.now() - graceMs).toISOString();
    const expiredRuns = this.database.prepare(`SELECT id, kind, owner_id, cancel_requested, attempt, max_attempts FROM agent_runs
      WHERE status = 'running' AND (lease_expires_at <= ? OR (owner_id IS NULL AND lease_expires_at IS NULL))`).all(recoveryCutoff) as Array<{ id: string; kind: AgentRun['kind']; owner_id: string | null; cancel_requested: number; attempt: number; max_attempts: number }>;
    const recoveredRunIds: string[] = [];
    const failedRunIds: string[] = [];
    for (const run of expiredRuns) {
      if (run.cancel_requested === 1) {
        this.database.prepare(`UPDATE agent_runs SET status = 'canceled', completed_at = ?, owner_id = NULL, lease_expires_at = NULL
          WHERE id = ? AND status = 'running' AND cancel_requested = 1`).run(now, run.id);
      } else if (!run.owner_id) {
        this.updateRun(run.id, { status: 'failed', error: 'Agent process stopped reporting progress without a durable owner.', completedAt: now, ownerId: null, leaseExpiresAt: null });
        failedRunIds.push(run.id);
      } else if (run.kind === 'execute') {
        if (this.finishExpiredRun(run.id, run.owner_id, recoveryCutoff, { status: 'failed', error: 'Agent process stopped reporting progress. Retry or continue the conversation.', completedAt: now, ownerId: null, leaseExpiresAt: null })) failedRunIds.push(run.id);
      } else if (run.attempt + 1 < run.max_attempts && this.finishExpiredRun(run.id, run.owner_id, recoveryCutoff, {
        status: 'queued', ownerId: null, leaseExpiresAt: null, attempt: run.attempt + 1, nextAttemptAt: now,
      })) {
        recoveredRunIds.push(run.id);
      } else {
        if (this.finishExpiredRun(run.id, run.owner_id, recoveryCutoff, { status: 'failed', error: 'Retry attempts exhausted after interruption.', completedAt: now, ownerId: null, leaseExpiresAt: null })) failedRunIds.push(run.id);
      }
    }
    // Shared messages with expired leases are interrupted (not retried). If there's
    // an associated agent run, that run will be recovered separately. When the run
    // completes, it will update the message to its final status (completed/failed).
    const expiredMessages = this.database.prepare(`SELECT id FROM shared_messages
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
        AND dispatch_target != 'promotion'
        AND NOT EXISTS (
          SELECT 1 FROM agent_runs
          WHERE agent_runs.message_id = shared_messages.id
            AND agent_runs.status IN ('queued', 'running')
        )`).all(recoveryCutoff) as Array<{ id: string }>;
    const recoveredMessageIds: string[] = [];
    for (const message of expiredMessages) {
      this.database.prepare(`UPDATE shared_messages SET status = 'failed', error = 'Agent process stopped reporting progress. Retry or continue the conversation.', owner_id = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ?`).run(now, message.id);
      recoveredMessageIds.push(message.id);
    }
    return { recoveredRunIds, failedRunIds, recoveredMessageIds };
  }

  /**
   * Runs that are queued and due (no scheduled delay, or the delay has elapsed).
   *
   * When `limit` (a concurrency ceiling) is given, the result is capped at
   * `max(0, limit - currently running)`. The running count is read fresh from the
   * database (a COUNT of `status = 'running'` rows) rather than kept as an in-process
   * counter, because `app.ts` also dispatches runs directly, bypassing the scheduler
   * entirely, for user-triggered actions. An in-memory counter in the scheduler would
   * be blind to those dispatches; counting running rows in the DB makes the ceiling
   * global across every process and every dispatch path.
   */
  dueWork(limit?: number): { runIds: string[] } {
    const now = new Date().toISOString();
    if (limit !== undefined) {
      const running = this.runningRunCount();
      const capacity = Math.max(0, limit - running);
      if (capacity === 0) return { runIds: [] };
      const rows = this.database.prepare(`
        SELECT id FROM agent_runs
        WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC, rowid ASC LIMIT ?
      `).all(now, capacity) as Array<{ id: string }>;
      return { runIds: rows.map((row) => row.id) };
    }
    const rows = this.database.prepare(`SELECT id FROM agent_runs WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC, rowid ASC`).all(now) as Array<{ id: string }>;
    return { runIds: rows.map((row) => row.id) };
  }

  /** Count of agent_run rows currently claimed and executing (status = 'running'). */
  runningRunCount(): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'`).get() as { n: number };
    return Number(row.n);
  }

  hasLiveWork(): boolean {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_runs WHERE status IN ('queued', 'running')) AS runs,
        (SELECT COUNT(*) FROM shared_messages WHERE status IN ('queued', 'running') AND author IN ('codex', 'claude')) AS messages
    `).get() as { runs: number; messages: number };
    return Number(row.runs) + Number(row.messages) > 0;
  }

  activeRunsForItem(workItemId: string): AgentRun[] {
    return this.listRuns(workItemId).filter((run) => run.status === 'queued' || run.status === 'running');
  }

  // --- Audit log -----------------------------------------------------------

  addAuditEntry(category: AuditLogEntry['category'], source: string, detail: string, workItemId: string | null = null): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO audit_log (id, category, source, detail, work_item_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, category, source, detail, workItemId, now);
  }

  listAuditLog(limit = 100, cursor: string | null = null, category?: AuditLogEntry['category'], workItemId?: string): AuditLogPage {
    const safeLimit = Math.max(1, Math.min(200, limit));
    let cursorValues: { createdAt: string; rowid: number } | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt: string; rowid: number }; }
      catch { throw new Error('Invalid audit log cursor.'); }
      if (!cursorValues?.createdAt || !cursorValues.rowid) throw new Error('Invalid audit log cursor.');
    }
    const rows = this.database.prepare(`
      SELECT rowid AS rowid, * FROM audit_log
      WHERE (? IS NULL OR category = ?)
        AND (? IS NULL OR work_item_id = ?)
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND rowid < ?))
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(
      category ?? null, category ?? null,
      workItemId ?? null, workItemId ?? null,
      cursorValues?.rowid ?? null, cursorValues?.createdAt ?? null, cursorValues?.createdAt ?? null, cursorValues?.rowid ?? null,
      safeLimit + 1,
    ) as Array<{ rowid: number; id: string; category: AuditLogEntry['category']; source: string; detail: string; work_item_id: string | null; created_at: string }>;
    const hasMore = rows.length > safeLimit;
    const page = rows.slice(0, safeLimit);
    const entries = page.map((row) => ({
      id: row.id,
      category: row.category,
      source: row.source,
      detail: row.detail,
      workItemId: row.work_item_id,
      createdAt: row.created_at,
    }));
    const oldestRow = page.at(-1);
    const nextCursor = hasMore && oldestRow ? Buffer.from(JSON.stringify({ createdAt: oldestRow.created_at, rowid: oldestRow.rowid })).toString('base64url') : null;
    return { entries, nextCursor };
  }

  // --- Diagnostics and retention ----------------------------------------

  logDiagnostic(event: DiagnosticEvent['event'], subsystem: DiagnosticEvent['subsystem'], outcome: 'success' | 'failure', detail: string, durationMs?: number, errorCode?: string): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO diagnostics (id, event, subsystem, outcome, error_code, detail, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, event, subsystem, outcome, errorCode ?? null, detail, durationMs ?? null, now);
  }

  /**
   * Historical runs recorded tokens but no cost, because pricing used to be
   * keyed by agent and was never configured. Fill those gaps in from the model
   * rate table so the cost trend has history instead of starting from today.
   *
   * Only null costs are filled, so this is idempotent and never overwrites a
   * provider-reported total. Safe to call on every boot.
   */
  backfillEstimatedCosts(): number {
    const rows = this.database.prepare(`
      SELECT id, agent, model, input_tokens, output_tokens FROM agent_runs
      WHERE estimated_cost_usd IS NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
    `).all() as Array<{ id: string; agent: 'codex' | 'claude'; model: string | null; input_tokens: number | null; output_tokens: number | null }>;
    const messages = this.database.prepare(`
      SELECT id, author, model, input_tokens, output_tokens FROM shared_messages
      WHERE estimated_cost_usd IS NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
        AND author IN ('codex', 'claude')
    `).all() as Array<{ id: string; author: 'codex' | 'claude'; model: string | null; input_tokens: number | null; output_tokens: number | null }>;
    const updateRun = this.database.prepare('UPDATE agent_runs SET estimated_cost_usd = ? WHERE id = ?');
    const updateMessage = this.database.prepare('UPDATE shared_messages SET estimated_cost_usd = ? WHERE id = ?');
    let filled = 0;
    this.transaction(() => {
      for (const row of rows) {
        const cost = estimateModelCost(row.agent, row.model, row.input_tokens, row.output_tokens);
        if (cost === null) continue;
        updateRun.run(cost, row.id);
        filled += 1;
      }
      for (const row of messages) {
        const cost = estimateModelCost(row.author, row.model, row.input_tokens, row.output_tokens);
        if (cost === null) continue;
        updateMessage.run(cost, row.id);
        filled += 1;
      }
    });
    return filled;
  }

  getRunInsights(days: 7 | 30 = 30): RunInsights {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const runs = this.database.prepare(`
      SELECT agent, kind, status, attempt, fallback_from, model, input_tokens, output_tokens, estimated_cost_usd, created_at,
        CAST((julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 * 1000 AS INTEGER) as duration_ms
      FROM agent_runs WHERE status IN ('completed', 'failed', 'canceled') AND created_at >= ?
    `).all(since) as Array<{
      agent: 'codex' | 'claude';
      kind: AgentRun['kind'];
      status: 'completed' | 'failed' | 'canceled';
      attempt: number;
      fallback_from: string | null;
      model: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      estimated_cost_usd: number | null;
      created_at: string;
      duration_ms: number | null;
    }>;

    // Activities are the lifecycle ledger. `attempt` and `fallback_from` were
    // introduced later and are incomplete for existing chat runs.
    const lifecycleEvents = this.database.prepare(`
      SELECT kind, body FROM activities
      WHERE kind IN ('execution_retried', 'agent_fallback') AND created_at >= ?
    `).all(since) as Array<{ kind: 'execution_retried' | 'agent_fallback'; body: string }>;
    const retryEvents = lifecycleEvents.filter((event) => event.kind === 'execution_retried');
    const handoffEvents = lifecycleEvents.filter((event) => event.kind === 'agent_fallback');
    const retryCount = retryEvents.length || runs.filter((run) => run.attempt > 0).length;
    const handoffCount = handoffEvents.length || runs.filter((run) => run.fallback_from !== null).length;
    const retryRate = runs.length > 0 ? retryCount / runs.length : null;
    const fallbackRate = runs.length > 0 ? handoffCount / runs.length : null;
    const taskSummary = this.database.prepare(`
      SELECT
        SUM(CASE WHEN completed_at IS NOT NULL AND completed_at >= ? THEN 1 ELSE 0 END) AS completed_tasks,
        SUM(CASE WHEN parent_work_item_id IS NOT NULL AND created_at >= ? THEN 1 ELSE 0 END) AS follow_ups
      FROM work_items
    `).get(since, since) as { completed_tasks: number | null; follow_ups: number | null };
    // Active-work duration, not wall-clock cycle time: sum of each task's agent
    // run spans (started_at -> completed_at), so idle time between runs (waiting
    // on Jeffrey, sitting untouched) doesn't count as "task time".
    const taskActiveDurations = (this.database.prepare(`
      SELECT work_item_id,
        SUM(CAST((julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 * 1000 AS INTEGER)) AS duration_ms
      FROM agent_runs
      WHERE work_item_id IN (SELECT id FROM work_items WHERE completed_at IS NOT NULL AND completed_at >= ?)
        AND started_at IS NOT NULL AND completed_at IS NOT NULL
      GROUP BY work_item_id
    `).all(since) as Array<{ work_item_id: string; duration_ms: number | null }>).flatMap((row) => row.duration_ms === null ? [] : [row.duration_ms]);
    const cursingMessages = this.database.prepare(`
      SELECT jeffrey.body, jeffrey.created_at,
        (
          SELECT COALESCE(agent.model, agent.author)
          FROM shared_messages agent
          WHERE agent.conversation_id = jeffrey.conversation_id
            AND agent.author IN ('codex', 'claude')
            AND (agent.created_at < jeffrey.created_at OR (agent.created_at = jeffrey.created_at AND agent.rowid < jeffrey.rowid))
          ORDER BY agent.created_at DESC, agent.rowid DESC
          LIMIT 1
        ) AS prior_model
      FROM shared_messages jeffrey
      WHERE jeffrey.author = 'jeffrey' AND jeffrey.created_at >= ?
    `).all(since).map((row) => ({
      body: String((row as { body: string }).body),
      createdAt: String((row as { created_at: string }).created_at),
      model: (row as { prior_model: string | null }).prior_model,
    }));
    const cursingSummary = summarizeCursing(cursingMessages);
    const cursingByModel = new Map<string, Array<{ body: string; createdAt: string }>>();
    for (const message of cursingMessages) {
      if (!message.model) continue;
      const messages = cursingByModel.get(message.model) ?? [];
      messages.push(message);
      cursingByModel.set(message.model, messages);
    }
    const cursing = {
      ...cursingSummary,
      byModel: [...cursingByModel.entries()].map(([model, messages]) => {
        const summary = summarizeCursing(messages);
        return { model, count: summary.total, messagesWithCurses: summary.messagesWithCurses, messagesAnalyzed: summary.messagesAnalyzed, instancesPer100Messages: summary.instancesPer100Messages };
      }).filter((row) => row.count > 0).sort((left, right) => right.count - left.count || left.model.localeCompare(right.model)),
    };

    const costByDay: Record<string, number> = {};
    const costByAgent: Record<'codex' | 'claude', number> = { codex: 0, claude: 0 };
    const tokenUsageByModel = new Map<string, { provider: 'codex' | 'claude'; model: string | null; inputTokens: number; outputTokens: number; costUsd: number; runs: number }>();
    let totalCostUsd = 0;
    let pricedRuns = 0;
    let unpricedRuns = 0;
    for (const run of runs) {
      const day = run.created_at.slice(0, 10);
      costByDay[day] = (costByDay[day] ?? 0) + (run.estimated_cost_usd ?? 0);
      totalCostUsd += run.estimated_cost_usd ?? 0;
      costByAgent[run.agent] += run.estimated_cost_usd ?? 0;
      if (run.estimated_cost_usd !== null) pricedRuns += 1;
      // A run that reported tokens but carries no cost has no rate for its
      // model. Surfacing that count keeps the total honest rather than silently low.
      else if (run.input_tokens !== null || run.output_tokens !== null) unpricedRuns += 1;
      if (run.input_tokens !== null || run.output_tokens !== null) {
        const key = `${run.agent}:${run.model ?? ''}`;
        const bucket = tokenUsageByModel.get(key) ?? { provider: run.agent, model: run.model, inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
        bucket.inputTokens += run.input_tokens ?? 0;
        bucket.outputTokens += run.output_tokens ?? 0;
        bucket.costUsd += run.estimated_cost_usd ?? 0;
        bucket.runs += 1;
        tokenUsageByModel.set(key, bucket);
      }
    }
    // Trend compares this window against the equally long window before it.
    const previousWindowStart = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000).toISOString();
    const previousCost = this.database.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost, COUNT(*) AS runs FROM agent_runs
      WHERE status IN ('completed', 'failed', 'canceled') AND created_at >= ? AND created_at < ?
    `).get(previousWindowStart, since) as { cost: number | null; runs: number | null };
    const previousCostUsd = previousCost.runs ? Number(previousCost.cost ?? 0) : null;

    const fitBuckets = new Map<string, { kind: AgentRun['kind']; agent: 'codex' | 'claude'; completed: number; failed: number; durations: number[] }>();
    for (const run of runs) {
      const key = `${run.kind}:${run.agent}`;
      const bucket = fitBuckets.get(key) ?? { kind: run.kind, agent: run.agent, completed: 0, failed: 0, durations: [] };
      if (run.status === 'completed') bucket.completed += 1;
      else if (run.status === 'failed') bucket.failed += 1;
      if (run.duration_ms !== null) bucket.durations.push(run.duration_ms);
      fitBuckets.set(key, bucket);
    }

    type AgentBucket = { total: number; completed: number; failed: number; retried: number; fallback: number; durations: number[] };
    const byAgent: Record<'codex' | 'claude', AgentBucket> = {
      codex: { total: 0, completed: 0, failed: 0, retried: 0, fallback: 0, durations: [] },
      claude: { total: 0, completed: 0, failed: 0, retried: 0, fallback: 0, durations: [] },
    };
    for (const run of runs) {
      const bucket = byAgent[run.agent];
      bucket.total += 1;
      if (run.status === 'completed') bucket.completed += 1;
      if (run.status === 'failed') bucket.failed += 1;
      if (run.duration_ms !== null) bucket.durations.push(run.duration_ms);
    }
    for (const event of retryEvents) {
      const agent = /Retrying (codex|claude)\b/i.exec(event.body)?.[1]?.toLowerCase() as 'codex' | 'claude' | undefined;
      if (agent) byAgent[agent].retried += 1;
    }
    for (const event of handoffEvents) {
      const agent = /continued with (codex|claude)\b/i.exec(event.body)?.[1]?.toLowerCase() as 'codex' | 'claude' | undefined;
      if (agent) byAgent[agent].fallback += 1;
    }
    if (retryEvents.length === 0) for (const run of runs) if (run.attempt > 0) byAgent[run.agent].retried += 1;
    if (handoffEvents.length === 0) for (const run of runs) if (run.fallback_from !== null) byAgent[run.agent].fallback += 1;

    type KindBucket = { completed: number; failed: number };
    const byKind: Record<AgentRun['kind'], KindBucket> = {
      research: { completed: 0, failed: 0 },
      analysis: { completed: 0, failed: 0 },
      strategy: { completed: 0, failed: 0 },
      execute: { completed: 0, failed: 0 },
      review: { completed: 0, failed: 0 },
    };
    for (const run of runs) {
      if (run.status === 'completed') byKind[run.kind].completed += 1;
      if (run.status === 'failed') byKind[run.kind].failed += 1;
    }

    return {
      retryRate,
      retryCount,
      fallbackRate,
      handoffCount,
      inputTokens: [...tokenUsageByModel.values()].reduce((total, bucket) => total + bucket.inputTokens, 0),
      outputTokens: [...tokenUsageByModel.values()].reduce((total, bucket) => total + bucket.outputTokens, 0),
      costUsd: Number(totalCostUsd.toFixed(6)),
      previousCostUsd: previousCostUsd === null ? null : Number(previousCostUsd.toFixed(6)),
      pricedRuns,
      unpricedRuns,
      tokenUsageByModel: [...tokenUsageByModel.values()].map((bucket) => ({
        ...bucket,
        costUsd: Number(bucket.costUsd.toFixed(6)),
        rateSource: resolveModelRate(bucket.provider, bucket.model)?.source ?? null,
      })).sort((left, right) => {
        const usageDifference = (right.inputTokens + right.outputTokens) - (left.inputTokens + left.outputTokens);
        if (usageDifference !== 0) return usageDifference;
        return `${left.provider}:${left.model ?? ''}`.localeCompare(`${right.provider}:${right.model ?? ''}`);
      }),
      completedRuns: runs.filter((run) => run.status === 'completed').length,
      completedTasks: taskSummary.completed_tasks ?? 0,
      medianTaskCycleMs: median(excludeExtremeOutliers(taskActiveDurations)),
      followUpsCreated: taskSummary.follow_ups ?? 0,
      cursing,
      agentFit: [...fitBuckets.values()].map((bucket) => ({
        kind: bucket.kind,
        agent: bucket.agent,
        completed: bucket.completed,
        failed: bucket.failed,
        successRate: bucket.completed + bucket.failed > 0 ? bucket.completed / (bucket.completed + bucket.failed) : null,
        medianDurationMs: median(bucket.durations),
      })),
      costByDay: Object.entries(costByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, costUsd]) => ({ day, costUsd: Number(costUsd.toFixed(6)) })),
      byAgent: Object.entries(byAgent).map(([agent, bucket]) => ({
        agent: agent as 'codex' | 'claude',
        total: bucket.total,
        completed: bucket.completed,
        failed: bucket.failed,
        successRate: bucket.completed + bucket.failed > 0 ? bucket.completed / (bucket.completed + bucket.failed) : null,
        retryRate: bucket.total > 0 ? bucket.retried / bucket.total : null,
        fallbackRate: bucket.total > 0 ? bucket.fallback / bucket.total : null,
        medianDurationMs: median(bucket.durations),
        p90DurationMs: percentile(bucket.durations, 0.9),
        costUsd: Number(costByAgent[agent as 'codex' | 'claude'].toFixed(6)),
      })),
      byKind: Object.entries(byKind)
        .filter(([, bucket]) => bucket.completed + bucket.failed > 0)
        .map(([kind, bucket]) => ({
          kind: kind as AgentRun['kind'],
          completed: bucket.completed,
          failed: bucket.failed,
          successRate: bucket.completed + bucket.failed > 0 ? bucket.completed / (bucket.completed + bucket.failed) : null,
        })),
    };
  }

  compactTerminalRuns(retentionDays: number = 7): number {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const changed = this.database.prepare(`
      UPDATE agent_runs
      SET output = '', instructions = ''
      WHERE status IN ('completed', 'failed') AND completed_at < ? AND (output != '' OR instructions != '')
    `).run(cutoffDate).changes;
    return Number(changed);
  }

  pruneArchivedMessages(retentionDays: number = 90): number {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const changed = this.database.prepare(`
      DELETE FROM shared_messages
      WHERE conversation_id IN (SELECT id FROM shared_conversations WHERE archived_at IS NOT NULL AND archived_at < ?)
        AND pinned = 0
    `).run(cutoffDate).changes;
    return Number(changed);
  }

  runRetentionCleanup(): void {
    const start = Date.now();
    try {
      const compactedRuns = this.compactTerminalRuns(7);
      const prunedMessages = this.pruneArchivedMessages(90);
      const durationMs = Date.now() - start;

      this.logDiagnostic(
        'retention_cleanup',
        'retention',
        'success',
        `Compacted ${compactedRuns} terminal runs and pruned ${prunedMessages} archived messages.`,
        durationMs,
      );
    } catch (error) {
      const durationMs = Date.now() - start;
      this.logDiagnostic(
        'retention_cleanup',
        'retention',
        'failure',
        String(error),
        durationMs,
        'cleanup_error',
      );
    }
  }

  surfaceStrandedRuns(graceMs = 3 * 60_000): string[] {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    const stranded = this.database.prepare(`
      SELECT id, work_item_id, message_id FROM agent_runs
      WHERE status = 'running' AND lease_expires_at IS NULL AND created_at <= ?
    `).all(cutoff) as Array<{ id: string; work_item_id: string; message_id: string | null }>;
    if (stranded.length > 0) {
      const now = new Date().toISOString();
      this.database.exec('BEGIN IMMEDIATE');
      try {
        for (const run of stranded) {
          this.database.prepare(`UPDATE agent_runs
            SET status = 'failed', error = 'Agent process stopped reporting progress. Retry or continue the conversation.', completed_at = ?, owner_id = NULL, lease_expires_at = NULL
            WHERE id = ? AND status = 'running' AND lease_expires_at IS NULL`).run(now, run.id);
          if (run.message_id) this.database.prepare(`UPDATE shared_messages
            SET status = 'failed', error = 'Agent process stopped reporting progress. Retry or continue the conversation.', completed_at = ?, owner_id = NULL, lease_expires_at = NULL
            WHERE id = ? AND status = 'running'`).run(now, run.message_id);
          this.database.prepare(`UPDATE work_items SET status = 'ready', updated_at = ?, last_touched_at = ?
            WHERE id = ? AND status = 'in_progress'
              AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE work_item_id = ? AND status IN ('queued', 'running'))`).run(now, now, run.work_item_id, run.work_item_id);
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      this.logDiagnostic(
        'run_recovery',
        'recovery',
        'failure',
        `Marked ${stranded.length} stranded runs without leases failed: ${stranded.map((r) => r.id).join(', ')}`,
        undefined,
        'stranded_no_lease',
      );
    }
    return stranded.map((r) => r.id);
  }
}
