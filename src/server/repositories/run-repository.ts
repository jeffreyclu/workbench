import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { DEFAULT_ACCOUNT_PROFILE, type AgentRun } from '../../shared/contracts.js';
import { WORKBENCH_PROJECT_KEY } from '../../shared/project-name.js';
import type { UnitOfWork } from '../unit-of-work.js';

export interface RunPatch {
  agent?: AgentRun['agent'];
  status?: AgentRun['status'];
  output?: string;
  error?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  model?: string;
  executionProfile?: NonNullable<AgentRun['executionProfile']>;
  accountProfile?: string;
  inputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  outputTokens?: number | null;
  fallbackFrom?: AgentRun['agent'] | null;
  fallbackReason?: string | null;
  ownerId?: string | null;
  leaseExpiresAt?: string | null;
  nextAttemptAt?: string | null;
  attempt?: number;
  resolvedWorkspace?: string | null;
}

function mapRunRow(row: Record<string, string | null>): AgentRun {
  return {
    id: row.id!, workItemId: row.work_item_id!, kind: row.kind as AgentRun['kind'],
    requestedTarget: row.requested_target as AgentRun['requestedTarget'],
    requestedAgent: (row.requested_agent ?? row.agent) as AgentRun['agent'], agent: row.agent as AgentRun['agent'],
    status: row.status as AgentRun['status'], instructions: row.instructions!, output: row.output!, error: row.error!,
    startedAt: row.started_at, completedAt: row.completed_at, createdAt: row.created_at!,
    conversationId: row.conversation_id, messageId: row.message_id,
    model: row.model, executionProfile: row.execution_profile as AgentRun['executionProfile'],
    accountProfile: row.account_profile ?? 'default',
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens), cacheCreationInputTokens: row.cache_creation_input_tokens === null ? null : Number(row.cache_creation_input_tokens), cacheReadInputTokens: row.cache_read_input_tokens === null ? null : Number(row.cache_read_input_tokens), outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    fallbackFrom: row.fallback_from as AgentRun['fallbackFrom'] ?? null, fallbackReason: row.fallback_reason,
    attempt: Number(row.attempt ?? 0), maxAttempts: Number(row.max_attempts ?? 3),
    nextAttemptAt: row.next_attempt_at ?? null,
    resolvedWorkspace: row.resolved_workspace ?? null,
    origin: (row.origin ?? 'manual') as AgentRun['origin'],
  };
}

/**
 * Owns the `agent_runs` table's row-level CRUD, lease/claim primitives, and
 * the closely-related `workspace_leases` table (a run always claims at most
 * one workspace, so its lease lifecycle travels with the run's). Retrying a
 * run also reopens its linked chat bubble, and reclaiming expired work also
 * reclaims expired shared messages — both reach into `shared_messages`,
 * which is outside this repository's tables, so that composition stays in
 * `WorkItemRepository`, calling back into the primitives here inside its own
 * `UnitOfWork` transaction. Read-only queries that join `shared_messages`
 * purely to filter or balance load (`getRunByMessage`, `selectBalancedAgent`,
 * `hasLiveWork`, `hasRuntimeWork`) stay here, matching the read-join pattern
 * already used by the other extracted repositories.
 */
