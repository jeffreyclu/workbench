import { randomUUID } from 'node:crypto';
import type { Activity, AgentRun, ArtifactSummary, Assignee, ConversationPage, DiscoveryCandidate, DiscoveryCandidateStatus, DiscoveryInbox, DiscoveryRun, ExecutionPlan, LinearProviderConfig, Memory, PlannedTask, QueueItemExplanation, QueueOrderChange, QueueProposal, QueueSignalKey, SharedAttachment, SharedConversation, SharedMemory, SharedMessage, SharedMessagePage, SharedSearchResult, SourceConnection, SourceProvider, TaskClassification, WorkItem, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../shared/contracts.js';
import { learnFeedbackWeights, planQueue, type FeedbackWeight, type QueueContext, type QueuePlan } from './queue-intelligence.js';
import type { WorkbenchDatabase } from './database.js';
import { ArtifactLibrary } from './artifact-library.js';

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
  workspace_path: string | null;
  strategy: string;
  assignees_json: string;
  labels_json: string;
  due_date: string | null;
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

interface MemoryRow {
  id: string;
  kind: Memory['kind'];
  scope: Memory['scope'];
  project_name: string | null;
  workspace_path: string | null;
  body: string;
  status: Memory['status'];
  supersedes_id: string | null;
  source_task_id: string | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_quote: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id, kind: row.kind, scope: row.scope,
    projectName: row.project_name, workspacePath: row.workspace_path,
    body: row.body, status: row.status, supersedesId: row.supersedes_id,
    sourceTaskId: row.source_task_id, sourceConversationId: row.source_conversation_id,
    sourceMessageId: row.source_message_id, sourceQuote: row.source_quote,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const MEMORY_KIND_PRIORITY: Record<Memory['kind'], number> = { constraint: 0, preference: 1, decision: 2, convention: 3, fact: 4 };

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

export class WorkItemRepository {
  constructor(private readonly database: WorkbenchDatabase) {}

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
    const suggested = input.sourceUrl ? this.database.prepare(`SELECT id FROM work_items WHERE source_url = ? AND archived_at IS NULL ORDER BY is_queued DESC, updated_at DESC LIMIT 1`).get(input.sourceUrl) as { id: string } | undefined : undefined;
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
    const row = this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ?').get(id) as Record<string, string | null> | undefined;
    if (!row || row.status !== 'pending') return null;
    const candidate = this.mapDiscoveryCandidate(row); const now = new Date().toISOString();
    const claimed = this.database.prepare("UPDATE discovery_candidates SET status = 'resolving', updated_at = ? WHERE id = ? AND status = 'pending'").run(now, id).changes;
    if (!claimed) return null;
    let linkedId = workItemId ?? null;
    try {
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
      this.database.prepare("UPDATE discovery_candidates SET status = ?, work_item_id = ?, snoozed_until = ?, updated_at = ? WHERE id = ? AND status = 'resolving'").run(status, linkedId, snoozedUntil, now, id);
      return this.mapDiscoveryCandidate(this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ?').get(id) as Record<string, string | null>);
    } catch (error) {
      this.database.prepare("UPDATE discovery_candidates SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'resolving'").run(new Date().toISOString(), id);
      throw error;
    }
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
        ) AS is_active
      FROM shared_conversations
      WHERE (? = 'all' OR (? = 'active' AND archived_at IS NULL) OR (? = 'archive' AND archived_at IS NOT NULL))
      ORDER BY updated_at DESC
    `).all(view, view, view) as Array<Record<string, string | number | null>>).map((row) => ({
      id: String(row.id), title: String(row.title), workItemId: row.work_item_id ? String(row.work_item_id) : null,
      forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
    }));
  }

  getConversation(id: string): SharedConversation | null {
    return this.listConversations('all').find((conversation) => conversation.id === id) ?? null;
  }

  listConversationPage(limit: number, cursor: string | null, view: 'active' | 'archive' = 'active'): ConversationPage {
    const safeLimit = Math.max(1, Math.min(100, limit));
    let cursorValues: { updatedAt: string; id: string } | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt: string; id: string }; }
      catch { throw new Error('Invalid conversation cursor.'); }
      if (!cursorValues?.updatedAt || !cursorValues.id) throw new Error('Invalid conversation cursor.');
    }
    const rows = this.database.prepare(`
      SELECT shared_conversations.*,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.status = 'running') AS is_active
      FROM shared_conversations
      WHERE ((? = 'active' AND archived_at IS NULL) OR (? = 'archive' AND archived_at IS NOT NULL))
        AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(view, view, cursorValues?.id ?? null, cursorValues?.updatedAt ?? null, cursorValues?.updatedAt ?? null, cursorValues?.id ?? null, safeLimit + 1) as Array<Record<string, string | number | null>>;
    const hasMore = rows.length > safeLimit;
    const conversations = rows.slice(0, safeLimit).map((row) => ({
      id: String(row.id), title: String(row.title), workItemId: row.work_item_id ? String(row.work_item_id) : null,
      forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
    }));
    const last = conversations.at(-1);
    return { conversations, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null,
      totalCount: Number((this.database.prepare(`SELECT COUNT(*) AS count FROM shared_conversations WHERE (${view === 'active' ? 'archived_at IS NULL' : 'archived_at IS NOT NULL'})`).get() as { count: number }).count) };
  }

  createConversation(title = 'New conversation', workItemId: string | null = null): SharedConversation {
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare('INSERT INTO shared_conversations (id, title, work_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, title, workItemId, now, now);
    return { id, title, workItemId, forkedFromConversationId: null, archivedAt: null, createdAt: now, updatedAt: now, isActive: false };
  }

  setConversationArchived(id: string, archived: boolean): SharedConversation | null {
    const now = new Date().toISOString();
    const memory = archived ? this.buildConversationMemory(id) : null;
    this.database.exec('BEGIN IMMEDIATE');
    let changed = false;
    try {
      changed = Number(this.database.prepare('UPDATE shared_conversations SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? now : null, now, id).changes) > 0;
      if (changed && memory) this.database.prepare("INSERT INTO shared_memories (id, kind, body, created_at) VALUES (?, 'conversation_archive', ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at").run(`conversation:${id}`, memory, now);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return changed ? this.listConversations('all').find((conversation) => conversation.id === id) ?? null : null;
  }

  private buildConversationMemory(id: string): string | null {
    const conversation = this.listConversations('all').find((entry) => entry.id === id);
    if (!conversation) return null;
    const messages = this.listAllSharedMessages(id).filter((message) => message.status === 'completed' && message.body.trim()).slice(-8);
    if (!messages.length) return null;
    return [`Archived conversation: ${conversation.title}`, ...messages.map((message) => `${message.author}: ${message.body.trim().slice(0, 1_500)}`)].join('\n\n').slice(0, 12_000);
  }

  forkConversation(id: string): SharedConversation | null {
    const source = this.listConversations('all').find((conversation) => conversation.id === id);
    if (!source) return null;
    const fork = this.createConversation(`${source.title} · fork`, source.workItemId);
    this.database.prepare('UPDATE shared_conversations SET forked_from_conversation_id = ? WHERE id = ?').run(source.id, fork.id);
    const messages = this.listAllSharedMessages(source.id);
    for (const message of messages) this.createSharedMessage(message.author, message.body, message.status === 'running' || message.status === 'queued' ? 'completed' : message.status, fork.id, message.attachments, 'none');
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

  deleteConversation(id: string): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM shared_messages WHERE conversation_id = ?').run(id);
      const changed = Number(this.database.prepare('DELETE FROM shared_conversations WHERE id = ?').run(id).changes) > 0;
      this.database.exec('COMMIT'); return changed;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  listSourceConnections(): SourceConnection[] {
    const rows = this.database.prepare('SELECT provider, label, last_scanned_at, last_error FROM source_connections ORDER BY provider').all() as Array<Record<string, string | null>>;
    return rows.map((row) => ({ provider: row.provider as SourceProvider, connected: true, label: row.label!, lastScannedAt: row.last_scanned_at, lastError: row.last_error, configurationState: row.last_error ? 'reauth_required' as const : 'connected' as const, health: row.last_error ? 'unavailable' as const : row.last_scanned_at ? 'healthy' as const : 'unknown' as const }));
  }

  getSourceSettings(provider: SourceProvider): Record<string, string> | null {
    const row = this.database.prepare('SELECT settings_json FROM source_connections WHERE provider = ?').get(provider) as { settings_json: string } | undefined;
    return row ? JSON.parse(row.settings_json) as Record<string, string> : null;
  }

  setSourceConnection(provider: SourceProvider, label: string, settings: Record<string, string>): SourceConnection {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO source_connections (provider, label, settings_json, connected_at, last_error)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET label = excluded.label, settings_json = excluded.settings_json, connected_at = excluded.connected_at, last_error = NULL`)
      .run(provider, label, JSON.stringify(settings), now);
    return this.listSourceConnections().find((connection) => connection.provider === provider)!;
  }

  updateSourceScan(provider: SourceProvider, error: string | null): void {
    this.database.prepare('UPDATE source_connections SET last_scanned_at = ?, last_error = ? WHERE provider = ?').run(new Date().toISOString(), error, provider);
  }

  markSourceReauthRequired(provider: SourceProvider, message: string): void {
    this.database.prepare('UPDATE source_connections SET last_scanned_at = ?, last_error = ? WHERE provider = ?').run(new Date().toISOString(), message, provider);
  }

  removeSourceConnection(provider: SourceProvider): void {
    this.database.prepare('DELETE FROM source_connections WHERE provider = ?').run(provider);
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
      WHERE conversations_fts MATCH ?
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
      WHERE messages_fts MATCH ?
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
    const entries = Object.entries({
      pinned: changes.pinned === undefined ? undefined : Number(changes.pinned),
      body: changes.body, status: changes.status, error: changes.error, author: changes.author, model: changes.model, execution_profile: changes.executionProfile,
      input_tokens: changes.inputTokens, output_tokens: changes.outputTokens, estimated_cost_usd: changes.estimatedCostUsd, fallback_from: changes.fallbackFrom, fallback_reason: changes.fallbackReason,
      completed_at: changes.completedAt ?? (changes.status && ['completed', 'failed', 'canceled'].includes(changes.status) ? new Date().toISOString() : undefined),
    }).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
    if (entries.length) this.database.prepare(`UPDATE shared_messages SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    return this.getSharedMessageById(id);
  }

  /**
   * excludeConversationId: don't quote the conversation we're currently replying in
   * back at itself. scope: which structured memories to surface — resolved from a
   * work item, a conversation (which resolves to its linked work item), or neither
   * (global memories only, correct for contexts with no known project yet).
   */
  getSharedContext(excludeConversationId?: string, scope?: { workItemId?: string; conversationId?: string }): string {
    const messages = this.listSharedMessages(120).messages.filter((message) => message.conversationId !== excludeConversationId);
    const allMemories = this.listMemories(undefined, 50);
    const recent = messages.filter((message) => message.status === 'completed' && message.body).slice(-6);
    const format = (message: SharedMessage) => `${message.author}: ${message.body.slice(0, 1_500)}`;

    // Phase 1: the ~8k char budget (~2k tokens) is split 60/40 between structured
    // memories and the legacy archive/assistant-note lines below. This is a
    // deliberate mitigation for the overlap phase where both sources feed the
    // same prompt block (see docs/memory-strategy.md, R2) — it costs the archive
    // block some headroom, but caps how much a bad structured memory can crowd out.
    const totalBudget = 8_000;
    const structuredBudget = Math.floor(totalBudget * 0.6);
    const { memories: scopedMemories, omitted: cappedOmitted } = this.selectScopedMemories(scope);
    let structuredBudgetRemaining = structuredBudget;
    const structuredLines: string[] = [];
    for (const memory of scopedMemories) {
      const line = `- [${memory.kind}] ${memory.body}`;
      if (line.length > structuredBudgetRemaining) break;
      structuredLines.push(line);
      structuredBudgetRemaining -= line.length + 1;
    }
    const structuredOmitted = cappedOmitted + (scopedMemories.length - structuredLines.length);
    const structuredBlock = structuredLines.length
      ? [
        'Structured memories (durable facts/decisions/preferences/constraints):',
        '```',
        ...structuredLines,
        '```',
        structuredOmitted > 0 ? `(${structuredOmitted} more structured memories omitted due to budget)` : '',
      ].filter(Boolean).join('\n')
      : '';

    let budgetRemaining = totalBudget - structuredBudget;
    const memoriesLines: string[] = [];
    for (const { kind, body } of allMemories) {
      const truncated = body.slice(0, 1_500);
      const line = `${kind.startsWith('assistant_') ? 'memory' : 'archive'}: ${truncated}`;
      if (line.length > budgetRemaining) break;
      memoriesLines.push(line);
      budgetRemaining -= line.length + 1; // +1 for newline
    }

    const memoriesText = memoriesLines.join('\n');
    const omitted = allMemories.length - memoriesLines.length;
    const recentText = recent.map(format).join('\n');

    return [
      structuredBlock,
      'Durable context from archived work:',
      memoriesText || 'No durable context yet.',
      omitted > 0 ? `(${omitted} older memories omitted due to budget)` : '',
      '', 'Recent shared room:',
      recentText || 'No recent conversation.',
    ].filter(Boolean).join('\n');
  }

  private resolveMemoryScope(scope?: { workItemId?: string; conversationId?: string }): { workItemId: string | null; conversationId: string | null; projectName: string | null; workspacePath: string | null } {
    if (!scope) return { workItemId: null, conversationId: null, projectName: null, workspacePath: null };
    let workItemId = scope.workItemId ?? null;
    const conversationId = scope.conversationId ?? null;
    if (!workItemId && conversationId) {
      const conversation = this.database.prepare('SELECT work_item_id FROM shared_conversations WHERE id = ?').get(conversationId) as { work_item_id: string | null } | undefined;
      workItemId = conversation?.work_item_id ?? null;
    }
    let projectName: string | null = null;
    let workspacePath: string | null = null;
    if (workItemId) {
      const item = this.database.prepare('SELECT project_name, workspace_path FROM work_items WHERE id = ?').get(workItemId) as { project_name: string | null; workspace_path: string | null } | undefined;
      projectName = item?.project_name ?? null;
      workspacePath = item?.workspace_path ?? null;
    }
    return { workItemId, conversationId, projectName, workspacePath };
  }

  /** Active-only scoped memory selection: global (capped) -> project -> workspace -> linked-reference, each sorted by kind priority then recency. */
  private selectScopedMemories(scope?: { workItemId?: string; conversationId?: string }): { memories: Memory[]; omitted: number } {
    if (process.env.WORKBENCH_MEMORY_DISABLED === '1') return { memories: [], omitted: 0 };
    const resolved = this.resolveMemoryScope(scope);
    const sortPartition = (rows: MemoryRow[]) => rows.map(mapMemory).sort((a, b) => (
      MEMORY_KIND_PRIORITY[a.kind] - MEMORY_KIND_PRIORITY[b.kind]
    ) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    const globalRows = this.database.prepare(`SELECT * FROM memories WHERE status = 'active' AND scope = 'global'`).all() as unknown as MemoryRow[];
    const sortedGlobal = sortPartition(globalRows);
    const globalOmitted = Math.max(0, sortedGlobal.length - 10);
    const global = sortedGlobal.slice(0, 10);

    const project = resolved.projectName
      ? sortPartition(this.database.prepare(`SELECT * FROM memories WHERE status = 'active' AND scope = 'project' AND project_name = ?`).all(resolved.projectName) as unknown as MemoryRow[])
      : [];

    const workspace = resolved.workspacePath
      ? sortPartition(this.database.prepare(`SELECT * FROM memories WHERE status = 'active' AND scope = 'workspace' AND workspace_path = ?`).all(resolved.workspacePath) as unknown as MemoryRow[])
      : [];

    const reference = (resolved.workItemId || resolved.conversationId)
      ? sortPartition(this.database.prepare(`SELECT * FROM memories WHERE status = 'active' AND scope = 'reference' AND (source_task_id = ? OR source_conversation_id = ?)`).all(resolved.workItemId ?? null, resolved.conversationId ?? null) as unknown as MemoryRow[])
      : [];

    return { memories: [...global, ...project, ...workspace, ...reference], omitted: globalOmitted };
  }

  createMemory(input: {
    kind: Memory['kind']; scope: Memory['scope']; projectName: string | null; workspacePath: string | null; body: string;
    sourceTaskId: string | null; sourceConversationId: string | null; sourceMessageId: string | null; sourceQuote: string | null; createdBy: string | null;
  }): Memory {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO memories (id, kind, scope, project_name, workspace_path, body, status, supersedes_id, source_task_id, source_conversation_id, source_message_id, source_quote, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.kind, input.scope, input.projectName, input.workspacePath, input.body, input.sourceTaskId, input.sourceConversationId, input.sourceMessageId, input.sourceQuote, input.createdBy, now, now);
    return this.getMemory(id)!;
  }

  getMemory(id: string): Memory | null {
    const row = this.database.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? mapMemory(row) : null;
  }

  listMemoriesStructured(filter?: { scope?: Memory['scope']; projectName?: string; status?: Memory['status']; kind?: Memory['kind'] }): Memory[] {
    const rows = this.database.prepare(`
      SELECT * FROM memories
      WHERE (? IS NULL OR scope = ?)
        AND (? IS NULL OR project_name = ?)
        AND (? IS NULL OR status = ?)
        AND (? IS NULL OR kind = ?)
      ORDER BY created_at DESC, id DESC
    `).all(
      filter?.scope ?? null, filter?.scope ?? null,
      filter?.projectName ?? null, filter?.projectName ?? null,
      filter?.status ?? null, filter?.status ?? null,
      filter?.kind ?? null, filter?.kind ?? null,
    ) as unknown as MemoryRow[];
    return rows.map(mapMemory);
  }

  updateMemory(id: string, changes: { kind?: Memory['kind']; body?: string; projectName?: string | null; workspacePath?: string | null; status?: Memory['status'] }): Memory | null {
    const entries = Object.entries({
      kind: changes.kind, body: changes.body, project_name: changes.projectName, workspace_path: changes.workspacePath, status: changes.status,
    }).filter((entry): entry is [string, string | null] => entry[1] !== undefined);
    if (!entries.length) return this.getMemory(id);
    entries.push(['updated_at', new Date().toISOString()]);
    this.database.prepare(`UPDATE memories SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    return this.getMemory(id);
  }

  /** Marks the current memory superseded and creates its active replacement, preserving scope/project/workspace/source. Returns the replacement. */
  supersedeMemory(id: string, input: { kind: Memory['kind']; body: string }): Memory | null {
    const current = this.getMemory(id);
    if (!current) return null;
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?`).run(now, id);
    const replacementId = randomUUID();
    this.database.prepare(`
      INSERT INTO memories (id, kind, scope, project_name, workspace_path, body, status, supersedes_id, source_task_id, source_conversation_id, source_message_id, source_quote, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(replacementId, input.kind, current.scope, current.projectName, current.workspacePath, input.body, id, current.sourceTaskId, current.sourceConversationId, current.sourceMessageId, current.sourceQuote, current.createdBy, now, now);
    return this.getMemory(replacementId);
  }

  rejectMemory(id: string): Memory | null {
    const current = this.getMemory(id);
    if (!current) return null;
    this.database.prepare(`UPDATE memories SET status = 'rejected', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
    return this.getMemory(id);
  }

  listMemories(kind?: SharedMemory['kind'], limit = 50): SharedMemory[] {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = this.database.prepare(`
      SELECT id, kind, body, created_at FROM shared_memories
      WHERE (? IS NULL OR kind = ?)
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(kind ?? null, kind ?? null, safeLimit) as Array<{ id: string; kind: SharedMemory['kind']; body: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, body: row.body, createdAt: row.created_at }));
  }

  recordMemory(actor: 'codex' | 'claude', body: string): SharedMemory {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const kind: SharedMemory['kind'] = actor === 'codex' ? 'assistant_codex' : 'assistant_claude';
    this.database.prepare('INSERT INTO shared_memories (id, kind, body, created_at) VALUES (?, ?, ?, ?)')
      .run(id, kind, body, createdAt);
    return { id, kind, body, createdAt };
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
        WHERE is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled')
          AND ${stack === 'workbench' ? "project_name = 'Workbench' COLLATE NOCASE" : "COALESCE(project_name, '') != 'Workbench' COLLATE NOCASE"}
        ORDER BY queue_position ASC, created_at ASC
      `)
      .all() as unknown as WorkItemRow[];
    return rows.map((row) => this.withAgentOutcome(mapWorkItem(row)));
  }

  listArchived(): WorkItem[] {
    const rows = this.database.prepare(`SELECT * FROM work_items WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`).all() as unknown as WorkItemRow[];
    return rows.map((row) => this.withAgentOutcome(mapWorkItem(row)));
  }

  listPage(view: 'active' | 'workbench' | 'archive', limit: number, cursor: string | null, query: string): WorkItemPage {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const needle = query.trim() ? `%${query.trim()}%` : null;
    let cursorValues: { position?: number; archivedAt?: string; id: string } | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { position?: number; archivedAt?: string; id: string }; }
      catch { throw new Error('Invalid work-item cursor.'); }
      if (!cursorValues?.id) throw new Error('Invalid work-item cursor.');
    }
    const search = `(? IS NULL OR title LIKE ? COLLATE NOCASE OR source_identifier LIKE ? COLLATE NOCASE OR project_name LIKE ? COLLATE NOCASE)`;
    const searchArgs = [needle, needle, needle, needle];
    const active = `is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled') AND COALESCE(project_name, '') != 'Workbench' COLLATE NOCASE`;
    const workbench = `is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled') AND project_name = 'Workbench' COLLATE NOCASE`;
    const archived = `archived_at IS NOT NULL`;
    const where = view === 'active' ? active : view === 'workbench' ? workbench : archived;
    const cursorClause = view !== 'archive'
      ? `(? IS NULL OR queue_position > ? OR (queue_position = ? AND id > ?))`
      : `(? IS NULL OR archived_at < ? OR (archived_at = ? AND id < ?))`;
    const cursorArgs = view !== 'archive'
      ? [cursorValues?.id ?? null, cursorValues?.position ?? null, cursorValues?.position ?? null, cursorValues?.id ?? null]
      : [cursorValues?.id ?? null, cursorValues?.archivedAt ?? null, cursorValues?.archivedAt ?? null, cursorValues?.id ?? null];
    const order = view !== 'archive' ? 'queue_position ASC, id ASC' : 'archived_at DESC, id DESC';
    const rows = this.database.prepare(`SELECT * FROM work_items WHERE ${where} AND ${search} AND ${cursorClause} ORDER BY ${order} LIMIT ?`)
      .all(...searchArgs, ...cursorArgs, safeLimit + 1) as unknown as WorkItemRow[];
    const hasMore = rows.length > safeLimit;
    const pageRows = rows.slice(0, safeLimit);
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify(view !== 'archive'
      ? { position: last.queue_position, id: last.id }
      : { archivedAt: last.archived_at, id: last.id })).toString('base64url') : null;
    const totalCount = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM work_items WHERE ${where} AND ${search}`)
      .get(...searchArgs) as { count: number }).count);
    return { items: pageRows.map((row) => this.withAgentOutcome(mapWorkItem(row))), nextCursor, totalCount, proposal: view === 'active' ? this.getPendingProposal() : null };
  }

  getWorkItemCounts(): { active: number; workbench: number; archive: number } {
    const row = this.database.prepare(`SELECT
      SUM(CASE WHEN is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled') AND COALESCE(project_name, '') != 'Workbench' COLLATE NOCASE THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled') AND project_name = 'Workbench' COLLATE NOCASE THEN 1 ELSE 0 END) AS workbench,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archive FROM work_items`).get() as { active: number | null; workbench: number | null; archive: number | null };
    return { active: Number(row.active ?? 0), workbench: Number(row.workbench ?? 0), archive: Number(row.archive ?? 0) };
  }

  get(id: string): WorkItem | null {
    const row = this.database.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as
      | WorkItemRow
      | undefined;
    return row ? this.withAgentOutcome(mapWorkItem(row)) : null;
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
    if (recentStatuses.some(({ status }) => status === 'queued' || status === 'running')) return item;
    if (recentStatuses.some(({ status }) => status === 'failed' || status === 'canceled')) return { ...item, agentOutcome: 'needs_attention' };
    if (recentStatuses.some(({ status }) => status === 'completed')) {
      return { ...item, agentOutcome: this.getPendingExecutionPlan(item.id) ? 'follow_ups' : 'finished' };
    }
    return item;
  }

  searchLinear(query: string, limit = 20): WorkItem[] {
    const needle = `%${query.trim()}%`;
    const rows = this.database
      .prepare(`
        SELECT * FROM work_items
        WHERE source = 'linear'
          AND (title LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE OR project_name LIKE ? COLLATE NOCASE
            OR source_identifier LIKE ? COLLATE NOCASE OR source_url LIKE ? COLLATE NOCASE)
        ORDER BY is_queued DESC, priority ASC, provider_updated_at DESC
        LIMIT ?
      `)
      .all(needle, needle, needle, needle, needle, limit) as unknown as WorkItemRow[];
    return rows.map(mapWorkItem);
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
    const inferredStack = stack ?? (this.get(orderedItemIds[0] ?? '')?.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention');
    const stackItems = inferredStack === 'workbench' ? this.listWorkbench() : this.list();
    const currentIds = stackItems.map((item) => item.id);
    if (currentIds.length !== orderedItemIds.length || !currentIds.every((id) => orderedItemIds.includes(id))) {
      throw new Error('Queue order must contain every active queued item exactly once.');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
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
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
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
    const currentIds = new Set((stack === 'workbench' ? this.listWorkbench() : this.list()).map((item) => item.id));
    const rows = this.database.prepare('SELECT * FROM queue_order_history WHERE stack = ? AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 25')
      .all(stack) as Array<Record<string, string | null>>;
    for (const row of rows) {
      const change = this.mapQueueOrderChange(row);
      const applicable = change.previousOrder.length === currentIds.size && change.previousOrder.every((id) => currentIds.has(id));
      if (!applicable) continue;
      const undoneAt = new Date().toISOString();
      const highWaterMark = Number((this.database.prepare('SELECT COALESCE(MAX(rowid), 0) AS mark FROM queue_order_history').get() as { mark: number }).mark);
      this.database.prepare('UPDATE queue_order_history SET undone_at = ? WHERE id = ?').run(undoneAt, change.id);
      this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending'").run(undoneAt);
      const items = this.reorder(change.previousOrder, stack, { actor: 'jeffrey', reason: `Undo of: ${change.reason}` });
      // The undo's own journal entry is closed immediately, so a second undo walks
      // further back in history instead of toggling the same pair forever.
      this.database.prepare('UPDATE queue_order_history SET undone_at = ? WHERE rowid > ? AND undone_at IS NULL').run(undoneAt, highWaterMark);
      return { change: { ...change, undoneAt }, items };
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
    const stack = this.get(itemId)?.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention';
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
    const stack = this.get(id)?.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention';
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

  getPendingProposal(): QueueProposal | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1").get() as Record<string, string | null> | undefined;
    return row ? this.mapProposal(row) : null;
  }

  createProposal(orderedItemIds: string[], rationale: string, explanations: QueueItemExplanation[] = []): QueueProposal {
    const previousOrder = this.list().map((item) => item.id);
    if (previousOrder.length !== orderedItemIds.length || !previousOrder.every((id) => orderedItemIds.includes(id))) {
      throw new Error('Proposal must contain every active queued item exactly once.');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending'").run(now);
    this.database.prepare(`
      INSERT INTO queue_proposals (id, status, previous_order_json, proposed_order_json, rationale, explanations_json, created_at)
      VALUES (?, 'pending', ?, ?, ?, ?, ?)
    `).run(id, JSON.stringify(previousOrder), JSON.stringify(orderedItemIds), rationale, JSON.stringify(explanations), now);
    this.reorder(orderedItemIds, undefined, { actor: 'agent', reason: 'Applied a daily stack proposal.' });
    return this.getPendingProposal()!;
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

    return { now, openChildren, activeRuns, unresolvedBlockers, sourceChanges, feedback: this.getQueueFeedbackWeights() };
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

  buildDailyProposal(now = Date.now()): QueueProposal {
    const items = this.list();
    if (!items.length) throw new Error('Add at least one task before planning the stack.');
    const plan = planQueue(items, this.buildQueueContext(now));
    return this.createProposal(plan.orderedItemIds, plan.rationale, plan.explanations);
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

  resolveExecutionPlan(id: string, resolution: 'accepted' | 'rejected', selectedTaskIndexes?: number[]): ExecutionPlan | null {
    const row = this.database.prepare("SELECT work_item_id FROM execution_plans WHERE id = ? AND status = 'pending'").get(id) as { work_item_id: string } | undefined;
    if (!row) return null;
    const plan = this.getPendingExecutionPlan(row.work_item_id);
    if (!plan) return null;
    if (resolution === 'accepted') {
      const parent = this.get(plan.workItemId)!;
      const selectedTasks = selectedTaskIndexes === undefined ? plan.tasks : plan.tasks.filter((_, index) => selectedTaskIndexes.includes(index));
      if (!selectedTasks.length) return null;
      const children = selectedTasks.map((task) => this.create({
        title: task.title, description: task.description, priority: 2, status: 'ready',
        projectName: parent.projectName, workspacePath: task.workspacePath ?? parent.workspacePath, dueDate: null,
        parentWorkItemId: parent.id,
      }));
      const stack = parent.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention';
      const current = stack === 'workbench' ? this.listWorkbench() : this.list();
      const childIds = children.map((item) => item.id);
      const ordered = current.flatMap((item) => item.id === parent.id ? [item.id, ...childIds] : childIds.includes(item.id) ? [] : [item.id]);
      this.reorder(ordered, stack);
      this.addActivity(parent.id, 'system', 'decomposed', `Approved plan created ${selectedTasks.length} of ${plan.tasks.length} proposed tasks.`);
      // The parent is now a historical decomposition record, not executable work.
      // Archive it incomplete so it remains discoverable and distinct from a
      // completed implementation; the selected children are the actionable work.
      this.archive(parent.id, false);
    }
    const resolvedAt = new Date().toISOString();
    this.database.prepare('UPDATE execution_plans SET status = ?, resolved_at = ? WHERE id = ?').run(resolution, resolvedAt, id);
    return { ...plan, status: resolution, resolvedAt };
  }

  resolveProposal(id: string, resolution: 'accepted' | 'rejected'): QueueProposal | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE id = ? AND status = 'pending'").get(id) as Record<string, string | null> | undefined;
    if (!row) return null;
    const proposal = this.mapProposal(row);
    if (resolution === 'rejected') this.reorder(proposal.previousOrder, undefined, { actor: 'jeffrey', reason: 'Rejected the daily stack proposal.' });
    const resolvedAt = new Date().toISOString();
    this.database.prepare('UPDATE queue_proposals SET status = ?, resolved_at = ? WHERE id = ?').run(resolution, resolvedAt, id);
    return { ...proposal, status: resolution, resolvedAt };
  }

  private mapProposal(row: Record<string, string | null>): QueueProposal {
    return {
      id: row.id!, status: row.status as QueueProposal['status'],
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
    workspacePath: string | null;
    dueDate: string | null;
    sourceUrl?: string | null;
    parentWorkItemId?: string | null;
  }): WorkItem {
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
          project_name, workspace_path, due_date, source_url, parent_work_item_id, created_at, updated_at, last_touched_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.title,
        input.description,
        input.status,
        input.priority,
        position,
        input.projectName,
        input.workspacePath,
        input.dueDate,
        input.sourceUrl ?? null,
        input.parentWorkItemId ?? null,
        now,
        now,
        now,
      );

    this.addActivity(id, 'system', 'created', 'Manual work item created.');
    const stack = input.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention';
    const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
    this.reorder([id, ...stackItems.map((item) => item.id).filter((itemId) => itemId !== id)], stack);
    return this.get(id)!;
  }

  createFollowUp(parentId: string, title: string, description: string): WorkItem | null {
    const parent = this.get(parentId);
    if (!parent) return null;
    const followUp = this.create({
      title, description, priority: 2, status: 'ready', projectName: parent.projectName,
      workspacePath: parent.workspacePath, dueDate: null, sourceUrl: null, parentWorkItemId: parent.id,
    });
    const stack = parent.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention';
    const activeIds = (stack === 'workbench' ? this.listWorkbench() : this.list()).map((item) => item.id);
    const withoutFollowUp = activeIds.filter((id) => id !== followUp.id);
    const parentIndex = withoutFollowUp.indexOf(parentId);
    withoutFollowUp.splice(parentIndex >= 0 ? parentIndex + 1 : 0, 0, followUp.id);
    this.reorder(withoutFollowUp, stack);
    this.addActivity(parentId, 'jeffrey', 'follow_up', `Created follow-up task: ${title}`);
    this.addActivity(followUp.id, 'system', 'follow_up', `Created as a follow-up to: ${parent.title}`);
    return this.get(followUp.id);
  }

  archive(id: string, completed: boolean): WorkItem | null {
    const item = this.get(id);
    if (!item) return null;
    const now = new Date().toISOString();
    const runs = this.listRuns(id).filter((run) => run.status === 'completed' && run.output);
    const memory = [
      `Archived task (${completed ? 'completed' : 'incomplete'}): ${item.title}`,
      `Description: ${item.description || 'none'}`,
      `Strategy: ${item.strategy || 'none'}`,
      runs.length ? `Agent outcomes:\n${runs.map((run) => `${run.agent}/${run.kind}: ${run.output}`).join('\n\n')}` : 'Agent outcomes: none',
    ].join('\n');
    const conversationRows = this.database.prepare(`SELECT id FROM shared_conversations WHERE work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL)`).all(id, id) as Array<{ id: string }>;
    const conversationMemories = conversationRows.flatMap(({ id: conversationId }) => { const body = this.buildConversationMemory(conversationId); return body ? [{ id: conversationId, body }] : []; });
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE work_items SET archived_at = ?, completed_at = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(now, completed ? now : null, completed ? 'done' : item.status, now, id);
      this.database.prepare("INSERT INTO shared_memories (id, kind, body, created_at) VALUES (?, 'task_archive', ?, ?)")
        .run(randomUUID(), memory, now);
      for (const conversationMemory of conversationMemories) this.database.prepare("INSERT INTO shared_memories (id, kind, body, created_at) VALUES (?, 'conversation_archive', ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at")
        .run(`conversation:${conversationMemory.id}`, conversationMemory.body, now);
      this.database.prepare(`UPDATE shared_conversations SET archived_at = ?, updated_at = ?
        WHERE archived_at IS NULL AND (work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL))`).run(now, now, id, id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  restore(id: string): WorkItem | null {
    const item = this.get(id);
    if (!item) return null;
    if (!item.archivedAt) return item;
    const now = new Date().toISOString();
    const status = item.status === 'done' || item.status === 'canceled' ? 'ready' : item.status;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE work_items SET archived_at = NULL, completed_at = NULL, status = ?, is_queued = 1, updated_at = ? WHERE id = ?')
        .run(status, now, id);
      this.database.prepare(`UPDATE shared_conversations SET archived_at = NULL, updated_at = ?
        WHERE work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL)`).run(now, id, id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    const stack = item.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention';
    const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
    this.reorder([id, ...stackItems.map((entry) => entry.id).filter((entryId) => entryId !== id)], stack);
    this.addActivity(id, 'system', 'restored', 'Restored from the archive.');
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.database.prepare('DELETE FROM work_items WHERE id = ?').run(id).changes) > 0;
  }

  update(id: string, changes: Partial<Pick<WorkItem, 'title' | 'description' | 'priority' | 'status' | 'projectName' | 'workspacePath' | 'dueDate' | 'strategy' | 'assignees' | 'queuePosition'>>): WorkItem | null {
    if (!this.get(id)) return null;
    const columns = new Map<string, string | number | null | undefined>([
      ['title', changes.title],
      ['description', changes.description],
      ['priority', changes.priority],
      ['status', changes.status],
      ['project_name', changes.projectName],
      ['workspace_path', changes.workspacePath],
      ['due_date', changes.dueDate],
      ['strategy', changes.strategy],
      ['assignees_json', changes.assignees ? JSON.stringify(changes.assignees) : undefined],
      ['queue_position', changes.queuePosition],
    ]);
    const entries = [...columns].filter(
      (entry): entry is [string, string | number | null] => entry[1] !== undefined,
    );
    if (entries.length === 0) return this.get(id);

    const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    const assignmentMode = changes.assignees ? ", agent_assignment_mode = 'manual'" : '';
    const now = new Date().toISOString();
    this.database
      .prepare(`UPDATE work_items SET ${assignments}${assignmentMode}, updated_at = ?, last_touched_at = ? WHERE id = ?`)
      .run(...values, now, now, id);
    if (changes.title !== undefined || changes.description !== undefined) {
      this.database.prepare("DELETE FROM work_item_classifications WHERE work_item_id = ? AND source != 'manual'").run(id);
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
    const assignees = [...item.assignees.filter((assignee) => assignee === 'jeffrey'), ...agents];
    this.database.prepare("UPDATE work_items SET assignees_json = ?, agent_assignment_mode = 'auto', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(assignees), new Date().toISOString(), id);
    return this.get(id);
  }

  listActivity(workItemId: string): Activity[] {
    const rows = this.database
      .prepare('SELECT * FROM activities WHERE work_item_id = ? ORDER BY created_at DESC')
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
          requestedTarget: row.requested_target as AgentRun['requestedTarget'], agent: row.agent as AgentRun['agent'],
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
      INSERT INTO agent_runs (id, work_item_id, kind, requested_target, agent, status, instructions, created_at, conversation_id, message_id)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(id, workItemId, kind, requestedTarget, agent, instructions, createdAt, conversationId, messageId);
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

  updateRun(id: string, changes: { agent?: AgentRun['agent']; status?: AgentRun['status']; output?: string; error?: string; startedAt?: string; completedAt?: string; model?: string; executionProfile?: NonNullable<AgentRun['executionProfile']>; inputTokens?: number | null; outputTokens?: number | null; estimatedCostUsd?: number | null; fallbackFrom?: AgentRun['agent'] | null; fallbackReason?: string | null }): void {
    const columns = new Map<string, string | number | null | undefined>([
      ['agent', changes.agent], ['status', changes.status], ['output', changes.output], ['error', changes.error], ['model', changes.model], ['execution_profile', changes.executionProfile],
      ['input_tokens', changes.inputTokens], ['output_tokens', changes.outputTokens], ['estimated_cost_usd', changes.estimatedCostUsd], ['fallback_from', changes.fallbackFrom], ['fallback_reason', changes.fallbackReason],
      ['started_at', changes.startedAt], ['completed_at', changes.completedAt],
    ]);
    const entries = [...columns].filter((entry): entry is [string, string | number | null] => entry[1] !== undefined);
    if (!entries.length) return;
    this.database.prepare(`UPDATE agent_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  upsertLinearItem(input: ProviderWorkItem): 'imported' | 'updated' | 'skipped' {
    const existing = this.database
      .prepare("SELECT * FROM work_items WHERE source = 'linear' AND source_identifier = ?")
      .get(input.sourceIdentifier) as WorkItemRow | undefined;

    if (existing?.provider_updated_at === input.providerUpdatedAt) return 'skipped';
    const now = new Date().toISOString();

    if (existing) {
      // Provider sync deliberately does not touch local priority, queue order, strategy, or assignees.
      this.database
        .prepare(`
          UPDATE work_items SET
            title = ?, description = ?, status = ?, source_url = ?, project_name = ?,
            labels_json = ?, due_date = ?, provider_payload_json = ?,
            provider_updated_at = ?, updated_at = ?, last_touched_at = ?
          WHERE id = ?
        `)
        .run(
          input.title,
          input.description,
          input.status,
          input.sourceUrl,
          input.projectName,
          JSON.stringify(input.labels),
          input.dueDate,
          JSON.stringify(input.providerPayload),
          input.providerUpdatedAt,
          now,
          now,
          existing.id,
        );
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
    return 'imported';
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
  // relationship kind with no existing storage is an arbitrary external
  // reference (a second Linear issue beyond the sync source, a pull request,
  // a Slack thread, a document), which is what work_item_references adds.

  listChildren(workItemId: string): WorkItem[] {
    const rows = this.database.prepare('SELECT * FROM work_items WHERE parent_work_item_id = ? ORDER BY created_at ASC').all(workItemId) as unknown as WorkItemRow[];
    return rows.map((row) => this.withAgentOutcome(mapWorkItem(row)));
  }

  listConversationsForWorkItem(workItemId: string): SharedConversation[] {
    const rows = this.database.prepare(`
      SELECT shared_conversations.*,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.status = 'running') AS is_active
      FROM shared_conversations
      WHERE work_item_id = ? OR id IN (SELECT conversation_id FROM agent_runs WHERE work_item_id = ? AND conversation_id IS NOT NULL)
      ORDER BY created_at ASC
    `).all(workItemId, workItemId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id), title: String(row.title), workItemId: row.work_item_id ? String(row.work_item_id) : null,
      forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
    }));
  }

  // The artifact library owns artifact reads; the task graph just asks it for the
  // live shares belonging to this task.
  listArtifactsForWorkItem(workItemId: string): ArtifactSummary[] {
    return new ArtifactLibrary(this.database).listForWorkItem(workItemId).filter((artifact) => !artifact.revokedAt);
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
      WHERE id = ? AND status = 'queued' AND (owner_id IS NULL OR lease_expires_at < ?)
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
    return Number(changed) > 0;
  }

  renewLeases(ownerId: string, leaseMs: number): void {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    this.database.prepare(`UPDATE agent_runs SET lease_expires_at = ? WHERE owner_id = ? AND status = 'running' AND lease_expires_at >= ?`).run(leaseExpiresAt, ownerId, now);
    this.database.prepare(`UPDATE shared_messages SET lease_expires_at = ? WHERE owner_id = ? AND status = 'running' AND lease_expires_at >= ?`).run(leaseExpiresAt, ownerId, now);
  }

  /** Schedule a bounded retry for a run that failed transiently. Returns false when attempts are exhausted. */
  scheduleRunRetry(id: string, delayMs: number): boolean {
    const row = this.database.prepare('SELECT attempt, max_attempts FROM agent_runs WHERE id = ?').get(id) as { attempt: number; max_attempts: number } | undefined;
    if (!row || row.attempt + 1 >= row.max_attempts) return false;
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    this.database.prepare(`
      UPDATE agent_runs SET status = 'queued', owner_id = NULL, lease_expires_at = NULL, attempt = attempt + 1, next_attempt_at = ?
      WHERE id = ?
    `).run(nextAttemptAt, id);
    return true;
  }

  /**
   * Reclaim work whose lease expired without the owner finishing it (crash or restart).
   * `execute` runs perform non-idempotent filesystem edits, so they are never silently
   * re-run: they are marked failed for Jeffrey to re-trigger deliberately.
   */
  reclaimExpired(): { recoveredRunIds: string[]; failedRunIds: string[]; recoveredMessageIds: string[] } {
    const now = new Date().toISOString();
    const expiredRuns = this.database.prepare(`SELECT id, kind FROM agent_runs WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`).all(now) as Array<{ id: string; kind: AgentRun['kind'] }>;
    const recoveredRunIds: string[] = [];
    const failedRunIds: string[] = [];
    for (const run of expiredRuns) {
      if (run.kind === 'execute') {
        this.updateRun(run.id, { status: 'failed', error: 'Interrupted by API restart.', completedAt: now });
        this.database.prepare('UPDATE agent_runs SET owner_id = NULL, lease_expires_at = NULL WHERE id = ?').run(run.id);
        failedRunIds.push(run.id);
      } else if (this.scheduleRunRetry(run.id, 0)) {
        recoveredRunIds.push(run.id);
      } else {
        this.updateRun(run.id, { status: 'failed', error: 'Retry attempts exhausted after interruption.', completedAt: now });
        this.database.prepare('UPDATE agent_runs SET owner_id = NULL, lease_expires_at = NULL WHERE id = ?').run(run.id);
        failedRunIds.push(run.id);
      }
    }
    // Shared messages with expired leases are interrupted (not retried). If there's
    // an associated agent run, that run will be recovered separately. When the run
    // completes, it will update the message to its final status (completed/failed).
    const expiredMessages = this.database.prepare(`SELECT id FROM shared_messages WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`).all(now) as Array<{ id: string }>;
    const recoveredMessageIds: string[] = [];
    for (const message of expiredMessages) {
      this.database.prepare(`UPDATE shared_messages SET status = 'failed', error = 'Interrupted by API restart.', owner_id = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ?`).run(now, message.id);
      recoveredMessageIds.push(message.id);
    }
    return { recoveredRunIds, failedRunIds, recoveredMessageIds };
  }

  /** Runs that are queued and due (no scheduled delay, or the delay has elapsed). */
  dueWork(): { runIds: string[] } {
    const now = new Date().toISOString();
    const rows = this.database.prepare(`SELECT id FROM agent_runs WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC`).all(now) as Array<{ id: string }>;
    return { runIds: rows.map((row) => row.id) };
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
}
