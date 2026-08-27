import type { AgentRun, RunInsights, SharedMessage } from '../../shared/contracts.js';
import type { WorkbenchDatabase } from '../database.js';
import type { UnitOfWork } from '../unit-of-work.js';
import { RunRepository } from '../repositories/run-repository.js';
import type { TelemetryRepository } from '../repositories/telemetry-repository.js';
import { summarizeCursing } from '../profanity.js';

export interface ExecutionCollaborators {
  getSharedMessageById(id: string): SharedMessage | null;
  recordSharedBriefEntry(conversationId: string, messageId: string, author: string, kind: 'decision' | 'agent_handoff' | 'synthesis', body: string): void;
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

/**
 * Owns the agent-run execution lifecycle's cross-table orchestration: retry
 * prep that reopens a run and its linked chat bubble together, the
 * shared-message dispatch control plane (claims, leases, promotion queueing)
 * that has no single-table repository of its own, lease reclamation that
 * spans `agent_runs` and `shared_messages`, run/message retention, and the
 * run-insights report. Pure single-table `agent_runs` primitives (claim,
 * finish, cancel, dueWork, and the rest of the lease/retry API) already
 * delegate straight from `WorkItemRepository` to `RunRepository`, matching
 * the pattern used for the other extracted repositories, and stay there
 * unchanged.
 */
export class ExecutionService {
  constructor(
    private readonly database: WorkbenchDatabase,
    private readonly unitOfWork: UnitOfWork,
    private readonly runs: RunRepository,
    private readonly telemetry: TelemetryRepository,
    private readonly collaborators: ExecutionCollaborators,
  ) {}

  /**
   * Reopens the same failed attempt and linked chat bubble instead of forking
   * a second execution. Reopening the run and reopening its linked message
   * used to be two independent, unwrapped statements — a crash between them
   * could leave a `queued` run pointing at a chat bubble still marked
   * `failed`. Both writes now share one `UnitOfWork` transaction so they
   * commit or roll back together.
   */
  prepareRunRetry(id: string): AgentRun | null {
    return this.unitOfWork.transaction(() => {
      const run = this.runs.get(id);
      if (!run || (run.status !== 'failed' && run.status !== 'canceled')) return null;
      if (!this.runs.reopenForRetry(id)) return null;
      if (run.messageId) this.database.prepare(`UPDATE shared_messages
        SET status = 'running', error = '', completed_at = NULL, owner_id = NULL, lease_expires_at = NULL,
            attempt = attempt + 1, next_attempt_at = NULL
        WHERE id = ? AND status IN ('failed', 'canceled')`).run(run.messageId);
      return this.runs.get(id);
    });
  }

  prepareSharedMessageRetry(id: string): SharedMessage | null {
    const changed = this.database.prepare(`UPDATE shared_messages
      SET status = 'running', error = '', completed_at = NULL, owner_id = NULL, lease_expires_at = NULL,
          attempt = attempt + 1, next_attempt_at = NULL
      WHERE id = ? AND author IN ('codex', 'claude') AND status IN ('failed', 'canceled')`).run(id).changes;
    return changed ? this.collaborators.getSharedMessageById(id) : null;
  }

  claimSharedMessage(id: string, ownerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE shared_messages SET owner_id = ?, lease_expires_at = ?
      WHERE id = ?
        AND (status = 'running' OR (status = 'queued' AND author IN ('codex', 'claude')))
        AND (owner_id IS NULL OR lease_expires_at < ?)
    `).run(ownerId, leaseExpiresAt, id, now).changes;
    // A task-linked agent reply can be returned to the durable queue while its
    // repository is busy. Claiming it is the one transition that makes it
    // visibly live again; human turns remain exclusively owned by the normal
    // conversation dispatcher.
    if (changed) this.database.prepare(`UPDATE shared_messages SET status = 'running' WHERE id = ?`).run(id);
    return Number(changed) > 0;
  }

  /** Atomically starts a queued control-plane job. Kept separate from normal
   * messages so a promotion can visibly wait without pretending it is building. */
  claimQueuedPromotionMessage(id: string, ownerId: string, leaseMs: number): boolean {
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE shared_messages SET status = 'running', owner_id = ?, lease_expires_at = ?
      WHERE id = ? AND author = 'system' AND dispatch_target = 'promotion' AND status = 'queued'
    `).run(ownerId, leaseExpiresAt, id).changes;
    return Number(changed) > 0;
  }

