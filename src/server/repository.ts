import { randomUUID } from 'node:crypto';

import { DEFAULT_ACCOUNT_PROFILE, isSelfAssigned, workItemFilterSchema, VERSION_CONFLICT_CODE, VERSION_CONFLICT_MESSAGE, type Activity, type ProjectSummary, type AgentRun, type AgentRunReviewHandoff, type AgentStreamEvent, type ArtifactSummary, type Assignee, type AuditLogEntry, type AuditLogPage, type BulkWorkItemAction, type BulkWorkItemResult, type ConversationPage, type DiagnosticEvent, type DiscoveryCandidate, type DiscoveryInbox, type DiscoveryRun, type ExecutionPlan, type InsightsTimeframe, type LinearProviderConfig, type PlannedTask, type ProviderSyncConflict, type ProviderSyncConflictResolution, type ProviderSyncField, type QueueItemExplanation, type QueueOrderChange, type QueueProposal, type QueueSignalKey, type RunInsights, type SavedWorkItemFilter, type SavedWorkItemFilterView, type SessionFeedback, type SessionFeedbackRating, type SharedAttachment, type SharedConversation, type SharedMessage, type SharedMessagePage, type SharedSearchResult, type SourceConnection, type SourceProvider, type TaskClassification, type WorkItem, type WorkItemDependency, type WorkItemFilter, type WorkItemLineage, type WorkItemPage, type WorkItemReference, type WorkItemReferenceType, type WorkspaceDiff, type WorkspaceDiffSnapshot, type DiffHunkReview, type DiffHunkReviewState, type UpsertDiffHunkReviewsInput } from '../shared/contracts.js';
import type { FeedbackWeight, QueueContext, QueuePlan } from './queue-intelligence.js';
import { listProjects, resolveProjectName } from './project-registry.js';
import type { WorkbenchDatabase } from './database.js';
import { ArtifactLibrary } from './artifact-library.js';
import { DEFAULT_WORKBENCH_TIMEZONE } from '../shared/due-date.js';
import { describeLifecycleChange, summarizeWorkItemChanges } from './activity-log.js';
import { PROMOTION_QUEUED_MESSAGE } from './promotion-messages.js';
import { collectMemoryDocuments, indexPendingMemory, searchMemory } from './memory-index.js';
import { buildFtsMatchQuery } from './fts-query.js';
import { UnitOfWork } from './unit-of-work.js';
import { TelemetryRepository } from './repositories/telemetry-repository.js';
import { SourceConnectionRepository } from './repositories/source-connection-repository.js';
import { DiscoveryRepository } from './repositories/discovery-repository.js';
import { ConversationRepository } from './repositories/conversation-repository.js';
import { RunRepository, type RunPatch } from './repositories/run-repository.js';
import { QueueRepository } from './repositories/queue-repository.js';
import { WorkItemRepository as WorkItemTableRepository, mapWorkItemRow, type WorkItemRow } from './repositories/work-item-repository.js';
import { recordLifecycleEvent as recordLifecycleEventRow } from './lifecycle-events.js';
import { ProviderSyncService, type ProviderWorkItem } from './services/provider-sync-service.js';
import { QueuePlanningService } from './services/queue-planning-service.js';
import { ExecutionService } from './services/execution-service.js';
import { WorkItemService } from './services/work-item-service.js';
import { ConversationService } from './services/conversation-service.js';
import { normalizeLabels, providerSyncFields, providerValues, sameProviderValue, type ProviderFieldValue, type ProviderSnapshotRow, type ProviderSnapshotValues } from './repositories/provider-sync-support.js';

export type { ProviderWorkItem } from './services/provider-sync-service.js';

/** Who applied a lifecycle move, and what forced it when Workbench applied it as a cascade. */
export interface LifecycleContext { actor?: Activity['actor']; reason?: string }
export interface StatusTransitionContext extends LifecycleContext { source?: string }

interface ActivityRow {
  id: string;
  work_item_id: string;
  actor: Activity['actor'];
  kind: string;
  body: string;
  created_at: string;
}

interface SavedWorkItemFilterRow {
  id: string; name: string; view: SavedWorkItemFilterView; filter_json: string;
  sort_order: number; created_at: string; updated_at: string;
}

interface WorkspaceDiffSnapshotRow {
  id: string;
  revision: string;
  diff_json: string;
  captured_at: string;
  originating_agent_run_id: string | null;
  commit_hash: string | null;
}

function mapWorkspaceDiffSnapshot(row: WorkspaceDiffSnapshotRow): WorkspaceDiffSnapshot {
  return { id: row.id, revision: row.revision, diff: JSON.parse(row.diff_json) as WorkspaceDiff, capturedAt: row.captured_at, originatingAgentRunId: row.originating_agent_run_id, commitHash: row.commit_hash };
}

interface DiffHunkReviewRow {
  id: string;
  revision: string;
  file_path: string;
  hunk_range: string;
  hunk_fingerprint: string | null;
  state: DiffHunkReviewState;
  note: string | null;
  updated_at: string;
}

/** How far back a scope's review history is scanned for decisions to carry
 * into the current revision. Reviews are recorded per hunk per revision, so a
 * long session accumulates rows quickly; the newest rows are the ones whose
 * code is still present, and the cap keeps the read bounded. */
const CARRIED_REVIEW_SCAN_LIMIT = 2000;

function mapDiffHunkReview(row: DiffHunkReviewRow): DiffHunkReview {
  return { id: row.id, revision: row.revision, filePath: row.file_path, hunkRange: row.hunk_range, fingerprint: row.hunk_fingerprint ?? null, state: row.state, note: row.note, updatedAt: row.updated_at };
}