export class RunRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  list(workItemId: string): AgentRun[] {
    return (this.database
      .prepare('SELECT * FROM agent_runs WHERE work_item_id = ? ORDER BY created_at DESC')
      .all(workItemId) as Array<Record<string, string | null>>)
      .map(mapRunRow);
  }

  get(id: string): AgentRun | null {
    const row = this.database.prepare('SELECT work_item_id FROM agent_runs WHERE id = ?').get(id) as { work_item_id: string } | undefined;
    return row ? this.list(row.work_item_id).find((run) => run.id === id) ?? null : null;
  }

  getByMessage(messageId: string): AgentRun | null {
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
    return row ? this.get(row.id) : null;
  }

  create(workItemId: string, kind: AgentRun['kind'], requestedTarget: AgentRun['requestedTarget'], agent: AgentRun['agent'], instructions: string, conversationId: string | null = null, messageId: string | null = null, origin: AgentRun['origin'] = 'manual', accountProfile = DEFAULT_ACCOUNT_PROFILE): AgentRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO agent_runs (id, work_item_id, kind, requested_target, requested_agent, agent, status, instructions, created_at, conversation_id, message_id, origin, account_profile)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
    `).run(id, workItemId, kind, requestedTarget, agent, agent, instructions, createdAt, conversationId, messageId, origin, accountProfile);
    return this.list(workItemId).find((run) => run.id === id)!;
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

  private patchEntries(changes: RunPatch): Array<[string, string | number | null]> {
    // Runs are retried in place, so clear any error left by the previous
    // attempt as soon as the reused run completes or is canceled.
    const error = changes.error ?? (changes.status === 'completed' || changes.status === 'canceled' ? '' : undefined);
    const columns = new Map<string, string | number | null | undefined>([
      ['agent', changes.agent], ['status', changes.status], ['output', changes.output], ['error', error], ['model', changes.model], ['execution_profile', changes.executionProfile], ['account_profile', changes.accountProfile],
      ['input_tokens', changes.inputTokens], ['cache_creation_input_tokens', changes.cacheCreationInputTokens], ['cache_read_input_tokens', changes.cacheReadInputTokens], ['output_tokens', changes.outputTokens], ['fallback_from', changes.fallbackFrom], ['fallback_reason', changes.fallbackReason],
      ['started_at', changes.startedAt], ['completed_at', changes.completedAt], ['owner_id', changes.ownerId], ['lease_expires_at', changes.leaseExpiresAt],
      ['next_attempt_at', changes.nextAttemptAt], ['attempt', changes.attempt], ['resolved_workspace', changes.resolvedWorkspace],
    ]);
    return [...columns].filter((entry): entry is [string, string | number | null] => entry[1] !== undefined);
  }

  update(id: string, changes: RunPatch): void {
    const entries = this.patchEntries(changes);
    if (!entries.length) return;
    this.database.prepare(`UPDATE agent_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  /**
   * Reopens the same failed/canceled attempt in place. Returns true when a
   * row actually transitioned back to `queued`; the caller (which also owns
   * reopening the linked chat bubble in `shared_messages`) uses that to
   * decide whether to touch the message at all.
   */
  reopenForRetry(id: string): boolean {
    return Number(this.database.prepare(`UPDATE agent_runs
      SET status = 'queued', error = '', started_at = NULL, completed_at = NULL,
          owner_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL, attempt = attempt + 1,
          cancel_requested = 0, cancel_requested_at = NULL
      WHERE id = ? AND status IN ('failed', 'canceled')`).run(id).changes) > 0;
  }

  claim(id: string, ownerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE agent_runs SET owner_id = ?, lease_expires_at = ?, status = 'running'
      WHERE id = ? AND status = 'queued' AND cancel_requested = 0 AND (owner_id IS NULL OR lease_expires_at < ?)
    `).run(ownerId, leaseExpiresAt, id, now).changes;
    return Number(changed) > 0;
  }

  /**
   * Serializes mutating runs on the directory they actually edit. The per-task
   * guard never covered this: two runs on two different tasks routinely resolve
   * to the same repository and then edit, test, and read one moving tree.
   * Returns false when another live run holds the workspace.
   */
  claimWorkspace(workspace: string, runId: string, ownerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    this.database.prepare('DELETE FROM workspace_leases WHERE expires_at <= ?').run(now);
    this.database.prepare(`
      INSERT INTO workspace_leases (workspace, run_id, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace) DO UPDATE
        SET run_id = excluded.run_id, owner_id = excluded.owner_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
        WHERE workspace_leases.run_id = excluded.run_id
    `).run(workspace, runId, ownerId, now, expiresAt);
    const row = this.database.prepare('SELECT run_id FROM workspace_leases WHERE workspace = ?').get(workspace) as { run_id: string } | undefined;
    return row?.run_id === runId;
  }

  /** Keeps a held workspace lease alive for as long as its run is still executing. */
  renewWorkspaceLease(runId: string, leaseMs: number): void {
    this.database.prepare('UPDATE workspace_leases SET expires_at = ? WHERE run_id = ?')
      .run(new Date(Date.now() + leaseMs).toISOString(), runId);
  }

  releaseWorkspace(runId: string): void {
    this.database.prepare('DELETE FROM workspace_leases WHERE run_id = ?').run(runId);
  }

  /** Run currently holding an unexpired lease on `workspace`, if any. */
  workspaceLeaseHolder(workspace: string): string | null {
    const row = this.database.prepare('SELECT run_id FROM workspace_leases WHERE workspace = ? AND expires_at > ?')
      .get(workspace, new Date().toISOString()) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }

  /**
   * Hands a claimed run back to the queue without consuming an attempt. Used
   * when the run is well-formed but its workspace is busy: waiting is not a
   * failure, so it must not count against the retry budget.
   */
  releaseToQueue(runId: string, ownerId: string, retryAfterMs: number): void {
    this.database.prepare(`
      UPDATE agent_runs SET status = 'queued', owner_id = NULL, lease_expires_at = NULL, started_at = NULL, next_attempt_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'running'
    `).run(new Date(Date.now() + retryAfterMs).toISOString(), runId, ownerId);
  }

  /** Extends every still-live run lease owned by `ownerId`. Does not touch `shared_messages`; the caller renews those separately. */
  renewOwnedLeases(ownerId: string, leaseMs: number): void {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    this.database.prepare(`UPDATE agent_runs SET lease_expires_at = ? WHERE owner_id = ? AND status = 'running' AND cancel_requested = 0 AND lease_expires_at >= ?`).run(leaseExpiresAt, ownerId, now);
  }

  renewLease(id: string, ownerId: string, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE agent_runs SET lease_expires_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'running' AND cancel_requested = 0 AND lease_expires_at >= ?
    `).run(leaseExpiresAt, id, ownerId, now).changes;
    return Number(changed) > 0;
  }

  requestCancellation(id: string): boolean {
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

  /** A canceled row remains owned until the process that received SIGTERM exits.
   * Reopening it before then would let the old and new attempts share one ID. */
  isCancellationSettling(id: string): boolean {
    const row = this.database.prepare(`SELECT 1 FROM agent_runs
      WHERE id = ? AND status = 'canceled' AND cancel_requested = 1 AND owner_id IS NOT NULL`).get(id);
    return Boolean(row);
  }

  /**
   * The owner may publish a terminal result or retry only while it still owns
   * the live, uncanceled attempt. The conditional write is the commit point;
   * callers must suppress every downstream side effect when it returns false.
   */
  finish(id: string, ownerId: string, patch: RunPatch): boolean {
    const entries = this.patchEntries(patch);
    if (!entries.length) return false;
    const changed = this.database.prepare(`
      UPDATE agent_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND owner_id = ? AND status = 'running' AND cancel_requested = 0 AND lease_expires_at >= ?
    `).run(...entries.map(([, value]) => value), id, ownerId, new Date().toISOString()).changes;
    return Number(changed) > 0;
  }

  /** Commit recovery only if the same interrupted owner still has an expired lease. */
  private finishExpired(id: string, ownerId: string, recoveryCutoff: string, patch: RunPatch): boolean {
    const entries = this.patchEntries(patch);
    if (!entries.length) return false;
    const changed = this.database.prepare(`
      UPDATE agent_runs SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE id = ? AND owner_id = ? AND status = 'running' AND cancel_requested = 0
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(...entries.map(([, value]) => value), id, ownerId, recoveryCutoff).changes;
    return Number(changed) > 0;
  }

  finishCancellation(id: string, ownerId: string): boolean {
    const changed = this.database.prepare(`
      UPDATE agent_runs SET status = 'canceled', error = '', completed_at = ?, owner_id = NULL, lease_expires_at = NULL
      WHERE id = ? AND owner_id = ? AND status IN ('running', 'canceled') AND cancel_requested = 1
    `).run(new Date().toISOString(), id, ownerId).changes;
    return Number(changed) > 0;
  }

  finishQueuedCancellation(id: string): boolean {
    const changed = this.database.prepare(`UPDATE agent_runs
      SET status = 'canceled', error = '', completed_at = ?
      WHERE id = ? AND status = 'queued' AND cancel_requested = 1`).run(new Date().toISOString(), id).changes;
    return Number(changed) > 0;
  }

  /** Schedule a bounded retry for a run that failed transiently. Returns false when attempts are exhausted. */
  scheduleRetry(id: string, ownerId: string, delayMs: number): boolean {
    const row = this.database.prepare('SELECT attempt, max_attempts FROM agent_runs WHERE id = ?').get(id) as { attempt: number; max_attempts: number } | undefined;
    if (!row || row.attempt + 1 >= row.max_attempts) return false;
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    return this.finish(id, ownerId, {
      status: 'queued', ownerId: null, leaseExpiresAt: null,
      attempt: row.attempt + 1, nextAttemptAt,
    });
  }

  /**
   * Reclaim runs whose lease expired without the owner finishing them (crash
   * or restart). `execute` runs perform non-idempotent filesystem edits, so
   * they are never silently re-run: they are marked failed for Jeffrey to
   * re-trigger deliberately. Pure `agent_runs` reclamation; the caller
   * (`WorkItemRepository.reclaimExpired`) separately reclaims expired
   * `shared_messages` inside the same transaction.
   */
  reclaimExpired(recoveryCutoff: string, now: string): { recoveredRunIds: string[]; failedRunIds: string[] } {
    const expiredRuns = this.database.prepare(`SELECT id, kind, owner_id, cancel_requested, attempt, max_attempts FROM agent_runs
      WHERE status = 'running' AND (lease_expires_at <= ? OR (owner_id IS NULL AND lease_expires_at IS NULL))`).all(recoveryCutoff) as Array<{ id: string; kind: AgentRun['kind']; owner_id: string | null; cancel_requested: number; attempt: number; max_attempts: number }>;
    const recoveredRunIds: string[] = [];
    const failedRunIds: string[] = [];
    for (const run of expiredRuns) {
      if (run.cancel_requested === 1) {
        this.database.prepare(`UPDATE agent_runs SET status = 'canceled', completed_at = ?, owner_id = NULL, lease_expires_at = NULL
          WHERE id = ? AND status = 'running' AND cancel_requested = 1`).run(now, run.id);
      } else if (!run.owner_id) {
        this.update(run.id, { status: 'failed', error: 'Agent process stopped reporting progress without a durable owner.', completedAt: now, ownerId: null, leaseExpiresAt: null });
        failedRunIds.push(run.id);
      } else if (run.kind === 'execute') {
        if (this.finishExpired(run.id, run.owner_id, recoveryCutoff, { status: 'failed', error: 'Agent process stopped reporting progress. Retry or continue the conversation.', completedAt: now, ownerId: null, leaseExpiresAt: null })) failedRunIds.push(run.id);
      } else if (run.attempt + 1 < run.max_attempts && this.finishExpired(run.id, run.owner_id, recoveryCutoff, {
        status: 'queued', ownerId: null, leaseExpiresAt: null, attempt: run.attempt + 1, nextAttemptAt: now,
      })) {
        recoveredRunIds.push(run.id);
      } else {
        if (this.finishExpired(run.id, run.owner_id, recoveryCutoff, { status: 'failed', error: 'Retry attempts exhausted after interruption.', completedAt: now, ownerId: null, leaseExpiresAt: null })) failedRunIds.push(run.id);
      }
    }
    return { recoveredRunIds, failedRunIds };
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
      const running = this.runningCount();
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
  runningCount(): number {
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

  /**
   * Only Workbench-scoped work holds a Workbench runtime during promotion.
   * Agent streams in a linked project repository are independent subprocesses
   * with durable leases; keeping this backend alive for them makes unrelated
   * Writer/project work block a Workbench-only release indefinitely. System
   * promotion work and unlinked (therefore Workbench) room turns still drain.
   */
  hasRuntimeWork(ownerId: string): boolean {
    const workbenchRoot = resolve(process.cwd());
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*)
           FROM agent_runs AS run
           JOIN work_items AS item ON item.id = run.work_item_id
          WHERE run.status = 'running' AND run.owner_id = ?
            AND (COALESCE(item.project_key, '') = ?
              OR COALESCE(run.resolved_workspace, item.workspace_path, '') = ?)) AS runs,
        (SELECT COUNT(*)
           FROM shared_messages AS message
           LEFT JOIN agent_runs AS run ON run.message_id = message.id AND run.status = 'running'
           LEFT JOIN shared_conversations AS conversation ON conversation.id = message.conversation_id
           LEFT JOIN work_items AS item ON item.id = conversation.work_item_id
          WHERE message.status = 'running' AND message.owner_id = ?
            AND (message.dispatch_target = 'promotion'
              OR (run.id IS NULL AND (conversation.work_item_id IS NULL
                OR COALESCE(item.project_key, '') = ?
                OR COALESCE(item.workspace_path, '') = ?)))) AS messages
    `).get(ownerId, WORKBENCH_PROJECT_KEY, workbenchRoot, ownerId, WORKBENCH_PROJECT_KEY, workbenchRoot) as { runs: number; messages: number };
    return Number(row.runs) + Number(row.messages) > 0;
  }

  /**
   * Promotion is allowed once this runtime has no Workbench-scoped agent work
   * left to snapshot. Unlike hasRuntimeWork, deliberately exclude the
   * promotion progress message itself: it is claimed before this predicate is
   * checked, so including it turns every promotion into a self-deadlock.
   */
  hasPromotionBlockingWork(ownerId: string): boolean {
    const workbenchRoot = resolve(process.cwd());
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*)
           FROM agent_runs AS run
           JOIN work_items AS item ON item.id = run.work_item_id
          WHERE run.status = 'running' AND run.owner_id = ?
            AND (COALESCE(item.project_key, '') = ?
              OR COALESCE(run.resolved_workspace, item.workspace_path, '') = ?)) AS runs,
        (SELECT COUNT(*)
           FROM shared_messages AS message
           LEFT JOIN agent_runs AS run ON run.message_id = message.id AND run.status = 'running'
           LEFT JOIN shared_conversations AS conversation ON conversation.id = message.conversation_id
           LEFT JOIN work_items AS item ON item.id = conversation.work_item_id
          WHERE message.status = 'running' AND message.owner_id = ?
            AND message.dispatch_target <> 'promotion'
            AND (run.id IS NULL AND (conversation.work_item_id IS NULL
              OR COALESCE(item.project_key, '') = ?
              OR COALESCE(item.workspace_path, '') = ?))) AS messages
    `).get(ownerId, WORKBENCH_PROJECT_KEY, workbenchRoot, ownerId, WORKBENCH_PROJECT_KEY, workbenchRoot) as { runs: number; messages: number };
    return Number(row.runs) + Number(row.messages) > 0;
  }

  activeForItem(workItemId: string): AgentRun[] {
    return this.list(workItemId).filter((run) => run.status === 'queued' || run.status === 'running');
  }

}