  /** Atomically promote exactly one queued jeffrey turn to running-dispatch, guarding against double dispatch. */
  claimQueuedTurn(id: string): boolean {
    const changed = this.database.prepare(`
      UPDATE shared_messages SET status = 'completed' WHERE id = ? AND status = 'queued' AND author = 'jeffrey'
    `).run(id).changes;
    if (!Number(changed)) return false;
    const message = this.collaborators.getSharedMessageById(id);
    if (message) this.collaborators.recordSharedBriefEntry(message.conversationId, message.id, 'jeffrey', 'decision', message.body);
    return true;
  }

  renewLeases(ownerId: string, leaseMs: number): void {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    this.runs.renewOwnedLeases(ownerId, leaseMs);
    this.database.prepare(`UPDATE shared_messages SET lease_expires_at = ? WHERE owner_id = ? AND status = 'running' AND lease_expires_at >= ?`).run(leaseExpiresAt, ownerId, now);
  }

  renewSharedMessageLease(id: string, ownerId: string, leaseMs: number): boolean {
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE shared_messages SET lease_expires_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'running'
    `).run(leaseExpiresAt, id, ownerId).changes;
    return Number(changed) > 0;
  }

  /**
   * A controlled runtime promotion intentionally terminates this process. Do
   * not leave its owned work marked live until lease recovery: that blocks the
   * queue and falsely tells Jeffrey an agent is still working. Execute runs
   * are never replayed automatically, so make the interruption explicit.
   */
  interruptOwnedWork(ownerId: string, reason: string): { runIds: string[]; messageIds: string[] } {
    return this.unitOfWork.transaction(() => {
      const now = new Date().toISOString();
      const runIds = (this.database.prepare(`SELECT id FROM agent_runs WHERE status = 'running' AND owner_id = ?`).all(ownerId) as Array<{ id: string }>).map(({ id }) => id);
      const messageIds = (this.database.prepare(`SELECT id FROM shared_messages
        WHERE status = 'running' AND owner_id = ? AND author IN ('codex', 'claude')`).all(ownerId) as Array<{ id: string }>).map(({ id }) => id);
      if (runIds.length) this.database.prepare(`UPDATE agent_runs SET status = 'failed', error = ?, completed_at = ?, owner_id = NULL, lease_expires_at = NULL
        WHERE status = 'running' AND owner_id = ?`).run(reason, now, ownerId);
      if (messageIds.length) this.database.prepare(`UPDATE shared_messages SET status = 'failed', error = ?, completed_at = ?, owner_id = NULL, lease_expires_at = NULL
        WHERE status = 'running' AND owner_id = ? AND author IN ('codex', 'claude')`).run(reason, now, ownerId);
      return { runIds, messageIds };
    });
  }

  /**
   * Reclaim work whose lease expired without the owner finishing it (crash or restart).
   * `execute` runs perform non-idempotent filesystem edits, so they are never silently
   * re-run: they are marked failed for Jeffrey to re-trigger deliberately.
   *
   * The run reclamation loop and the message reclamation loop used to run as
   * separate, unwrapped statement batches: a crash or thrown error partway
   * through could leave some runs recovered and others (or their linked
   * messages) still dangling with an expired lease. Both loops now share one
   * `UnitOfWork` transaction so a whole reclamation pass commits or rolls
   * back together.
   */
  reclaimExpired(graceMs = 0): { recoveredRunIds: string[]; failedRunIds: string[]; recoveredMessageIds: string[] } {
    return this.unitOfWork.transaction(() => {
      const now = new Date().toISOString();
      // A lease remains valid until its expiry. Once it has expired, its owner
      // has already missed multiple heartbeats and the collector can recover it.
      const recoveryCutoff = new Date(Date.now() - graceMs).toISOString();
      const { recoveredRunIds, failedRunIds } = this.runs.reclaimExpired(recoveryCutoff, now);
      // Shared messages with expired leases are interrupted (not retried). This also
      // catches a reply that was persisted as `running` but whose dispatch process
      // died before it could claim its first lease. If there's an associated agent
      // run, that run will be recovered separately. When the run completes, it will
      // update the message to its final status (completed/failed).
      const expiredMessages = this.database.prepare(`SELECT id FROM shared_messages
        WHERE status = 'running'
          AND (lease_expires_at < ? OR (owner_id IS NULL AND lease_expires_at IS NULL AND created_at <= ?))
          AND dispatch_target != 'promotion'
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs
            WHERE agent_runs.message_id = shared_messages.id
              AND agent_runs.status IN ('queued', 'running')
          )`).all(recoveryCutoff, recoveryCutoff) as Array<{ id: string }>;
      const recoveredMessageIds: string[] = [];
      for (const message of expiredMessages) {
        this.database.prepare(`UPDATE shared_messages SET status = 'failed', error = 'Agent process stopped reporting progress. Retry or continue the conversation.', owner_id = NULL, lease_expires_at = NULL, completed_at = ? WHERE id = ?`).run(now, message.id);
        recoveredMessageIds.push(message.id);
      }
      return { recoveredRunIds, failedRunIds, recoveredMessageIds };
    });
  }

  /**
   * Backstop for `shared_messages` that reach `queued` and are never claimed
   * (dispatch died between insert and claim, test tooling created the row
   * directly, an invalid `dispatch_target`, etc). Queued rows never receive a
   * lease, so `reclaimExpired`'s lease-expiry check can't see them, and
   * `hasLiveWork()` counts any queued codex/claude message with no timeout —
   * one orphaned row blocks every runtime promotion forever (see the
   * 2026-08-25 incident in docs/shared-memory/workbench-operating-practices.md).
   * The grace period is long relative to `reclaimExpired`'s because a queued
   * codex/claude message can legitimately wait several minutes for a busy
   * agent to free up; only a row idle far longer than that is orphaned.
   */
  reclaimOrphanedQueuedMessages(graceMs = 15 * 60_000): { canceledMessageIds: string[] } {
    return this.unitOfWork.transaction(() => {
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - graceMs).toISOString();
      const orphaned = this.database.prepare(`SELECT id FROM shared_messages
        WHERE status = 'queued' AND author IN ('codex', 'claude') AND created_at <= ?`).all(cutoff) as Array<{ id: string }>;
      for (const message of orphaned) {
        this.database.prepare(`UPDATE shared_messages SET status = 'canceled', error = 'Orphaned queued message auto-canceled: never claimed or dispatched.', completed_at = ? WHERE id = ?`).run(now, message.id);
      }
      return { canceledMessageIds: orphaned.map(({ id }) => id) };
    });
  }

  listRunningPromotionMessageIds(): string[] {
    return (this.database.prepare(`SELECT id FROM shared_messages
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status = 'running'
      ORDER BY created_at ASC`).all() as Array<{ id: string }>).map(({ id }) => id);
  }

  listQueuedPromotionMessageIds(): string[] {
    return (this.database.prepare(`SELECT id FROM shared_messages
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status = 'queued'
      ORDER BY created_at ASC`).all() as Array<{ id: string }>).map(({ id }) => id);
  }

  /** Aggregate view of the promotion control plane so it can be surfaced
   * prominently in the UI without every caller re-deriving it from
   * `shared_messages` rows. Queue depth, the in-flight build's live progress
   * text, and the most recent terminal build outcome. */
  getPromotionQueueStatus(): {
    queueLength: number;
    oldestQueuedAt: string | null;
    running: { conversationId: string | null; progress: string; startedAt: string } | null;
    lastBuild: { status: 'succeeded' | 'failed'; at: string; summary: string } | null;
  } {
    const queued = this.database.prepare(`
      SELECT COUNT(*) as count, MIN(created_at) as oldest FROM shared_messages
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status = 'queued'
    `).get() as { count: number; oldest: string | null };
    const running = this.database.prepare(`
      SELECT conversation_id as conversationId, body as progress, created_at as startedAt FROM shared_messages
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status = 'running'
      ORDER BY created_at ASC LIMIT 1
    `).get() as { conversationId: string | null; progress: string; startedAt: string } | undefined;
    const lastCompleted = this.database.prepare(`
      SELECT status, body, error, completed_at as at FROM shared_messages
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status IN ('completed', 'failed') AND completed_at IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1
    `).get() as { status: 'completed' | 'failed'; body: string; error: string | null; at: string } | undefined;
    return {
      queueLength: queued.count,
      oldestQueuedAt: queued.oldest,
      running: running ?? null,
      lastBuild: lastCompleted
        ? { status: lastCompleted.status === 'completed' ? 'succeeded' : 'failed', at: lastCompleted.at, summary: lastCompleted.status === 'failed' ? (lastCompleted.error || lastCompleted.body) : lastCompleted.body }
        : null,
    };
  }

  /** A promotion snapshots the complete idle tree, so later queued approvals
   * waiting on that same idle point are fulfilled by the one release. */
  completeQueuedPromotionMessages(exceptId: string, body: string): void {
    this.database.prepare(`
      UPDATE shared_messages
      SET status = 'completed', body = ?, error = '', completed_at = ?, owner_id = NULL, lease_expires_at = NULL
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status = 'queued' AND id != ?
    `).run(body, new Date().toISOString(), exceptId);
  }

  /** A crashed owner must not leave a control-plane approval displayed as an
   * active deployment. It returns to the visible queue for the next worker. */
  requeueExpiredPromotionMessages(): number {
    const changed = this.database.prepare(`
      UPDATE shared_messages
      SET status = 'queued', owner_id = NULL, lease_expires_at = NULL
      WHERE author = 'system' AND dispatch_target = 'promotion' AND status = 'running'
        AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).run(new Date().toISOString()).changes;
    return Number(changed);
  }

  getRunInsights(days: 7 | 30 = 30): RunInsights {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const runs = this.database.prepare(`
      SELECT agent, kind, status, attempt, fallback_from, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, created_at, completed_at,
        CAST((julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 * 1000 AS INTEGER) as duration_ms
      FROM agent_runs WHERE status IN ('completed', 'failed', 'canceled') AND completed_at >= ?
    `).all(since) as Array<{
      agent: 'codex' | 'claude';
      kind: AgentRun['kind'];
      status: 'completed' | 'failed' | 'canceled';
      attempt: number;
      fallback_from: string | null;
      model: string | null;
      input_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
      output_tokens: number | null;
      created_at: string;
      completed_at: string;
      duration_ms: number | null;
    }>;
    // A shared-room reply linked to a task is the same provider invocation as
    // its agent_runs row, so it must never be counted twice. Unlinked replies
    // (including synthesis) have no run row, but are still real Workbench
    // calls and belong in token accounting.
    const unlinkedReplyUsage = this.database.prepare(`
      SELECT author AS agent, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, completed_at
      FROM shared_messages message
      WHERE author IN ('codex', 'claude') AND status IN ('completed', 'failed', 'canceled') AND completed_at >= ?
        AND NOT EXISTS (SELECT 1 FROM agent_runs run WHERE run.message_id = message.id)
    `).all(since) as Array<{
      agent: 'codex' | 'claude';
      model: string | null;
      input_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
      output_tokens: number | null;
      completed_at: string;
    }>;
    const usageRows: Array<Pick<typeof runs[number], 'agent' | 'model' | 'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens' | 'output_tokens' | 'completed_at'>> = [...runs, ...unlinkedReplyUsage];

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

    const tokenUsageByModel = new Map<string, { provider: 'codex' | 'claude'; model: string | null; inputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; outputTokens: number; runs: number }>();
    let incompleteTokenTelemetryRuns = 0;
    for (const run of usageRows) {
      const hasAnyTokenTelemetry = run.input_tokens !== null || run.cache_creation_input_tokens !== null || run.cache_read_input_tokens !== null || run.output_tokens !== null;
      // Before cache telemetry landed, input_tokens represented an unknown mix
      // of fresh and cached input. Displaying it as fresh input manufactured a
      // breakdown we do not have. A reported cache field (including an explicit
      // zero) proves the provider supplied the split for this invocation.
      const hasCompleteTokenTelemetry = run.cache_creation_input_tokens !== null || run.cache_read_input_tokens !== null;
      if (hasAnyTokenTelemetry && !hasCompleteTokenTelemetry) incompleteTokenTelemetryRuns += 1;
      if (hasCompleteTokenTelemetry) {
        const key = `${run.agent}:${run.model ?? ''}`;
        const bucket = tokenUsageByModel.get(key) ?? { provider: run.agent, model: run.model, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, runs: 0 };
        bucket.inputTokens += run.input_tokens ?? 0;
        bucket.cacheCreationInputTokens += run.cache_creation_input_tokens ?? 0;
        bucket.cacheReadInputTokens += run.cache_read_input_tokens ?? 0;
        bucket.outputTokens += run.output_tokens ?? 0;
        bucket.runs += 1;
        tokenUsageByModel.set(key, bucket);
      }
    }
    const fitBuckets = new Map<string, { kind: AgentRun['kind']; agent: 'codex' | 'claude'; completed: number; failed: number; canceled: number; durations: number[] }>();
    for (const run of runs) {
      const key = `${run.kind}:${run.agent}`;
      const bucket = fitBuckets.get(key) ?? { kind: run.kind, agent: run.agent, completed: 0, failed: 0, canceled: 0, durations: [] };
      if (run.status === 'completed') bucket.completed += 1;
      else if (run.status === 'failed') bucket.failed += 1;
      else if (run.status === 'canceled') bucket.canceled += 1;
      if (run.duration_ms !== null) bucket.durations.push(run.duration_ms);
      fitBuckets.set(key, bucket);
    }

    type AgentBucket = { total: number; completed: number; failed: number; canceled: number; retried: number; fallback: number; durations: number[] };
    const byAgent: Record<'codex' | 'claude', AgentBucket> = {
      codex: { total: 0, completed: 0, failed: 0, canceled: 0, retried: 0, fallback: 0, durations: [] },
      claude: { total: 0, completed: 0, failed: 0, canceled: 0, retried: 0, fallback: 0, durations: [] },
    };
    for (const run of runs) {
      const bucket = byAgent[run.agent];
      bucket.total += 1;
      if (run.status === 'completed') bucket.completed += 1;
      if (run.status === 'failed') bucket.failed += 1;
      if (run.status === 'canceled') bucket.canceled += 1;
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

    type KindBucket = { completed: number; failed: number; canceled: number };
    const byKind: Record<AgentRun['kind'], KindBucket> = {
      research: { completed: 0, failed: 0, canceled: 0 }, analysis: { completed: 0, failed: 0, canceled: 0 }, strategy: { completed: 0, failed: 0, canceled: 0 }, execute: { completed: 0, failed: 0, canceled: 0 }, review: { completed: 0, failed: 0, canceled: 0 }, bugfix: { completed: 0, failed: 0, canceled: 0 },
    };
    for (const run of runs) {
      if (run.status === 'completed') byKind[run.kind].completed += 1;
      if (run.status === 'failed') byKind[run.kind].failed += 1;
      if (run.status === 'canceled') byKind[run.kind].canceled += 1;
    }

    return {
      retryRate,
      retryCount,
      fallbackRate,
      handoffCount,
      inputTokens: [...tokenUsageByModel.values()].reduce((total, bucket) => total + bucket.inputTokens, 0),
      cacheCreationInputTokens: [...tokenUsageByModel.values()].reduce((total, bucket) => total + bucket.cacheCreationInputTokens, 0),
      cacheReadInputTokens: [...tokenUsageByModel.values()].reduce((total, bucket) => total + bucket.cacheReadInputTokens, 0),
      outputTokens: [...tokenUsageByModel.values()].reduce((total, bucket) => total + bucket.outputTokens, 0),
      incompleteTokenTelemetryRuns,
      tokenUsageByModel: [...tokenUsageByModel.values()].sort((left, right) => {
        const usageDifference = (right.inputTokens + right.cacheCreationInputTokens + right.cacheReadInputTokens + right.outputTokens) - (left.inputTokens + left.cacheCreationInputTokens + left.cacheReadInputTokens + left.outputTokens);
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
        canceled: bucket.canceled,
        successRate: bucket.completed + bucket.failed + bucket.canceled > 0 ? bucket.completed / (bucket.completed + bucket.failed + bucket.canceled) : null,
        medianDurationMs: median(bucket.durations),
      })),
      byAgent: Object.entries(byAgent).map(([agent, bucket]) => ({
        agent: agent as 'codex' | 'claude',
        total: bucket.total,
        completed: bucket.completed,
        failed: bucket.failed,
        successRate: bucket.total > 0 ? bucket.completed / bucket.total : null,
        retryRate: bucket.total > 0 ? bucket.retried / bucket.total : null,
        fallbackRate: bucket.total > 0 ? bucket.fallback / bucket.total : null,
        medianDurationMs: median(bucket.durations),
        p90DurationMs: percentile(bucket.durations, 0.9),
      })).filter((agent) => agent.total > 0),
      byKind: Object.entries(byKind)
        .filter(([, bucket]) => bucket.completed + bucket.failed + bucket.canceled > 0)
        .map(([kind, bucket]) => ({
          kind: kind as AgentRun['kind'],
          completed: bucket.completed,
          failed: bucket.failed,
          canceled: bucket.canceled,
          successRate: bucket.completed + bucket.failed + bucket.canceled > 0 ? bucket.completed / (bucket.completed + bucket.failed + bucket.canceled) : null,
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

      this.telemetry.logDiagnostic(
        'retention_cleanup',
        'retention',
        'success',
        `Compacted ${compactedRuns} terminal runs and pruned ${prunedMessages} archived messages.`,
        durationMs,
      );
    } catch (error) {
      const durationMs = Date.now() - start;
      this.telemetry.logDiagnostic(
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
      this.telemetry.logDiagnostic(
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