function mapSavedWorkItemFilter(row: SavedWorkItemFilterRow): SavedWorkItemFilter {
  return { id: row.id, name: row.name, view: row.view, filter: workItemFilterSchema.parse(JSON.parse(row.filter_json)), sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * `/api/activity-memory` predates the three-way run split
 * (run_instructions/run_output/run_error) that lets a prompt be retrieved
 * independently of its response; collapse them back to the legacy 'run'
 * label so the response shape agents already parse does not change.
 */
function legacyMemorySource(source: string): string {
  if (source === 'run_instructions' || source === 'run_output' || source === 'run_error') return 'run';
  return source;
}

export class WorkItemDependencyError extends Error {
  readonly code = 'INVALID_DEPENDENCIES';
}

/**
 * Thrown when a caller's `expectedVersion` no longer matches the row. Carries
 * the current server-side item so the caller can decide whether to retry
 * with fresh data instead of clobbering the concurrent write.
 */
export class WorkItemVersionConflictError extends Error {
  readonly code = VERSION_CONFLICT_CODE;
  constructor(readonly item: WorkItem) {
    super(VERSION_CONFLICT_MESSAGE);
  }
}

export class WorkItemRepository {
  private readonly unitOfWork: UnitOfWork;
  private readonly telemetry: TelemetryRepository;
  private readonly sourceConnections: SourceConnectionRepository;
  private readonly discovery: DiscoveryRepository;
  private readonly conversations: ConversationRepository;
  private readonly runs: RunRepository;
  private readonly queue: QueueRepository;
  private readonly workItems: WorkItemTableRepository;
  private readonly providerSync: ProviderSyncService;
  private readonly queuePlanning: QueuePlanningService;
  private readonly execution: ExecutionService;
  private readonly workItemLifecycle: WorkItemService;
  private readonly conversationService: ConversationService;

  constructor(readonly database: WorkbenchDatabase, private readonly timeZone = process.env.WORKBENCH_TIMEZONE ?? DEFAULT_WORKBENCH_TIMEZONE) {
    this.unitOfWork = new UnitOfWork(database);
    this.telemetry = new TelemetryRepository(this.unitOfWork);
    this.sourceConnections = new SourceConnectionRepository(this.unitOfWork);
    this.discovery = new DiscoveryRepository(this.unitOfWork);
    this.conversations = new ConversationRepository(this.unitOfWork);
    this.queue = new QueueRepository(this.unitOfWork);
    this.runs = new RunRepository(this.unitOfWork);
    this.workItems = new WorkItemTableRepository(this.unitOfWork);
    this.providerSync = new ProviderSyncService(database, this.unitOfWork, {
      get: (id) => this.get(id),
      addActivity: (workItemId, actor, kind, body) => this.addActivity(workItemId, actor, kind, body),
    });
    this.queuePlanning = new QueuePlanningService(database, this.unitOfWork, this.queue, this.workItems, {
      list: () => this.list(),
      listWorkbench: () => this.listWorkbench(),
      addActivity: (workItemId, actor, kind, body) => this.addActivity(workItemId, actor, kind, body),
    }, this.timeZone);
    this.execution = new ExecutionService(database, this.unitOfWork, this.runs, this.telemetry, {
      getSharedMessageById: (id) => this.getSharedMessageById(id),
      recordSharedBriefEntry: (conversationId, messageId, author, kind, body) => this.recordSharedBriefEntry(conversationId, messageId, author, kind, body),
    });
    this.workItemLifecycle = new WorkItemService(database, this.unitOfWork, this.workItems, {
      get: (id) => this.get(id),
      addActivity: (workItemId, actor, kind, body) => this.addActivity(workItemId, actor, kind, body),
      recordLifecycleEvent: (input) => this.recordLifecycleEvent(input),
      list: () => this.list(),
      listWorkbench: () => this.listWorkbench(),
      reorder: (orderedItemIds, stack) => this.reorder(orderedItemIds, stack),
    });
    this.conversationService = new ConversationService(database, this.unitOfWork, this.conversations, {
      getConversation: (id) => this.getConversation(id),
      getWorkItem: (id) => this.get(id),
      getClassification: (workItemId) => this.getClassification(workItemId),
      listAllSharedMessages: (conversationId) => this.listAllSharedMessages(conversationId),
      createConversation: (title, workItemId) => this.createConversation(title, workItemId),
      createSharedMessage: (author, body, status, conversationId, attachments, dispatchTarget) => this.createSharedMessage(author, body, status, conversationId, attachments, dispatchTarget),
      archiveWorkItem: (id, completed, withinTransaction, context) => this.archive(id, completed, withinTransaction, context),
      addActivity: (workItemId, actor, kind, body) => this.addActivity(workItemId, actor, kind, body),
    });
  }

  /**
   * Repository operations compose through this boundary. SQLite has no nested
   * BEGIN transaction, so compound operations must share their caller's unit
   * of work rather than opening a second transaction underneath it. Delegates
   * to the shared `UnitOfWork` so domain repositories (telemetry, source
   * connections, and future extractions) compose inside the same transaction
   * as `WorkItemRepository`'s own multi-write methods.
   */
  transaction<T>(operation: () => T): T {
    return this.unitOfWork.transaction(operation);
  }

  getDiscoveryInbox(view: 'pending' | 'reviewed' = 'pending'): DiscoveryInbox {
    const candidates = this.discovery.listCandidates(view);
    const counts = this.discovery.getCandidateCounts();
    const { run, running } = this.discovery.getLastRun();
    return { candidates, pendingCount: counts.pending, reviewedCount: counts.reviewed, lastRun: run, running, queueProposal: this.getPendingProposal() };
  }

  startDiscoveryRun(): DiscoveryRun {
    return this.discovery.startRun();
  }

  finishDiscoveryRun(id: string, candidateCount: number, errors: string[], failed = false): void {
    this.discovery.finishRun(id, candidateCount, errors, failed);
  }

  recoverStaleDiscoveryRuns(maxAgeMs: number): DiscoveryRun[] {
    return this.discovery.recoverStaleRuns(maxAgeMs);
  }

  discoveryCandidateExists(fingerprint: string): boolean {
    return this.discovery.candidateExists(fingerprint);
  }

  upsertDiscoveryCandidate(input: { fingerprint: string; provider: string; title: string; description: string; sourceUrl: string | null; occurredAt: string | null; runId: string; relevance?: number }): boolean {
    const suggestedWorkItemId = this.discovery.findSuggestedWorkItemId(input.sourceUrl);
    return this.discovery.upsertCandidate({ ...input, suggestedWorkItemId });
  }

  resolveDiscoveryCandidate(id: string, action: 'convert' | 'dismiss' | 'snooze' | 'merge', workItemId?: string): DiscoveryCandidate | null {
    return this.transaction(() => {
      const candidate = this.discovery.getPendingCandidate(id);
      if (!candidate) return null;
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
      return this.discovery.applyResolution(id, status, linkedId, snoozedUntil);
    });
  }

  updateDiscoveryCandidate(id: string, changes: { title?: string; description?: string }): DiscoveryCandidate | null {
    return this.discovery.updateFields(id, changes);
  }

  resolveDiscoveryCandidates(ids: string[], action: 'convert' | 'dismiss' | 'snooze'): DiscoveryCandidate[] {
    const resolved: DiscoveryCandidate[] = [];
    for (const id of ids) {
      const pending = this.discovery.getCandidate(id);
      const candidate = action === 'convert' && pending?.suggestedWorkItemId
        ? this.resolveDiscoveryCandidate(id, 'merge', pending.suggestedWorkItemId)
        : this.resolveDiscoveryCandidate(id, action);
      if (candidate) resolved.push(candidate);
    }
    return resolved;
  }

  restoreDiscoveryCandidate(id: string): DiscoveryCandidate | null {
    return this.transaction(() => {
      const candidate = this.discovery.getCandidate(id);
      if (!candidate || !['converted', 'dismissed', 'snoozed'].includes(candidate.status)) return null;
      if (candidate.status === 'converted' && (!candidate.workItemId || !this.delete(candidate.workItemId))) return null;
      return this.discovery.restoreCandidate(id, candidate.status === 'converted');
    });
  }

  listConversations(view: 'active' | 'archive' | 'all' = 'active'): SharedConversation[] {
    return this.conversations.list(view).map((conversation) => this.withConversationState(conversation));
  }

  getConversation(id: string): SharedConversation | null {
    return this.listConversations('all').find((conversation) => conversation.id === id) ?? null;
  }

  listConversationPage(limit: number, cursor: string | null, view: 'active' | 'archive' = 'active'): ConversationPage {
    const { conversations: rawConversations, hasMore, totalCount } = this.conversations.listPage(limit, cursor, view);
    const conversations = rawConversations.map((conversation) => this.withConversationState(conversation));
    const last = conversations.at(-1);
    return { conversations, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ isPinned: Boolean(last.pinned || last.linkedWorkItemPinned), isWorking: last.state === 'working', updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null,
      totalCount };
  }

  createConversation(title = 'New conversation', workItemId: string | null = null): SharedConversation {
    return this.conversations.create(title, workItemId);
  }

  markConversationRead(id: string): SharedConversation | null {
    return this.conversations.markRead(id) ? this.getConversation(id) : null;
  }

  setConversationSharedBrief(id: string, brief: string): SharedConversation | null {
    return this.conversations.setSharedBrief(id, brief) ? this.getConversation(id) : null;
  }

  setConversationDraft(id: string, body: string): SharedConversation | null {
    return this.conversations.setDraftBody(id, body) ? this.getConversation(id) : null;
  }

  setConversationPinned(id: string, pinned: boolean): SharedConversation | null {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    return this.transaction(() => {
      if (!this.conversations.setPinned(id, pinned)) return null;
      if (conversation.workItemId) {
        // A task and its directly linked conversation are one parked-work
        // destination. Keep their pin state together whichever surface
        // Jeffrey uses; run-history-only conversations are not task links.
        this.update(conversation.workItemId, { status: pinned ? 'pinned' : 'ready' }, true, { actor: 'jeffrey', source: 'conversation_pin' });
      }
      return this.getConversation(id);
    });
  }

  // Handing a conversation to an agent is the signal that it's back in active
  // work, whether the turn was dispatched over HTTP or through the MCP admin
  // surface -- both paths must unpin the conversation and its linked task so
  // neither is left stuck in the pinned stack once work resumes.
  unpinConversationAndLinkedItem(conversationId: string): void {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return;
    if (conversation.workItemId) {
      const linkedItem = this.get(conversation.workItemId);
      if (linkedItem?.status === 'pinned') this.update(linkedItem.id, { status: 'ready' }, false, { actor: 'jeffrey', source: 'http' });
    }
    if (conversation.pinned) this.setConversationPinned(conversationId, false);
  }

  countActiveConversations(): number {
    return this.conversations.countActive();
  }

  countUnreadConversations(): number {
    return this.conversations.countUnread();
  }

  /** Conversations whose next meaningful action belongs to Jeffrey. */
  countAttentionConversations(): number {
    return this.listConversations().filter((conversation) =>
      conversation.state === 'needs_attention' || conversation.state === 'waiting_approval',
    ).length;
  }

  private withConversationState(conversation: SharedConversation): SharedConversation {
    const promoting = Boolean(this.database.prepare(`
      SELECT 1 FROM shared_messages
      WHERE conversation_id = ? AND author = 'system' AND dispatch_target = 'promotion' AND status = 'running'
      LIMIT 1
    `).get(conversation.id));
    // The approval to promote the preview has already landed; the conversation is
    // still "working" only because the build/promotion step (or the agent work it
    // waits behind) hasn't finished yet. Surface that distinctly from generic work.
    if (promoting) return { ...conversation, state: 'promoting' };
    // The approval was recorded but the build/promotion step hasn't started yet
    // (it's still behind active agent work). Surface that distinctly from a
    // promotion that is actually running, and from generic "working" state.
    const waitingPromotion = Boolean(this.database.prepare(`
      SELECT 1 FROM shared_messages
      WHERE conversation_id = ? AND author = 'system' AND dispatch_target = 'promotion' AND status = 'queued'
      LIMIT 1
    `).get(conversation.id));
    if (waitingPromotion) return { ...conversation, state: 'waiting_promotion' };
    const hasLiveWork = Boolean(this.database.prepare(`
      SELECT 1 FROM shared_messages
      WHERE conversation_id = ? AND status IN ('queued', 'running') AND dispatch_target != 'promotion'
      LIMIT 1
    `).get(conversation.id));
    const latest = this.database.prepare(`
      SELECT status FROM shared_messages
      WHERE conversation_id = ? AND author IN ('codex', 'claude')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(conversation.id) as { status: SharedMessage['status'] } | undefined;
    if (hasLiveWork || conversation.isActive || latest?.status === 'running' || latest?.status === 'queued') return { ...conversation, state: 'working' };
    if (latest?.status === 'failed') return { ...conversation, state: 'needs_attention' };
    if (latest?.status === 'canceled') return { ...conversation, state: 'canceled' };
    if (conversation.workItemId && this.getPendingExecutionPlan(conversation.workItemId)) return { ...conversation, state: 'waiting_approval' };
    if (latest?.status === 'completed') return { ...conversation, state: 'finished' };
    return { ...conversation, state: null };
  }

  setConversationExecutionProfile(id: string, profile: SharedConversation['preferredExecutionProfile']): SharedConversation | null {
    const before = this.getConversation(id);
    if (!before) return null;
    const changed = this.conversations.setExecutionProfile(id, profile);
    if (!changed) return null;
    if (before.workItemId && before.preferredExecutionProfile !== profile) {
      this.addActivity(before.workItemId, 'jeffrey', 'model_preference',
        profile ? `Set the model tier preference to ${profile}.` : 'Cleared the model tier preference (back to auto).');
    }
    return this.getConversation(id);
  }

  setConversationComposerPreferences(id: string, preferences: Partial<Pick<SharedConversation, 'preferredExecutionProfile' | 'preferredAccountProfile' | 'preferredDispatchTarget'>>): SharedConversation | null {
    const before = this.getConversation(id);
    if (!before) return null;
    const next = { preferredExecutionProfile: before.preferredExecutionProfile, preferredAccountProfile: before.preferredAccountProfile, preferredDispatchTarget: before.preferredDispatchTarget, ...preferences };
    if (!this.conversations.setComposerPreferences(id, next)) return null;
    if (before.workItemId && before.preferredExecutionProfile !== next.preferredExecutionProfile) {
      this.addActivity(before.workItemId, 'jeffrey', 'model_preference', next.preferredExecutionProfile ? `Set the model tier preference to ${next.preferredExecutionProfile}.` : 'Cleared the model tier preference (back to auto).');
    }
    return this.getConversation(id);
  }

  setConversationClaudeSessionId(id: string, sessionId: string | null): SharedConversation | null {
    return this.conversations.setClaudeSessionId(id, sessionId) ? this.getConversation(id) : null;
  }

  setConversationCodexThreadId(id: string, threadId: string | null): SharedConversation | null {
    return this.conversations.setCodexThreadId(id, threadId) ? this.getConversation(id) : null;
  }

  setConversationWorkItem(id: string, workItemId: string | null): SharedConversation | null {
    const conversation = this.conversationService.setWorkItem(id, workItemId);
    if (conversation?.workItemId) this.syncConversationAttachmentsToWorkItem(conversation);
    return conversation;
  }

  /** Materializes pre-existing chat replies as task runs so either surface has the same execution history. */
  adoptConversationAgentRuns(workItemId: string, conversationId: string): number {
    return this.conversationService.adoptRuns(workItemId, conversationId);
  }

  /** Repairs conversations linked before run adoption existed. Safe to call on every process startup. */
  backfillConversationRunAdoptions(): number {
    return this.conversationService.backfillRunAdoptions();
  }

  setConversationArchived(id: string, archived: boolean): SharedConversation | null {
    return this.conversationService.setArchived(id, archived);
  }

  forkConversation(id: string): SharedConversation | null {
    return this.conversationService.fork(id);
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
    return this.conversations.delete(id);
  }

  /** Reverses `deleteConversation` within the same recoverability window; returns the restored conversation or null if it was never deleted. */
  undeleteConversation(id: string): SharedConversation | null {
    return this.conversations.undelete(id) ? this.getConversation(id) : null;
  }

  listSourceConnections(): SourceConnection[] {
    return this.sourceConnections.listSourceConnections();
  }

  getSourceSettings(provider: SourceProvider): Record<string, string> | null {
    return this.sourceConnections.getSourceSettings(provider);
  }

  setSourceConnection(provider: SourceProvider, label: string, settings: Record<string, string>): SourceConnection {
    return this.sourceConnections.setSourceConnection(provider, label, settings);
  }

  updateSourceScan(provider: SourceProvider, error: string | null): void {
    this.sourceConnections.updateSourceScan(provider, error);
  }

  markSourceReauthRequired(provider: SourceProvider, message: string): void {
    this.sourceConnections.markSourceReauthRequired(provider, message);
  }

  /** Soft delete: flags the row so it drops out of connection listings but stays recoverable in the database. Reconnecting the same provider (setSourceConnection) clears the flag. */
  removeSourceConnection(provider: SourceProvider): boolean {
    return this.sourceConnections.removeSourceConnection(provider);
  }

  private mapSharedMessageRow(row: Record<string, string | number | null>): SharedMessage {
    return {
      id: String(row.id), conversationId: String(row.conversation_id ?? ''), author: row.author as SharedMessage['author'], body: String(row.body),
      pinned: row.pinned === 1, status: row.status as SharedMessage['status'], error: String(row.error),
      createdAt: String(row.created_at), completedAt: row.completed_at ? String(row.completed_at) : null, attachments: JSON.parse(String(row.attachments_json ?? '[]')) as SharedAttachment[],
      model: row.model ? String(row.model) : null,
      accountProfile: row.account_profile ? String(row.account_profile) : null,
      executionProfile: row.execution_profile as SharedMessage['executionProfile'] ?? null,
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      cacheCreationInputTokens: row.cache_creation_input_tokens === null ? null : Number(row.cache_creation_input_tokens),
      cacheReadInputTokens: row.cache_read_input_tokens === null ? null : Number(row.cache_read_input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      fallbackFrom: row.fallback_from as SharedMessage['fallbackFrom'] ?? null, fallbackReason: row.fallback_reason ? String(row.fallback_reason) : null,
      dispatchTarget: row.dispatch_target as SharedMessage['dispatchTarget'] ?? 'none',
      dispatchGroupId: row.dispatch_group_id ? String(row.dispatch_group_id) : null,
      attempt: Number(row.attempt ?? 0), maxAttempts: Number(row.max_attempts ?? 3),
      nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
      queuePriority: Number(row.queue_priority ?? 0),
      interjectionStreamOffset: row.interjection_stream_offset === null || row.interjection_stream_offset === undefined ? null : Number(row.interjection_stream_offset),
      retrievedMemoryCount: row.retrieved_memory_count === null || row.retrieved_memory_count === undefined ? null : Number(row.retrieved_memory_count),
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

  /** Small active-run projection for global activity indicators. */
  listSharedMessageActivity(): Array<Pick<SharedMessage, 'id' | 'conversationId' | 'author' | 'status'>> {
    return this.database.prepare(`SELECT id, conversation_id, author, status FROM shared_messages
      WHERE status IN ('queued', 'running') ORDER BY created_at DESC`).all()
      .map((row) => ({ id: String(row.id), conversationId: String(row.conversation_id), author: row.author as SharedMessage['author'], status: row.status as SharedMessage['status'] }));
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
   * Combined, ranked full-text search over shared conversation titles and
   * message bodies (see the conversations_fts/messages_fts tables and their
   * sync triggers in database.ts). Each side is queried and ranked
   * separately with FTS5 bm25() (lower = more relevant), then merged and
   * re-sorted in application code — simplest way to produce one ranked list
   * from two independent FTS tables without a fragile cross-table UNION.
   */
  searchShared(query: string, limit = 20): SharedSearchResult[] {
    const matchQuery = buildFtsMatchQuery(query);
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

  /**
   * Read-only retrieval over the complete durable Workbench record for
   * agents. Built on the vectorized hybrid (FTS5 BM25 + cosine) index in
   * memory-index.ts rather than a LIKE scan. Public/ad-hoc searches refresh
   * first, collecting new or changed durable records and embedding anything
   * pending so a write made moments ago is retrievable with no separate
   * reindex step. Prompt assembly may opt out of that refresh to avoid making
   * a task wait behind corpus maintenance; it searches the already-ready
   * index instead.
   *
   * At the current corpus size (~19k rows) that per-call refresh is a
   * handful of full-table scans plus embedding only whatever is still
   * unindexed (usually nothing, once collectMemoryDocuments/indexPendingMemory
   * have run at startup) -- cheap in steady state. If the corpus grows enough
   * for the full per-source scan itself to matter, decouple collection from
   * the request path (a poller keyed off a watermark) rather than doing it
   * here.
   */
  async searchActivityMemory(query: string, limit = 40, options: { refresh?: boolean; excludeExactBody?: string; projectKey?: string } = {}): Promise<Array<{ source: string; title: string; body: string; createdAt: string; score: number; conversationId: string | null; workItemId: string | null }>> {
    if (query.trim().length < 2) return [];
    if (options.refresh !== false) {
      try {
        collectMemoryDocuments(this.database);
        await indexPendingMemory(this.database, { limit: 2_000 });
      } catch (error) {
        console.error('[memory-index] failed to refresh memory index before search', error);
      }
    }
    const safeLimit = Math.max(1, Math.min(100, limit));
    const results = await searchMemory(this.database, query, { limit: safeLimit, projectKey: options.projectKey });
    const excludedBody = options.excludeExactBody?.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    return results.map((result) => ({
      source: legacyMemorySource(result.source),
      title: result.title,
      body: result.snippet.slice(0, 4_000),
      createdAt: result.createdAt,
      score: result.score,
      conversationId: result.conversationId,
      workItemId: result.workItemId,
    })).filter((result) => !excludedBody || result.body.trim().replace(/\s+/g, ' ').toLocaleLowerCase() !== excludedBody);
  }

  listQueuedConversationIds(): string[] {
    const rows = this.database.prepare("SELECT DISTINCT conversation_id FROM shared_messages WHERE status = 'queued'").all() as Array<{ conversation_id: string | null }>;
    return rows.map((row) => row.conversation_id).filter((id): id is string => id !== null);
  }

  createSharedMessage(author: SharedMessage['author'], body: string, status: SharedMessage['status'] = 'completed', conversationId?: string, attachments: SharedAttachment[] = [], dispatchTarget = 'none', executionProfile: AgentRun['executionProfile'] = null, accountProfile: string | null = null, dispatchGroupId: string | null = null): SharedMessage {
    const conversation = conversationId ? this.listConversations('all').find((item) => item.id === conversationId) : this.ensureDefaultConversation();
    if (!conversation) throw new Error('Conversation not found.');
    const message: SharedMessage = {
      id: randomUUID(), conversationId: conversation.id, author, body, pinned: false, status, error: '', createdAt: new Date().toISOString(), completedAt: ['completed', 'failed', 'canceled'].includes(status) ? new Date().toISOString() : null, attachments, model: null, accountProfile, executionProfile, inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null, fallbackFrom: null, fallbackReason: null, dispatchTarget: dispatchTarget as SharedMessage['dispatchTarget'],
      attempt: 0, maxAttempts: 3, nextAttemptAt: null, queuePriority: 0, interjectionStreamOffset: null, retrievedMemoryCount: null, dispatchGroupId,
    };
    this.database.prepare(`
      INSERT INTO shared_messages (id, conversation_id, author, body, pinned, status, error, attachments_json, dispatch_target, created_at, completed_at, execution_profile, account_profile, dispatch_group_id)
      VALUES (?, ?, ?, ?, 0, ?, '', ?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, message.conversationId, author, body, status, JSON.stringify(attachments), dispatchTarget, message.createdAt, message.completedAt, executionProfile, accountProfile, dispatchGroupId);
    if (attachments.length && conversation.workItemId) this.syncConversationAttachmentsToWorkItem(conversation);
    this.database.prepare('UPDATE shared_conversations SET updated_at = ?, title = CASE WHEN title = ? AND ? = ? THEN substr(?, 1, 80) ELSE title END WHERE id = ?')
      .run(message.createdAt, 'New conversation', author, 'jeffrey', body, message.conversationId);
    return message;
  }

  /** Mirrors linked conversation files into the task's durable agent context. */
  private syncConversationAttachmentsToWorkItem(conversation: SharedConversation): void {
    if (!conversation.workItemId) return;
    const item = this.get(conversation.workItemId);
    if (!item) return;
    const existingPaths = new Set((item.attachments ?? []).map((attachment) => attachment.path));
    const attachments = this.listAllSharedMessages(conversation.id)
      .flatMap((message) => message.attachments)
      .filter((attachment) => {
        if (existingPaths.has(attachment.path)) return false;
        existingPaths.add(attachment.path);
        return true;
      });
    if (!attachments.length) return;
    this.update(item.id, { attachments: [...(item.attachments ?? []), ...attachments] }, false, { actor: 'jeffrey', source: 'conversation' });
    this.addActivity(item.id, 'jeffrey', 'attachment_added', `Added ${attachments.length} conversation attachment${attachments.length === 1 ? '' : 's'} to task files.`);
  }

  /** Promotion is a global control-plane action: concurrent approvals share
   * the same pending record rather than creating an unbounded FIFO. */
  queueRuntimePromotion(conversationId: string): SharedMessage {
    return this.unitOfWork.transaction(() => {
      const active = this.database.prepare(`SELECT id FROM shared_messages
        WHERE author = 'system' AND dispatch_target = 'promotion' AND status IN ('queued', 'running')
        ORDER BY created_at ASC LIMIT 1`).get() as { id: string } | undefined;
      if (active) {
        const message = this.getSharedMessageById(active.id);
        if (message) return message;
      }
      return this.createSharedMessage('system', PROMOTION_QUEUED_MESSAGE, 'queued', conversationId, [], 'promotion');
    });
  }

  nextQueuedSharedTurn(conversationId: string, busyAgents: ReadonlySet<AgentRun['agent']> = new Set()): { message: SharedMessage; dispatchTarget: 'auto' | 'codex' | 'claude' | 'both' } | null {
    const rows = this.database.prepare(`SELECT id, dispatch_target FROM shared_messages
      WHERE conversation_id = ? AND author = 'jeffrey' AND status = 'queued'
      ORDER BY queue_priority DESC, created_at ASC, rowid ASC`).all(conversationId) as Array<{ id: string; dispatch_target: string }>;
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
    const nextPriority = this.database.prepare(`SELECT COALESCE(MAX(queue_priority), 0) + 1 AS value
      FROM shared_messages WHERE conversation_id = ? AND status = 'queued'`).get(message.conversationId) as { value: number };
    this.database.prepare('UPDATE shared_messages SET queue_priority = ? WHERE id = ?').run(nextPriority.value, id);
    return this.getSharedMessageById(id);
  }

  updateSharedMessage(id: string, changes: { pinned?: boolean; body?: string; status?: SharedMessage['status']; error?: string; author?: SharedMessage['author']; model?: string; accountProfile?: string | null; executionProfile?: SharedMessage['executionProfile']; inputTokens?: number | null; cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null; outputTokens?: number | null; fallbackFrom?: AgentRun['agent'] | null; fallbackReason?: string | null; completedAt?: string | null; interjectionStreamOffset?: number | null; retrievedMemoryCount?: number | null; retrievedMemoryDetail?: { query: string; items: Array<{ source: string; title: string; body: string; createdAt: string }> } | null }): SharedMessage | null {
    // A retry reuses the same message row. Never let the error from the prior
    // attempt survive a successful or user-canceled terminal transition.
    const error = changes.error ?? (changes.status === 'completed' || changes.status === 'canceled' ? '' : undefined);
    const entries = Object.entries({
      pinned: changes.pinned === undefined ? undefined : Number(changes.pinned),
      body: changes.body, status: changes.status, error, author: changes.author, model: changes.model, account_profile: changes.accountProfile, execution_profile: changes.executionProfile,
      input_tokens: changes.inputTokens, cache_creation_input_tokens: changes.cacheCreationInputTokens, cache_read_input_tokens: changes.cacheReadInputTokens, output_tokens: changes.outputTokens, fallback_from: changes.fallbackFrom, fallback_reason: changes.fallbackReason, interjection_stream_offset: changes.interjectionStreamOffset, retrieved_memory_count: changes.retrievedMemoryCount,
      retrieved_memory_detail_json: changes.retrievedMemoryDetail === undefined ? undefined : changes.retrievedMemoryDetail === null ? null : JSON.stringify(changes.retrievedMemoryDetail),
      completed_at: changes.completedAt ?? (changes.status && ['completed', 'failed', 'canceled'].includes(changes.status) ? new Date().toISOString() : undefined),
    }).filter((entry): entry is [string, string | number | null] => entry[1] !== undefined);
    if (entries.length) this.database.prepare(`UPDATE shared_messages SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
    return this.getSharedMessageById(id);
  }

  addAgentStreamEvents(messageId: string, runId: string | null, events: Array<{ kind: AgentStreamEvent['kind']; detail: string }>): void {
    if (!events.length) return;
    const insert = this.database.prepare(`INSERT INTO agent_stream_events (id, message_id, run_id, kind, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const createdAt = new Date().toISOString();
    this.unitOfWork.transaction(() => {
      for (const event of events) insert.run(randomUUID(), messageId, runId, event.kind, event.detail.slice(0, 2_000), createdAt);
    });
  }

  addAgentRunDiagnostic(runId: string, messageId: string | null, agent: AgentRun['agent'], kind: 'prompt' | 'usage' | 'tool', detail: Record<string, unknown>): void {
    this.database.prepare(`INSERT INTO agent_run_diagnostics (id, run_id, message_id, agent, kind, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), runId, messageId, agent, kind, JSON.stringify(detail), new Date().toISOString());
  }

  listAgentStreamEvents(conversationId: string): AgentStreamEvent[] {
    return (this.database.prepare(`SELECT events.id, events.message_id, events.run_id, events.kind, events.detail, events.created_at
      FROM agent_stream_events AS events
      JOIN shared_messages AS messages ON messages.id = events.message_id
      WHERE messages.conversation_id = ? ORDER BY events.created_at ASC, events.rowid ASC`).all(conversationId) as Array<Record<string, string | null>>)
      .map((row) => ({ id: row.id!, messageId: row.message_id!, runId: row.run_id, kind: row.kind as AgentStreamEvent['kind'], detail: row.detail!, createdAt: row.created_at! }));
  }

  getSessionFeedback(conversationId?: string | null, workItemId?: string | null): SessionFeedback | null {
    if (!conversationId && !workItemId) return null;
    const row = this.database.prepare(`SELECT * FROM session_feedback
      WHERE (conversation_id = ? OR work_item_id = ?) ORDER BY created_at DESC LIMIT 1`).get(conversationId ?? null, workItemId ?? null) as Record<string, string | null> | undefined;
    if (!row) return null;
    return {
      id: row.id!, conversationId: row.conversation_id, workItemId: row.work_item_id,
      rating: row.rating as SessionFeedbackRating,
      decisionTree: JSON.parse(row.decision_tree_json!) as SessionFeedback['decisionTree'], createdAt: row.created_at!,
    };
  }

  captureWorkspaceDiffSnapshot(scope: { workItemId: string } | { conversationId: string }, diff: WorkspaceDiff, provenance: { originatingAgentRunId?: string | null; commitHash?: string | null } = {}): WorkspaceDiffSnapshot {
    const now = new Date().toISOString();
    const id = randomUUID();
    if ('workItemId' in scope) {
      this.database.prepare(`INSERT OR IGNORE INTO workspace_diff_snapshots (id, work_item_id, conversation_id, revision, diff_json, captured_at, originating_agent_run_id, commit_hash) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(id, scope.workItemId, diff.revision, JSON.stringify(diff), now, provenance.originatingAgentRunId ?? null, provenance.commitHash ?? null);
      return mapWorkspaceDiffSnapshot(this.database.prepare(`SELECT id, revision, diff_json, captured_at, originating_agent_run_id, commit_hash FROM workspace_diff_snapshots WHERE work_item_id = ? AND revision = ?`).get(scope.workItemId, diff.revision) as unknown as WorkspaceDiffSnapshotRow);
    }
    this.database.prepare(`INSERT OR IGNORE INTO workspace_diff_snapshots (id, work_item_id, conversation_id, revision, diff_json, captured_at, originating_agent_run_id, commit_hash) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`).run(id, scope.conversationId, diff.revision, JSON.stringify(diff), now, provenance.originatingAgentRunId ?? null, provenance.commitHash ?? null);
    return mapWorkspaceDiffSnapshot(this.database.prepare(`SELECT id, revision, diff_json, captured_at, originating_agent_run_id, commit_hash FROM workspace_diff_snapshots WHERE conversation_id = ? AND revision = ?`).get(scope.conversationId, diff.revision) as unknown as WorkspaceDiffSnapshotRow);
  }

  listWorkspaceDiffSnapshots(scope: { workItemId: string } | { conversationId: string }): WorkspaceDiffSnapshot[] {
    const [column, id] = 'workItemId' in scope ? ['work_item_id', scope.workItemId] : ['conversation_id', scope.conversationId];
    return (this.database.prepare(`SELECT id, revision, diff_json, captured_at, originating_agent_run_id, commit_hash FROM workspace_diff_snapshots WHERE ${column} = ? ORDER BY captured_at DESC`).all(id) as unknown as WorkspaceDiffSnapshotRow[]).map(mapWorkspaceDiffSnapshot);
  }

  latestAgentRunForSnapshot(scope: { workItemId: string } | { conversationId: string }): AgentRun | null {
    if ('workItemId' in scope) return this.listRuns(scope.workItemId)[0] ?? null;
    const row = this.database.prepare('SELECT id FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(scope.conversationId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : null;
  }

  upsertDiffHunkReview(scope: { workItemId: string } | { conversationId: string }, input: { revision: string; filePath: string; hunkRange: string; fingerprint?: string | null; state: DiffHunkReviewState; note?: string | null }): DiffHunkReview {
    const [column, id] = 'workItemId' in scope ? ['work_item_id', scope.workItemId] : ['conversation_id', scope.conversationId];
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO diff_hunk_reviews (id, ${column}, revision, file_path, hunk_range, hunk_fingerprint, state, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(${column}, revision, file_path, hunk_range) WHERE ${column} IS NOT NULL DO UPDATE SET hunk_fingerprint = excluded.hunk_fingerprint, state = excluded.state, note = excluded.note, updated_at = excluded.updated_at`)
      .run(randomUUID(), id, input.revision, input.filePath, input.hunkRange, input.fingerprint ?? null, input.state, input.note ?? null, now);
    return mapDiffHunkReview(this.database.prepare(`SELECT id, revision, file_path, hunk_range, hunk_fingerprint, state, note, updated_at FROM diff_hunk_reviews WHERE ${column} = ? AND revision = ? AND file_path = ? AND hunk_range = ?`)
      .get(id, input.revision, input.filePath, input.hunkRange) as unknown as DiffHunkReviewRow);
  }

  upsertDiffHunkReviews(scope: { workItemId: string } | { conversationId: string }, input: UpsertDiffHunkReviewsInput): DiffHunkReview[] {
    return this.transaction(() => input.hunks.map((hunk) => this.upsertDiffHunkReview(scope, {
      revision: input.revision,
      filePath: hunk.filePath,
      hunkRange: hunk.hunkRange,
      fingerprint: hunk.fingerprint ?? null,
      state: input.state,
      note: input.note,
    })));
  }

  /** Reviews that apply to `revision`, plus the reviews recorded against other
   * revisions of the same scope that still carry a content fingerprint. The
   * caller re-attaches those by fingerprint: without them a reviewer working
   * alongside a running agent loses every decision the moment the agent writes
   * a file. Deduped to the newest row per fingerprint so the payload stays
   * proportional to the code under review rather than to the session's length. */
  listDiffHunkReviews(scope: { workItemId: string } | { conversationId: string }, revision: string): DiffHunkReview[] {
    const [column, id] = 'workItemId' in scope ? ['work_item_id', scope.workItemId] : ['conversation_id', scope.conversationId];
    const current = (this.database.prepare(`SELECT id, revision, file_path, hunk_range, hunk_fingerprint, state, note, updated_at FROM diff_hunk_reviews WHERE ${column} = ? AND revision = ? ORDER BY file_path ASC, hunk_range ASC`)
      .all(id, revision) as unknown as DiffHunkReviewRow[]).map(mapDiffHunkReview);
    const decided = new Set(current.map((review) => review.fingerprint).filter((fingerprint): fingerprint is string => Boolean(fingerprint)));
    const carried = new Map<string, DiffHunkReview>();
    for (const row of this.database.prepare(`SELECT id, revision, file_path, hunk_range, hunk_fingerprint, state, note, updated_at FROM diff_hunk_reviews
      WHERE ${column} = ? AND revision <> ? AND hunk_fingerprint IS NOT NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(id, revision, CARRIED_REVIEW_SCAN_LIMIT) as unknown as DiffHunkReviewRow[]) {
      const review = mapDiffHunkReview(row);
      if (!review.fingerprint || decided.has(review.fingerprint) || carried.has(review.fingerprint)) continue;
      carried.set(review.fingerprint, review);
    }
    return [...current, ...carried.values()];
  }

  createSessionFeedback(input: { conversationId?: string | null; workItemId?: string | null; rating: SessionFeedbackRating }): SessionFeedback | null {
    if (!input.conversationId && !input.workItemId) return null;
    return this.transaction(() => {
      const existing = this.getSessionFeedback(input.conversationId, input.workItemId);
      if (existing) return existing;
      if (input.conversationId && !this.getConversation(input.conversationId)) return null;
      if (input.workItemId && !this.get(input.workItemId)) return null;
      const createdAt = new Date().toISOString();
      const events = input.conversationId ? this.listAgentStreamEvents(input.conversationId) : [];
      const decisionTree: SessionFeedback['decisionTree'] = { version: 1, capturedAt: createdAt, conversationId: input.conversationId ?? null, workItemId: input.workItemId ?? null, events };
      const id = randomUUID();
      this.database.prepare(`INSERT INTO session_feedback (id, conversation_id, work_item_id, rating, decision_tree_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.conversationId ?? null, input.workItemId ?? null, input.rating, JSON.stringify(decisionTree), createdAt);
      return { id, conversationId: input.conversationId ?? null, workItemId: input.workItemId ?? null, rating: input.rating, decisionTree, createdAt };
    });
  }

  getRetrievedMemoryDetail(id: string): { query: string; items: Array<{ source: string; title: string; body: string; createdAt: string }> } | null {
    const row = this.database.prepare('SELECT retrieved_memory_detail_json FROM shared_messages WHERE id = ?').get(id) as { retrieved_memory_detail_json: string | null } | undefined;
    if (!row?.retrieved_memory_detail_json) return null;
    return JSON.parse(row.retrieved_memory_detail_json);
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

  /** Workbench is the Workbench-project slice of the one attention queue. */
  listWorkbench(): WorkItem[] {
    return this.listStack('workbench');
  }

  private listStack(stack: 'attention' | 'workbench'): WorkItem[] {
    return this.withDependencies(this.withLineage(this.workItems.listStack(stack).map((item) => this.withAgentOutcome(item))));
  }

  listArchived(): WorkItem[] {
    return this.withDependencies(this.withLineage(this.workItems.listArchived().map((item) => this.withAgentOutcome(item))));
  }

  listPage(view: 'active' | 'workbench' | 'archive' | 'workbench-archive', limit: number, cursor: string | null, filter: WorkItemFilter): WorkItemPage {
    const { items, nextCursor, totalCount } = this.workItems.listPage(view, limit, cursor, filter, this.timeZone);
    return { items: this.withDependencies(this.withLineage(items.map((item) => this.withAgentOutcome(item)))), nextCursor, totalCount, proposal: view === 'active' ? this.getPendingProposal('attention') : view === 'workbench' ? this.getPendingProposal('workbench') : null };
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

  /** The canonical project vocabulary, for pickers and for agents choosing a project. */
  listProjects(): ProjectSummary[] {
    return listProjects(this.database);
  }

  getWorkItemCounts(): { active: number; workbench: number; archive: number; attentionArchive: number; workbenchArchive: number } {
    return this.workItems.counts();
  }

  get(id: string): WorkItem | null {
    const item = this.workItems.get(id);
    return item ? this.withDependencies(this.withLineage([this.withAgentOutcome(item)]))[0] : null;
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
      dependencies.push(this.dependencyFromItem(mapWorkItemRow(row)));
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
    return rows.map((row) => this.dependencyFromItem(mapWorkItemRow(row)));
  }

  searchDependencyCandidates(workItemId: string, query = '', limit = 50): WorkItem[] {
    return this.withDependencies(this.withLineage(this.workItems.searchDependencyCandidates(workItemId, query, limit).map((item) => this.withAgentOutcome(item))));
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

  /** Clears every prerequisite link so a blocked task can proceed; the reason is recorded on the activity feed. */
  unblock(workItemId: string, reason: string, actor: Activity['actor'] = 'jeffrey'): WorkItem | null {
    const item = this.get(workItemId);
    if (!item) return null;
    if (!this.listOpenDependencies(workItemId).length) throw new WorkItemDependencyError('This task has no open prerequisites to unblock.');
    this.replaceDependencies(workItemId, []);
    this.addActivity(workItemId, actor, 'unblocked', reason);
    return this.get(workItemId);
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
      const parents = this.database.prepare(`SELECT id, title FROM work_items WHERE id IN (${parentPlaceholders}) AND deleted_at IS NULL`).all(...parentIds) as Array<{ id: string; title: string }>;
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
    // Promotion has been approved and is only waiting on the build/agent work
    // ahead of it; that's distinct from a task still actively being worked.
    const promoting = Boolean(this.database.prepare(`
      SELECT 1 FROM shared_messages sm
      JOIN shared_conversations sc ON sc.id = sm.conversation_id
      WHERE sc.work_item_id = ? AND sm.author = 'system' AND sm.dispatch_target = 'promotion' AND sm.status = 'running'
      LIMIT 1
    `).get(item.id));
    if (promoting) return { ...item, agentOutcome: 'promoting' };
    const waitingPromotion = Boolean(this.database.prepare(`
      SELECT 1 FROM shared_messages sm
      JOIN shared_conversations sc ON sc.id = sm.conversation_id
      WHERE sc.work_item_id = ? AND sm.author = 'system' AND sm.dispatch_target = 'promotion' AND sm.status = 'queued'
      LIMIT 1
    `).get(item.id));
    if (waitingPromotion) return { ...item, agentOutcome: 'waiting_promotion' };
    if (!latest) return item;
    const recentStatuses = this.database.prepare(`
      SELECT status FROM agent_runs
      WHERE work_item_id = ? AND julianday(created_at) >= julianday(?) - (2.0 / 86400.0)
    `).all(item.id, latest.created_at) as Array<{ status: AgentRun['status'] }>;
    const agentOutcome: WorkItem['agentOutcome'] =
      recentStatuses.some(({ status }) => status === 'queued' || status === 'running') ? null
        : recentStatuses.some(({ status }) => status === 'failed') ? 'needs_attention'
          : recentStatuses.some(({ status }) => status === 'canceled') ? 'canceled'
          : recentStatuses.some(({ status }) => status === 'completed')
            ? (this.getPendingExecutionPlan(item.id) ? 'follow_ups' : 'finished')
            : null;
    return { ...item, agentOutcome };
  }

  searchLinear(query: string, limit = 20): WorkItem[] {
    return this.withDependencies(this.withLineage(this.workItems.searchLinear(query, limit).map((item) => this.withAgentOutcome(item))));
  }

  queueLinearItem(id: string): WorkItem | null {
    const item = this.get(id);
    if (!item || item.source !== 'linear') return null;
    return this.transaction(() => {
      this.workItems.setQueued(id, new Date().toISOString());
      this.reorder([id, ...this.list().map((queued) => queued.id).filter((queuedId) => queuedId !== id)]);
      this.addActivity(id, 'system', 'queued', 'Added to the Workbench queue.');
      return this.get(id);
    });
  }

  reorder(orderedItemIds: string[], stack?: 'attention' | 'workbench', change?: { actor: QueueOrderChange['actor']; reason: string }): WorkItem[] {
    return this.queuePlanning.reorder(orderedItemIds, stack, change);
  }

  listQueueHistory(stack: 'attention' | 'workbench' = 'attention', limit = 20): QueueOrderChange[] {
    return this.queuePlanning.listQueueHistory(stack, limit);
  }

  /**
   * Reverses the most recent ordering change that still describes today's stack.
   * Entries whose snapshot no longer matches (a task was added, completed, or
   * archived since) are skipped rather than force-applied, because replaying a
   * stale snapshot would silently drop or resurrect tasks.
   */
  undoLastQueueChange(stack: 'attention' | 'workbench' = 'attention'): { change: QueueOrderChange; items: WorkItem[] } | null {
    return this.queuePlanning.undoLastQueueChange(stack);
  }

  move(itemId: string, neighbor: { beforeId?: string; afterId?: string }, stack: 'attention' | 'workbench' = 'attention'): WorkItem[] {
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
    return this.queuePlanning.moveForAttention(id, destination, reason);
  }

  getPendingProposal(stack: 'attention' | 'workbench' = 'attention'): QueueProposal | null {
    return this.queuePlanning.getPendingProposal(stack);
  }

  createProposal(orderedItemIds: string[], rationale: string, explanations: QueueItemExplanation[] = []): QueueProposal {
    return this.queuePlanning.createProposal(orderedItemIds, rationale, explanations);
  }

  /**
   * Gathers everything the ranking engine needs in a fixed number of queries.
   * Kept alongside proposal creation so `queue-intelligence.ts` stays pure and
   * testable.
   */
  buildQueueContext(now = Date.now()): QueueContext {
    return this.queuePlanning.buildQueueContext(now);
  }

  /** Weights learned from the proposals Jeffrey accepted or rejected. */
  getQueueFeedbackWeights(limit = 20): Map<QueueSignalKey, FeedbackWeight> {
    return this.queuePlanning.getQueueFeedbackWeights(limit);
  }

  /** Ranks the current stack without touching it. Backs the "why this order" view. */
  explainQueue(now = Date.now()): QueuePlan {
    return this.queuePlanning.explainQueue(now);
  }

  buildDailyProposal(now = Date.now(), stack: 'attention' | 'workbench' = 'attention'): QueueProposal {
    return this.queuePlanning.buildDailyProposal(now, stack);
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
    return this.queuePlanning.resolveProposal(id, resolution);
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
    attachments?: SharedAttachment[];
  }): WorkItem {
    // Callers that predate the explicit field still express intent through the
    // project name, so it seeds the stack once here. After this insert the
    // stored value is authoritative and project renames never move the task.
    // `stack` remains in the persisted shape for compatibility with promoted
    // runtimes, but every newly written task belongs to the single attention
    // queue. Workbench membership is a project focus filter.
    const stack: WorkItem['stack'] = 'attention';
    const id = randomUUID();
    const now = new Date().toISOString();
    // Locally authored, so typos are forgiven: `wkbnch` lands on Workbench and
    // is remembered as an alias instead of becoming a 113th project.
    const project = resolveProjectName(this.database, input.projectName, { fuzzy: true, now });

    return this.transaction(() => {
      const position = this.workItems.nextQueuePosition();
      this.workItems.insertManual({
        id, title: input.title, description: input.description, status: input.status, priority: input.priority, position,
        projectName: project?.name ?? null, projectKey: project?.key ?? null, stack, workspacePath: input.workspacePath,
        dueDate: input.dueDate, sourceUrl: input.sourceUrl ?? null, parentWorkItemId: input.parentWorkItemId ?? null, attachments: input.attachments ?? [], createdAt: now,
      });
      this.addActivity(id, 'system', 'created', 'Manual work item created.');
      this.recordLifecycleEvent({ workItemId: id, transition: 'created', fromStatus: null, toStatus: input.status, isInitial: true, actor: 'system', source: 'manual', occurredAt: now });
      const stackItems = this.list();
      this.reorder([id, ...stackItems.map((item) => item.id).filter((itemId) => itemId !== id)], 'attention');
      return this.get(id)!;
    });
  }

  /**
   * Creates a discovery proposal without moving the queue or making it ready.
   * The proposal remains machine-marked until Jeffrey explicitly promotes it.
   */
  createMachineProposal(input: {
    title: string;
    description: string;
    suggestedPriority: number;
    suggestedQueuePosition: number;
    rationale: string;
    runId: string;
    windowStart: string;
    sourceUrl: string | null;
    now?: string;
  }): WorkItem {
    const id = randomUUID();
    const createdAt = input.now ?? new Date().toISOString();
    return this.transaction(() => {
      this.workItems.insertMachineProposal({
        id, title: input.title, description: input.description, status: 'backlog', priority: input.suggestedPriority,
        position: this.workItems.nextQueuePosition(), projectName: null, projectKey: null, stack: 'attention',
        workspacePath: null, dueDate: null, sourceUrl: input.sourceUrl, parentWorkItemId: null, attachments: [], createdAt,
        runId: input.runId, windowStart: input.windowStart, suggestedPriority: input.suggestedPriority,
        suggestedQueuePosition: input.suggestedQueuePosition, rationale: input.rationale,
      });
      this.addActivity(id, 'system', 'machine_proposed', `Discovery proposal awaiting Jeffrey's review. ${input.rationale}`);
      this.recordLifecycleEvent({ workItemId: id, transition: 'created', fromStatus: null, toStatus: 'backlog', isInitial: true, actor: 'system', source: 'autonomous_discovery', occurredAt: createdAt });
      return this.get(id)!;
    });
  }

  /** Open-title dedupe for discovery. It is intentionally conservative: exact
   * wording and high token overlap are rejected; merely sharing generic verbs is not. */
  findOpenWorkItemNearTitle(title: string): WorkItem | null {
    const tokens = (value: string) => new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/).map((word) => word.replace(/(?:es|s)$/, '')).filter((word) => word.length >= 3 && !new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'task', 'work']).has(word)));
    const target = tokens(title);
    if (!target.size) return null;
    for (const item of this.list()) {
      if (item.archivedAt || item.status === 'done' || item.status === 'canceled') continue;
      const candidate = tokens(item.title);
      const shared = [...target].filter((token) => candidate.has(token)).length;
      const score = shared / new Set([...target, ...candidate]).size;
      if (score >= 0.6 || [...target].every((token) => candidate.has(token)) || [...candidate].every((token) => target.has(token))) return item;
    }
    return null;
  }

  isMachineProposalCreatedInWindow(item: WorkItem, windowStart: string): boolean {
    return item.machineProposalWindowStart === windowStart;
  }

  createFollowUp(parentId: string, title: string, description: string): WorkItem | null {
    const parent = this.get(parentId);
    if (!parent) return null;
    const followUp = this.create({
      title, description, priority: 2, status: 'ready', projectName: parent.projectName, stack: parent.stack,
      workspacePath: parent.workspacePath, dueDate: null, sourceUrl: null, parentWorkItemId: parent.id, attachments: [],
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

  archive(id: string, completed: boolean, withinTransaction = false, context: LifecycleContext = {}): WorkItem | null {
    return this.workItemLifecycle.archive(id, completed, withinTransaction, context);
  }

  restore(id: string, withinTransaction = false, context: LifecycleContext = {}): WorkItem | null {
    return this.workItemLifecycle.restore(id, withinTransaction, context);
  }

  /** Soft delete: flags the row so it drops out of every list/get query but stays recoverable in the database. */
  delete(id: string): boolean {
    return this.workItemLifecycle.delete(id);
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
        else if (input.action === 'set_status') this.logBulkEdit(item, this.update(item.id, { status: input.status }, true, { actor: 'jeffrey', source: 'bulk' }));
        else if (input.action === 'set_assignees') this.logBulkEdit(item, this.update(item.id, { assignees: input.assignees }));
        else if (input.action === 'set_stack') this.update(item.id, { stack: input.stack }, true);
        else this.logBulkEdit(item, this.update(item.id, { projectName: input.projectName }, true));
      }
      const restored = input.action === 'restore' ? eligible : [];
      for (const stack of ['attention', 'workbench'] as const) {
        const restoredIds = restored.filter((item) => item.stack === stack).map((item) => item.id);
        if (!restoredIds.length) continue;
        const stackItems = stack === 'workbench' ? this.listWorkbench() : this.list();
        const orderedIds = [...restoredIds].reverse().concat(stackItems.map((item) => item.id).filter((id) => !restoredIds.includes(id)));
        this.workItems.setQueuePositions(orderedIds, new Date().toISOString());
      }
      if (input.action === 'set_stack') {
        const movedIds = eligible.filter((item) => item.stack !== input.stack).map((item) => item.id);
        if (movedIds.length) {
          const now = new Date().toISOString();
          const target = this.listStack(input.stack).map((item) => item.id);
          this.workItems.setQueuePositions([...movedIds, ...target.filter((id) => !movedIds.includes(id))], now);
          const source = input.stack === 'workbench' ? 'attention' : 'workbench';
          this.workItems.setQueuePositions(this.listStack(source).map((item) => item.id), now);
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

  update(id: string, changes: Partial<Pick<WorkItem, 'title' | 'description' | 'priority' | 'status' | 'projectName' | 'stack' | 'workspacePath' | 'dueDate' | 'attachments' | 'labels' | 'strategy' | 'assignees' | 'queuePosition'>> & { blockedByIds?: string[]; expectedVersion?: number }, withinTransaction = false, context: StatusTransitionContext = {}): WorkItem | null {
    const before = this.get(id);
    if (!before) return null;
    // Canonicalise before anything reads the change set, so a re-typed
    // `workbench` on a Linear task is recognised as the same value it already
    // holds rather than logged as a local edit that conflicts with the provider.
    const project = changes.projectName === undefined ? undefined : resolveProjectName(this.database, changes.projectName, { fuzzy: true });
    const resolved = project === undefined ? changes : { ...changes, projectName: project?.name ?? null };
    const columns = new Map<string, string | number | null | undefined>([
      ['title', resolved.title],
      ['description', resolved.description],
      ['priority', resolved.priority],
      ['status', resolved.status],
      ['project_name', project === undefined ? undefined : project?.name ?? null],
      ['project_key', project === undefined ? undefined : project?.key ?? null],
      // Compatibility field only: Workbench is selected by project, never by
      // a second stack membership value.
      ['stack', undefined],
      ['workspace_path', resolved.workspacePath],
      ['due_date', resolved.dueDate],
      ['attachments_json', resolved.attachments !== undefined ? JSON.stringify(resolved.attachments) : undefined],
      ['labels_json', resolved.labels !== undefined ? JSON.stringify(normalizeLabels(resolved.labels)) : undefined],
      ['strategy', resolved.strategy],
      ['assignees_json', resolved.assignees ? JSON.stringify(resolved.assignees) : undefined],
      ['queue_position', resolved.queuePosition],
      // Moving a machine proposal to ready is Jeffrey's explicit promotion.
      ['machine_proposed', resolved.status === 'ready' && before.machineProposed ? 0 : undefined],
    ]);
    const entries = [...columns].filter(
      (entry): entry is [string, string | number | null] => entry[1] !== undefined,
    );
    if (entries.length === 0 && resolved.blockedByIds === undefined) return this.get(id);

    const locallyChangedProviderFields = before.source === 'linear'
      ? providerSyncFields.filter((field) => resolved[field as keyof typeof resolved] !== undefined
        && !sameProviderValue(providerValues(before)[field], resolved[field as keyof typeof resolved] as ProviderFieldValue))
      : [];
    const statusChanged = resolved.status !== undefined && resolved.status !== before.status;
    const managesTransaction = (resolved.blockedByIds !== undefined || locallyChangedProviderFields.length > 0 || statusChanged) && !withinTransaction;
    if (managesTransaction) this.database.exec('BEGIN IMMEDIATE');
    try {
      if (resolved.blockedByIds !== undefined) this.replaceDependencyRows(id, resolved.blockedByIds);
      if (entries.length) {
        const now = new Date().toISOString();
        // Every write bumps `version`, whether or not the caller checked one.
        // A caller that supplied `expectedVersion` additionally guards the
        // WHERE clause with it, so a stale read fails the update outright
        // instead of silently overwriting a write that landed in between.
        const changed = this.workItems.updateFields(id, entries, { manualAssignees: Boolean(resolved.assignees), expectedVersion: resolved.expectedVersion });
        if (resolved.expectedVersion !== undefined && changed === 0) {
          const current = this.get(id);
          if (!current) return null;
          throw new WorkItemVersionConflictError(current);
        }
        if (locallyChangedProviderFields.length) {
          this.recordLocalProviderOverrides(id, providerValues(before), resolved, locallyChangedProviderFields, now);
        }
        if (resolved.title !== undefined || resolved.description !== undefined) {
          this.database.prepare("DELETE FROM work_item_classifications WHERE work_item_id = ? AND source != 'manual'").run(id);
        }
        if (statusChanged) {
          // Pinning is shared between a task and each conversation directly
          // linked to it. A non-pinned task cannot leave its conversation in
          // the pinned stack either. Historical run-only conversations are
          // intentionally excluded: they are records, not the task's live
          // conversation link.
          this.database.prepare(`UPDATE shared_conversations
            SET pinned = ?, updated_at = ?
            WHERE work_item_id = ? AND deleted_at IS NULL`).run(Number(resolved.status === 'pinned'), now, id);
          this.recordLifecycleEvent({
            workItemId: id,
            transition: 'status_changed',
            fromStatus: before.status,
            toStatus: resolved.status!,
            isInitial: false,
            actor: context.actor ?? 'system',
            source: context.source ?? 'repository',
            reason: context.reason,
            occurredAt: now,
          });
          if (resolved.status === 'ready' && before.machineProposed) {
            this.addActivity(id, context.actor ?? 'jeffrey', 'machine_proposal_promoted', 'Jeffrey promoted this machine proposal to ready.');
          }
        }
      }
      if (managesTransaction) this.database.exec('COMMIT');
    } catch (error) {
      if (managesTransaction) this.database.exec('ROLLBACK');
      throw error;
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

  private recordLifecycleEvent(input: {
    workItemId: string; transition: string; fromStatus: WorkItem['status'] | null; toStatus: WorkItem['status'];
    isInitial: boolean; actor: Activity['actor']; source: string; reason?: string; occurredAt: string;
  }): void {
    recordLifecycleEventRow(this.database, input);
  }

  listRuns(workItemId: string): AgentRun[] {
    return this.runs.list(workItemId);
  }

  getRun(id: string): AgentRun | null {
    return this.runs.get(id);
  }

  getRunByMessage(messageId: string): AgentRun | null {
    return this.runs.getByMessage(messageId);
  }

  createRun(workItemId: string, kind: AgentRun['kind'], requestedTarget: AgentRun['requestedTarget'], agent: AgentRun['agent'], instructions: string, conversationId: string | null = null, messageId: string | null = null, origin: AgentRun['origin'] = 'manual', accountProfile = DEFAULT_ACCOUNT_PROFILE): AgentRun {
    return this.runs.create(workItemId, kind, requestedTarget, agent, instructions, conversationId, messageId, origin, accountProfile);
  }

  selectBalancedAgent(preferred: AgentRun['agent']): AgentRun['agent'] {
    return this.runs.selectBalancedAgent(preferred);
  }

  updateRun(id: string, changes: RunPatch): void {
    this.runs.update(id, changes);
  }

  /**
   * Reopens the same failed attempt and linked chat bubble instead of forking
   * a second execution. See `ExecutionService.prepareRunRetry` for why both
   * writes share one transaction.
   */
  prepareRunRetry(id: string): AgentRun | null {
    return this.execution.prepareRunRetry(id);
  }

  prepareSharedMessageRetry(id: string): SharedMessage | null {
    return this.execution.prepareSharedMessageRetry(id);
  }

  upsertLinearItem(providerInput: ProviderWorkItem): 'imported' | 'updated' | 'skipped' {
    return this.providerSync.upsertLinearItem(providerInput);
  }

  /** Sync a Linear page atomically; individual upserts compose with this transaction. */
  upsertLinearItems(inputs: ProviderWorkItem[]): Array<'imported' | 'updated' | 'skipped'> {
    return this.providerSync.upsertLinearItems(inputs);
  }

  listProviderConflicts(workItemId: string): ProviderSyncConflict[] {
    return this.providerSync.listProviderConflicts(workItemId);
  }

  countProviderConflicts(): number {
    return this.providerSync.countProviderConflicts();
  }

  resolveProviderConflict(workItemId: string, field: ProviderSyncField, resolution: ProviderSyncConflictResolution): WorkItem | null {
    return this.providerSync.resolveProviderConflict(workItemId, field, resolution);
  }

  getLinearConfig(): LinearProviderConfig {
    return this.providerSync.getLinearConfig();
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
    return rows.map((row) => this.withAgentOutcome(mapWorkItemRow(row)));
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
      forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, preferredExecutionProfile: row.preferred_execution_profile as SharedConversation['preferredExecutionProfile'] ?? null, draftBody: String(row.draft_body ?? ''), preferredAccountProfile: row.preferred_account_profile ? String(row.preferred_account_profile) : null, preferredDispatchTarget: row.preferred_dispatch_target as SharedConversation['preferredDispatchTarget'] ?? null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
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
    return rows.map((row) => this.withAgentOutcome(mapWorkItemRow(row)));
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
    return this.providerSync.setLinearConfig(config);
  }

  // --- Reliability: lease + retry primitives -------------------------------
  //
  // A "claim" is an atomic conditional UPDATE: only the caller whose WHERE
  // clause matches (correct status, and no other owner holding a live lease)
  // gets to proceed. This is what makes it safe for two processes (an old
  // one that hasn't noticed it should stop, and a new one after a restart)
  // to both be looking at the same row without doing the work twice.

  claimRun(id: string, ownerId: string, leaseMs: number): boolean {
    return this.runs.claim(id, ownerId, leaseMs);
  }

  /**
   * Serializes mutating runs on the directory they actually edit. The per-task
   * guard never covered this: two runs on two different tasks routinely resolve
   * to the same repository and then edit, test, and read one moving tree.
   * Returns false when another live run holds the workspace.
   */
  claimWorkspace(workspace: string, runId: string, ownerId: string, leaseMs: number): boolean {
    return this.runs.claimWorkspace(workspace, runId, ownerId, leaseMs);
  }

  /** Keeps a held workspace lease alive for as long as its run is still executing. */
  renewWorkspaceLease(runId: string, leaseMs: number): void {
    this.runs.renewWorkspaceLease(runId, leaseMs);
  }

  releaseWorkspace(runId: string): void {
    this.runs.releaseWorkspace(runId);
  }

  /** Run currently holding an unexpired lease on `workspace`, if any. */
  workspaceLeaseHolder(workspace: string): string | null {
    return this.runs.workspaceLeaseHolder(workspace);
  }

  /**
   * Hands a claimed run back to the queue without consuming an attempt. Used
   * when the run is well-formed but its workspace is busy: waiting is not a
   * failure, so it must not count against the retry budget.
   */
  releaseRunToQueue(runId: string, ownerId: string, retryAfterMs: number): void {
    this.runs.releaseToQueue(runId, ownerId, retryAfterMs);
  }

  claimSharedMessage(id: string, ownerId: string, leaseMs: number): boolean {
    return this.execution.claimSharedMessage(id, ownerId, leaseMs);
  }

  /** Atomically starts a queued control-plane job. Kept separate from normal
   * messages so a promotion can visibly wait without pretending it is building. */
  claimQueuedPromotionMessage(id: string, ownerId: string, leaseMs: number): boolean {
    return this.execution.claimQueuedPromotionMessage(id, ownerId, leaseMs);
  }

  /** Atomically promote exactly one queued jeffrey turn to running-dispatch, guarding against double dispatch. */
  claimQueuedTurn(id: string): boolean {
    return this.execution.claimQueuedTurn(id);
  }

  renewLeases(ownerId: string, leaseMs: number): void {
    this.execution.renewLeases(ownerId, leaseMs);
  }

  renewRunLease(id: string, ownerId: string, leaseMs: number): boolean {
    return this.runs.renewLease(id, ownerId, leaseMs);
  }

  requestRunCancellation(id: string): boolean {
    return this.runs.requestCancellation(id);
  }

  isCancellationRequested(id: string): boolean {
    return this.runs.isCancellationRequested(id);
  }

  isRunCancellationSettling(id: string): boolean {
    return this.runs.isCancellationSettling(id);
  }

  /**
   * The owner may publish a terminal result or retry only while it still owns
   * the live, uncanceled attempt. The conditional write is the commit point;
   * callers must suppress every downstream side effect when it returns false.
   */
  finishRun(id: string, ownerId: string, patch: RunPatch): boolean {
    return this.transaction(() => {
      const finished = this.runs.finish(id, ownerId, patch);
      return finished;
    });
  }

  finishRunWithReviewHandoff(id: string, ownerId: string, patch: RunPatch, handoff: AgentRunReviewHandoff): boolean {
    return this.transaction(() => {
      const finished = this.runs.finish(id, ownerId, patch);
      if (finished) this.runs.recordReviewHandoff(handoff);
      return finished;
    });
  }

  finishRunCancellation(id: string, ownerId: string): boolean {
    return this.transaction(() => {
      const finished = this.runs.finishCancellation(id, ownerId);
      return finished;
    });
  }

  finishQueuedRunCancellation(id: string): boolean {
    return this.transaction(() => {
      const finished = this.runs.finishQueuedCancellation(id);
      return finished;
    });
  }

  renewSharedMessageLease(id: string, ownerId: string, leaseMs: number): boolean {
    return this.execution.renewSharedMessageLease(id, ownerId, leaseMs);
  }

  /** Mark work owned by a deliberately stopping runtime as interrupted now. */
  interruptOwnedWork(ownerId: string, reason: string): { runIds: string[]; messageIds: string[] } {
    return this.execution.interruptOwnedWork(ownerId, reason);
  }

  /** Schedule a bounded retry for a run that failed transiently. Returns false when attempts are exhausted. */
  scheduleRunRetry(id: string, ownerId: string, delayMs: number): boolean {
    return this.runs.scheduleRetry(id, ownerId, delayMs);
  }

  /**
   * Reclaim work whose lease expired without the owner finishing it (crash or restart).
   * See `ExecutionService.reclaimExpired` for why the run and message reclamation
   * loops share one transaction.
   */
  reclaimExpired(graceMs = 3 * 60_000): { recoveredRunIds: string[]; failedRunIds: string[]; recoveredMessageIds: string[] } {
    return this.execution.reclaimExpired(graceMs);
  }

  /** See `ExecutionService.reclaimOrphanedQueuedMessages` for why this backstop exists. */
  reclaimOrphanedQueuedMessages(graceMs = 15 * 60_000): { canceledMessageIds: string[] } {
    return this.execution.reclaimOrphanedQueuedMessages(graceMs);
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
    return this.runs.dueWork(limit);
  }

  /** Count of agent_run rows currently claimed and executing (status = 'running'). */
  runningRunCount(): number {
    return this.runs.runningCount();
  }

  hasLiveWork(): boolean {
    return this.runs.hasLiveWork();
  }

  /**
   * Work that must finish in the serving process before a promoted runtime can
   * be drained. This is deliberately broader than hasLiveWork(): system jobs
   * such as promotion must persist their own terminal message before the old
   * backend exits too.
   */
  hasRuntimeWork(ownerId: string): boolean {
    return this.runs.hasRuntimeWork(ownerId);
  }

  hasOwnedAgentWork(ownerId: string): boolean {
    return this.runs.hasOwnedAgentWork(ownerId);
  }

  hasPromotionBlockingWork(ownerId: string): boolean {
    return this.runs.hasPromotionBlockingWork(ownerId);
  }

  listRunningPromotionMessageIds(): string[] {
    return this.execution.listRunningPromotionMessageIds();
  }

  listQueuedPromotionMessageIds(): string[] {
    return this.execution.listQueuedPromotionMessageIds();
  }

  /** A promotion snapshots the complete idle tree, so later queued approvals
   * waiting on that same idle point are fulfilled by the one release. */
  completeQueuedPromotionMessages(exceptId: string, body: string): void {
    this.execution.completeQueuedPromotionMessages(exceptId, body);
  }

  /** A crashed owner must not leave a control-plane approval displayed as an
   * active deployment. It returns to the visible queue for the next worker. */
  requeueExpiredPromotionMessages(): number {
    return this.execution.requeueExpiredPromotionMessages();
  }

  getPromotionQueueStatus() {
    return this.execution.getPromotionQueueStatus();
  }

  activeRunsForItem(workItemId: string): AgentRun[] {
    return this.runs.activeForItem(workItemId);
  }

  // --- Audit log -----------------------------------------------------------

  addAuditEntry(category: AuditLogEntry['category'], source: string, detail: string, workItemId: string | null = null): void {
    this.telemetry.addAuditEntry(category, source, detail, workItemId);
  }

  listAuditLog(limit = 100, cursor: string | null = null, category?: AuditLogEntry['category'], workItemId?: string): AuditLogPage {
    return this.telemetry.listAuditLog(limit, cursor, category, workItemId);
  }

  // --- Diagnostics and retention ----------------------------------------

  logDiagnostic(event: DiagnosticEvent['event'], subsystem: DiagnosticEvent['subsystem'], outcome: 'success' | 'failure', detail: string, durationMs?: number, errorCode?: string): void {
    this.telemetry.logDiagnostic(event, subsystem, outcome, detail, durationMs, errorCode);
  }

  getRunInsights(timeframe: InsightsTimeframe = 'all'): RunInsights {
    return this.execution.getRunInsights(timeframe);
  }

  compactTerminalRuns(retentionDays: number = 7): number {
    return this.execution.compactTerminalRuns(retentionDays);
  }

  pruneArchivedMessages(retentionDays: number = 90): number {
    return this.execution.pruneArchivedMessages(retentionDays);
  }

  runRetentionCleanup(): void {
    this.execution.runRetentionCleanup();
  }

  surfaceStrandedRuns(graceMs = 3 * 60_000): string[] {
    return this.execution.surfaceStrandedRuns(graceMs);
  }
}
