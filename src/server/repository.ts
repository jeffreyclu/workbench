import { randomUUID } from 'node:crypto';
import type { Activity, AgentRun, Assignee, ConversationPage, DiscoveryCandidate, DiscoveryCandidateStatus, DiscoveryInbox, DiscoveryRun, ExecutionPlan, LinearProviderConfig, PlannedTask, QueueProposal, SharedAttachment, SharedConversation, SharedMessage, SourceConnection, SourceProvider, WorkItem, WorkItemPage } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';

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
    this.database.prepare('UPDATE discovery_candidates SET status = ?, work_item_id = ?, snoozed_until = ?, updated_at = ? WHERE id = ?').run(status, linkedId, snoozedUntil, now, id);
    return this.mapDiscoveryCandidate(this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ?').get(id) as Record<string, string | null>);
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
    const messages = this.listSharedMessages(1_000, id).filter((message) => message.status === 'completed' && message.body.trim()).slice(-8);
    if (!messages.length) return null;
    return [`Archived conversation: ${conversation.title}`, ...messages.map((message) => `${message.author}: ${message.body.trim().slice(0, 1_500)}`)].join('\n\n').slice(0, 12_000);
  }

  forkConversation(id: string): SharedConversation | null {
    const source = this.listConversations('all').find((conversation) => conversation.id === id);
    if (!source) return null;
    const fork = this.createConversation(`${source.title} · fork`, source.workItemId);
    this.database.prepare('UPDATE shared_conversations SET forked_from_conversation_id = ? WHERE id = ?').run(source.id, fork.id);
    const messages = this.listSharedMessages(1_000, source.id);
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
    return rows.map((row) => ({ provider: row.provider as SourceProvider, connected: true, label: row.label!, lastScannedAt: row.last_scanned_at, lastError: row.last_error }));
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

  removeSourceConnection(provider: SourceProvider): void {
    this.database.prepare('DELETE FROM source_connections WHERE provider = ?').run(provider);
  }

  listSharedMessages(limit = 100, conversationId?: string): SharedMessage[] {
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM shared_messages WHERE (? IS NULL OR conversation_id = ?) ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at ASC
    `).all(conversationId ?? null, conversationId ?? null, limit) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id), conversationId: String(row.conversation_id ?? ''), author: row.author as SharedMessage['author'], body: String(row.body),
      pinned: row.pinned === 1, status: row.status as SharedMessage['status'], error: String(row.error),
      createdAt: String(row.created_at), attachments: JSON.parse(String(row.attachments_json ?? '[]')) as SharedAttachment[],
      model: row.model ? String(row.model) : null,
      executionProfile: row.execution_profile as SharedMessage['executionProfile'] ?? null,
    }));
  }

  createSharedMessage(author: SharedMessage['author'], body: string, status: SharedMessage['status'] = 'completed', conversationId?: string, attachments: SharedAttachment[] = [], dispatchTarget = 'none'): SharedMessage {
    const conversation = conversationId ? this.listConversations('all').find((item) => item.id === conversationId) : this.ensureDefaultConversation();
    if (!conversation) throw new Error('Conversation not found.');
    const message: SharedMessage = {
      id: randomUUID(), conversationId: conversation.id, author, body, pinned: false, status, error: '', createdAt: new Date().toISOString(), attachments, model: null, executionProfile: null,
    };
    this.database.prepare(`
      INSERT INTO shared_messages (id, conversation_id, author, body, pinned, status, error, attachments_json, dispatch_target, created_at)
      VALUES (?, ?, ?, ?, 0, ?, '', ?, ?, ?)
    `).run(message.id, message.conversationId, author, body, status, JSON.stringify(attachments), dispatchTarget, message.createdAt);
    this.database.prepare('UPDATE shared_conversations SET updated_at = ?, title = CASE WHEN title = ? AND ? = ? THEN substr(?, 1, 80) ELSE title END WHERE id = ?')
      .run(message.createdAt, 'New conversation', author, 'jeffrey', body, message.conversationId);
    return message;
  }

  nextQueuedSharedTurn(conversationId: string): { message: SharedMessage; dispatchTarget: 'auto' | 'codex' | 'claude' | 'both' } | null {
    const row = this.database.prepare(`SELECT id, dispatch_target FROM shared_messages
      WHERE conversation_id = ? AND author = 'jeffrey' AND status = 'queued'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(conversationId) as { id: string; dispatch_target: string } | undefined;
    if (!row || !['auto', 'codex', 'claude', 'both'].includes(row.dispatch_target)) return null;
    const message = this.listSharedMessages(1_000, conversationId).find((entry) => entry.id === row.id);
    return message ? { message, dispatchTarget: row.dispatch_target as 'auto' | 'codex' | 'claude' | 'both' } : null;
  }

  updateSharedMessage(id: string, changes: { pinned?: boolean; body?: string; status?: SharedMessage['status']; error?: string; author?: SharedMessage['author']; model?: string; executionProfile?: SharedMessage['executionProfile'] }): SharedMessage | null {
    const entries = Object.entries({
      pinned: changes.pinned === undefined ? undefined : Number(changes.pinned),
      body: changes.body, status: changes.status, error: changes.error, author: changes.author, model: changes.model, execution_profile: changes.executionProfile,
    }).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
    if (entries.length) this.database.prepare(`UPDATE shared_messages SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    return this.listSharedMessages(1_000).find((message) => message.id === id) ?? null;
  }

  getSharedContext(excludeConversationId?: string): string {
    const messages = this.listSharedMessages(120).filter((message) => message.conversationId !== excludeConversationId);
    const archived = this.database.prepare("SELECT body FROM shared_memories WHERE kind IN ('task_archive', 'conversation_archive') ORDER BY created_at DESC LIMIT 20").all() as Array<{ body: string }>;
    const recent = messages.filter((message) => message.status === 'completed' && message.body).slice(-8);
    const format = (message: SharedMessage) => `${message.author}: ${message.body.slice(0, 2_000)}`;
    return [
      'Durable context from archived work:', archived.length ? archived.map(({ body }) => `archive: ${body.slice(0, 2_000)}`).join('\n') : 'No archived context yet.',
      '', 'Recent shared room:', recent.length ? recent.map(format).join('\n') : 'No recent conversation.',
    ].join('\n');
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
    item = { ...item, sourceTags: [...new Set([...item.sourceTags.filter((tag) => tag !== 'Manual' || normalizedProviders.length === 0), ...normalizedProviders])] };
    const latest = this.database.prepare(`SELECT created_at FROM agent_runs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(item.id) as { created_at: string } | undefined;
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

  reorder(orderedItemIds: string[], stack?: 'attention' | 'workbench'): WorkItem[] {
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
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return inferredStack === 'workbench' ? this.listWorkbench() : this.list();
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
    return this.reorder(ids, stack);
  }

  moveForAttention(id: string, destination: 'top' | 'bottom', reason: string): WorkItem[] {
    const stack = this.get(id)?.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'attention';
    const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
    const ids = stackItems.map((item) => item.id);
    if (!ids.includes(id) || ids.length < 2) return stackItems;
    const now = new Date().toISOString();
    this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending'").run(now);
    const without = ids.filter((itemId) => itemId !== id);
    this.reorder(destination === 'top' ? [id, ...without] : [...without, id], stack);
    this.addActivity(id, 'system', 'queue_moved', `${destination === 'top' ? 'Promoted for attention' : 'Demoted while the agent works'}: ${reason}`);
    return stack === 'workbench' ? this.listWorkbench() : this.list();
  }

  getPendingProposal(): QueueProposal | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1").get() as Record<string, string | null> | undefined;
    return row ? this.mapProposal(row) : null;
  }

  createProposal(orderedItemIds: string[], rationale: string): QueueProposal {
    const previousOrder = this.list().map((item) => item.id);
    if (previousOrder.length !== orderedItemIds.length || !previousOrder.every((id) => orderedItemIds.includes(id))) {
      throw new Error('Proposal must contain every active queued item exactly once.');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.prepare("UPDATE queue_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending'").run(now);
    this.database.prepare(`
      INSERT INTO queue_proposals (id, status, previous_order_json, proposed_order_json, rationale, created_at)
      VALUES (?, 'pending', ?, ?, ?, ?)
    `).run(id, JSON.stringify(previousOrder), JSON.stringify(orderedItemIds), rationale, now);
    this.reorder(orderedItemIds);
    return this.getPendingProposal()!;
  }

  buildDailyProposal(): QueueProposal {
    const items = this.list();
    if (!items.length) throw new Error('Add at least one task before planning the stack.');
    const now = Date.now();
    const urgency = (item: WorkItem) => {
      let score = 0;
      if (item.status === 'in_progress') score += 4;
      if (item.status === 'blocked') score -= 2;
      const untouchedDays = Math.max(0, (now - new Date(item.lastTouchedAt).getTime()) / 86_400_000);
      if (untouchedDays >= 3) score += Math.min(6, Math.floor(untouchedDays / 3) * 2);
      if (item.dueDate) {
        const days = (new Date(item.dueDate).getTime() - now) / 86_400_000;
        if (days < 0) score += 10;
        else if (days <= 1) score += 8;
        else if (days <= 3) score += 5;
      }
      return score;
    };
    const ranked = items
      .map((item, index) => ({ item, index, score: urgency(item), untouchedDays: Math.floor(Math.max(0, (now - new Date(item.lastTouchedAt).getTime()) / 86_400_000)) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const moved = ranked.filter((entry, index) => entry.index !== index && entry.score !== 0);
    const rationale = moved.length
      ? moved.map(({ item, score, untouchedDays }) => `${item.title}: ${untouchedDays >= 3 ? `promoted after ${untouchedDays} days without activity` : score > 0 ? 'promoted for active/due context' : 'moved behind actionable work because it is blocked'}.`).join(' ')
      : 'No meaningful new task context justified changing yesterday’s order.';
    return this.createProposal(ranked.map(({ item }) => item.id), rationale);
  }

  getPendingExecutionPlan(workItemId: string): ExecutionPlan | null {
    const row = this.database.prepare("SELECT * FROM execution_plans WHERE work_item_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(workItemId) as Record<string, string | null> | undefined;
    return row ? {
      id: row.id!, workItemId: row.work_item_id!, status: row.status as ExecutionPlan['status'],
      summary: row.summary!, tasks: JSON.parse(row.tasks_json!) as PlannedTask[],
      createdAt: row.created_at!, resolvedAt: row.resolved_at,
    } : null;
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
      this.update(parent.id, { status: 'done' });
      this.addActivity(parent.id, 'system', 'decomposed', `Approved plan created ${selectedTasks.length} of ${plan.tasks.length} proposed tasks.`);
    }
    const resolvedAt = new Date().toISOString();
    this.database.prepare('UPDATE execution_plans SET status = ?, resolved_at = ? WHERE id = ?').run(resolution, resolvedAt, id);
    return { ...plan, status: resolution, resolvedAt };
  }

  resolveProposal(id: string, resolution: 'accepted' | 'rejected'): QueueProposal | null {
    const row = this.database.prepare("SELECT * FROM queue_proposals WHERE id = ? AND status = 'pending'").get(id) as Record<string, string | null> | undefined;
    if (!row) return null;
    const proposal = this.mapProposal(row);
    if (resolution === 'rejected') this.reorder(proposal.previousOrder);
    const resolvedAt = new Date().toISOString();
    this.database.prepare('UPDATE queue_proposals SET status = ?, resolved_at = ? WHERE id = ?').run(resolution, resolvedAt, id);
    return { ...proposal, status: resolution, resolvedAt };
  }

  private mapProposal(row: Record<string, string | null>): QueueProposal {
    return {
      id: row.id!, status: row.status as QueueProposal['status'],
      previousOrder: JSON.parse(row.previous_order_json!) as string[],
      proposedOrder: JSON.parse(row.proposed_order_json!) as string[], rationale: row.rationale!,
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
    return this.get(id);
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
        };
      });
  }

  getRun(id: string): AgentRun | null {
    const row = this.database.prepare('SELECT work_item_id FROM agent_runs WHERE id = ?').get(id) as { work_item_id: string } | undefined;
    return row ? this.listRuns(row.work_item_id).find((run) => run.id === id) ?? null : null;
  }

  getRunByMessage(messageId: string): AgentRun | null {
    const row = this.database.prepare('SELECT id FROM agent_runs WHERE message_id = ? ORDER BY created_at DESC LIMIT 1').get(messageId) as { id: string } | undefined;
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
      SELECT agent, COUNT(*) AS load
      FROM (
        SELECT agent
        FROM agent_runs
        WHERE requested_target = 'auto'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 20
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

  updateRun(id: string, changes: { agent?: AgentRun['agent']; status?: AgentRun['status']; output?: string; error?: string; startedAt?: string; completedAt?: string; model?: string; executionProfile?: NonNullable<AgentRun['executionProfile']> }): void {
    const columns = new Map<string, string | undefined>([
      ['agent', changes.agent], ['status', changes.status], ['output', changes.output], ['error', changes.error], ['model', changes.model], ['execution_profile', changes.executionProfile],
      ['started_at', changes.startedAt], ['completed_at', changes.completedAt],
    ]);
    const entries = [...columns].filter((entry): entry is [string, string] => entry[1] !== undefined);
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
}
