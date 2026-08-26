import { randomUUID } from 'node:crypto';

import type { AgentRun, AuditLogEntry, AuditLogPage, DiagnosticEvent, UsageCalibration } from '../../shared/contracts.js';
import { sonnetEquivalentTokens } from '../usage-meter.js';
import type { UnitOfWork } from '../unit-of-work.js';

export interface AutonomyPolicy {
  globalEnabled: boolean;
  targetFraction: number;
  alarmFraction: number;
  providers: Partial<Record<AgentRun['agent'], { enabled: boolean; weeklyCeilingSet: number }>>;
}

export interface AutonomyGovernorDecisionRecord {
  id: string;
  provider: AgentRun['agent'];
  model: string;
  workItemId: string | null;
  outcome: 'allowed' | 'refused';
  reasonCode: string;
  reason: string;
  estimatedSet: number | null;
  reservationId: string | null;
  createdAt: string;
}

interface UsageCalibrationRow {
  id: string; provider: UsageCalibration['provider']; observed_at: string; observed_percentage: number;
  resets_at: string | null; workbench_set: number; interactive_set: number; computed_ceiling_set: number; created_at: string;
}

function mapUsageCalibrationRow(row: UsageCalibrationRow): UsageCalibration {
  return {
    id: row.id, provider: row.provider, observedAt: row.observed_at, observedPercentage: row.observed_percentage,
    resetsAt: row.resets_at, workbenchSet: row.workbench_set, interactiveSet: row.interactive_set, computedCeilingSet: row.computed_ceiling_set,
    createdAt: row.created_at,
  };
}

/**
 * Audit trail, diagnostics, and autonomous-budget bookkeeping.
 * Every table here (`audit_log`, `diagnostics`, `usage_calibrations`,
 * `budget_reservations`) is owned exclusively by this repository — nothing
 * here reaches into work-item, conversation, or run state, so it never needs
 * to compose inside another repository's transaction to stay consistent.
 * `tryReserveAutonomousBudget` still uses the shared `UnitOfWork.transaction`
 * so its read-then-insert stays atomic under concurrent callers.
 */
export class TelemetryRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

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

  logDiagnostic(event: DiagnosticEvent['event'], subsystem: DiagnosticEvent['subsystem'], outcome: 'success' | 'failure', detail: string, durationMs?: number, errorCode?: string): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO diagnostics (id, event, subsystem, outcome, error_code, detail, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, event, subsystem, outcome, errorCode ?? null, detail, durationMs ?? null, now);
  }

  getAutonomyPolicy(): AutonomyPolicy {
    const global = this.database.prepare('SELECT global_enabled, target_fraction, alarm_fraction FROM autonomy_policy WHERE id = 1').get() as {
      global_enabled: number; target_fraction: number; alarm_fraction: number;
    };
    const providers = this.database.prepare('SELECT provider, enabled, weekly_ceiling_set FROM autonomy_provider_policy').all() as Array<{
      provider: AgentRun['agent']; enabled: number; weekly_ceiling_set: number;
    }>;
    return {
      globalEnabled: global.global_enabled === 1,
      targetFraction: Number(global.target_fraction),
      alarmFraction: Number(global.alarm_fraction),
      providers: Object.fromEntries(providers.map((row) => [row.provider, { enabled: row.enabled === 1, weeklyCeilingSet: Number(row.weekly_ceiling_set) }])),
    };
  }

  setAutonomyPolicy(input: { globalEnabled: boolean; targetFraction: number; alarmFraction: number }, now = new Date().toISOString()): AutonomyPolicy {
    this.database.prepare(`UPDATE autonomy_policy SET global_enabled = ?, target_fraction = ?, alarm_fraction = ?, updated_at = ? WHERE id = 1`)
      .run(Number(input.globalEnabled), input.targetFraction, input.alarmFraction, now);
    return this.getAutonomyPolicy();
  }

  setAutonomyProviderPolicy(provider: AgentRun['agent'], input: { enabled: boolean; weeklyCeilingSet: number }, now = new Date().toISOString()): AutonomyPolicy {
    this.database.prepare(`INSERT INTO autonomy_provider_policy (provider, enabled, weekly_ceiling_set, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, weekly_ceiling_set = excluded.weekly_ceiling_set, updated_at = excluded.updated_at`)
      .run(provider, Number(input.enabled), input.weeklyCeilingSet, now);
    return this.getAutonomyPolicy();
  }

  recordAutonomyGovernorDecision(input: Omit<AutonomyGovernorDecisionRecord, 'id' | 'createdAt'> & { createdAt?: string }): AutonomyGovernorDecisionRecord {
    const record: AutonomyGovernorDecisionRecord = { ...input, id: randomUUID(), createdAt: input.createdAt ?? new Date().toISOString() };
    this.database.prepare(`INSERT INTO autonomy_governor_decisions
      (id, provider, model, work_item_id, outcome, reason_code, reason, estimated_set, reservation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.provider, record.model, record.workItemId, record.outcome, record.reasonCode, record.reason, record.estimatedSet, record.reservationId, record.createdAt);
    return record;
  }

  listAutonomyGovernorDecisions(limit = 100): AutonomyGovernorDecisionRecord[] {
    const rows = this.database.prepare('SELECT * FROM autonomy_governor_decisions ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id), provider: row.provider as AgentRun['agent'], model: String(row.model), workItemId: row.work_item_id === null ? null : String(row.work_item_id),
      outcome: row.outcome as AutonomyGovernorDecisionRecord['outcome'], reasonCode: String(row.reason_code), reason: String(row.reason),
      estimatedSet: row.estimated_set === null ? null : Number(row.estimated_set), reservationId: row.reservation_id === null ? null : String(row.reservation_id), createdAt: String(row.created_at),
    }));
  }

  averageSetEstimate(agent: AgentRun['agent'], model: string): number | null {
    const rows = this.database.prepare(`SELECT input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
      FROM agent_runs
      WHERE agent = ? AND model = ? AND status = 'completed'
        AND (input_tokens IS NOT NULL OR cache_creation_input_tokens IS NOT NULL OR cache_read_input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`)
      .all(agent, model) as Array<{ input_tokens: number | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; output_tokens: number | null }>;
    if (!rows.length) return null;
    return rows.reduce((total, row) => total + sonnetEquivalentTokens(agent, model, {
      inputTokens: row.input_tokens, cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens, outputTokens: row.output_tokens,
    }), 0) / rows.length;
  }

  private autonomousSpentSet(provider: AgentRun['agent'], windowStart: string, windowEnd: string): number {
    const rows = this.database.prepare(`SELECT model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
      FROM agent_runs
      WHERE agent = ? AND origin = 'autonomous' AND created_at >= ? AND created_at < ?
        AND (input_tokens IS NOT NULL OR cache_creation_input_tokens IS NOT NULL OR cache_read_input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`)
      .all(provider, windowStart, windowEnd) as Array<{ model: string | null; input_tokens: number | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; output_tokens: number | null }>;
    return rows.reduce((total, row) => total + sonnetEquivalentTokens(provider, row.model, {
      inputTokens: row.input_tokens, cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens, outputTokens: row.output_tokens,
    }), 0);
  }

  heldBudgetReservationSet(provider: 'claude' | 'codex', windowStart: string): number {
    const row = this.database.prepare(`SELECT COALESCE(SUM(reserved_set), 0) AS total FROM budget_reservations
      WHERE provider = ? AND status = 'held' AND (window_start = ? OR (window_start IS NULL AND created_at >= ?))`)
      .get(provider, windowStart, windowStart) as { total: number };
    return Number(row.total);
  }

  /**
   * Atomically verifies the remaining autonomous budget and creates its hold.
   * Committed usage and held reservations are both read after BEGIN IMMEDIATE,
   * so concurrent callers cannot reuse a stale allowance calculation.
   */
  tryReserveAutonomousBudget(input: {
    provider: 'claude' | 'codex'; model: string; workItemId: string;
    requiredTokenCount: number; budgetTokenLimit: number;
    windowStart: string; windowEnd: string; now?: string;
  }): { approved: true; reservationId: string; spentSet: number; heldSet: number } | { approved: false; spentSet: number; heldSet: number } {
    return this.unitOfWork.transaction(() => {
      const held = this.heldBudgetReservationSet(input.provider, input.windowStart);
      const spent = this.autonomousSpentSet(input.provider, input.windowStart, input.windowEnd);
      if (spent + held + input.requiredTokenCount > input.budgetTokenLimit) return { approved: false, spentSet: spent, heldSet: held };

      const reservationId = randomUUID();
      this.database.prepare(`INSERT INTO budget_reservations
        (id, provider, origin, model, work_item_id, reserved_set, status, window_start, window_end, created_at)
        VALUES (?, ?, 'autonomous', ?, ?, ?, 'held', ?, ?, ?)`)
        .run(reservationId, input.provider, input.model, input.workItemId, input.requiredTokenCount, input.windowStart, input.windowEnd, input.now ?? new Date().toISOString());
      return { approved: true, reservationId, spentSet: spent, heldSet: held };
    });
  }

  attachBudgetReservationToRun(reservationId: string, agentRunId: string): boolean {
    const changed = this.database.prepare(`UPDATE budget_reservations SET agent_run_id = ?
      WHERE id = ? AND status = 'held' AND agent_run_id IS NULL
        AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND origin = 'autonomous')`)
      .run(agentRunId, reservationId, agentRunId).changes;
    return Number(changed) === 1;
  }

  reconcileAutonomousBudget(agentRunId: string, now = new Date().toISOString()): { actualSet: number; alarmTriggered: boolean } | null {
    return this.unitOfWork.transaction(() => {
      const reservation = this.database.prepare(`SELECT id, provider, window_start, window_end, status, actual_set, alarm_triggered
        FROM budget_reservations WHERE agent_run_id = ?`).get(agentRunId) as {
        id: string; provider: AgentRun['agent']; window_start: string | null; window_end: string | null;
        status: 'held' | 'committed' | 'released'; actual_set: number | null; alarm_triggered: number;
      } | undefined;
      if (!reservation) return null;
      if (reservation.status === 'committed' && reservation.actual_set !== null) {
        return { actualSet: Number(reservation.actual_set), alarmTriggered: reservation.alarm_triggered === 1 };
      }
      if (reservation.status !== 'held' || !reservation.window_start || !reservation.window_end) return null;
      const run = this.database.prepare(`SELECT agent, origin, status, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
        FROM agent_runs WHERE id = ?`).get(agentRunId) as {
        agent: AgentRun['agent']; origin: AgentRun['origin']; status: AgentRun['status']; model: string | null;
        input_tokens: number | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; output_tokens: number | null;
      } | undefined;
      if (!run || run.origin !== 'autonomous' || run.agent !== reservation.provider || !['completed', 'failed', 'canceled'].includes(run.status)) return null;
      const actualSet = sonnetEquivalentTokens(run.agent, run.model, {
        inputTokens: run.input_tokens, cacheCreationInputTokens: run.cache_creation_input_tokens,
        cacheReadInputTokens: run.cache_read_input_tokens, outputTokens: run.output_tokens,
      });
      const policy = this.getAutonomyPolicy();
      const providerPolicy = policy.providers[reservation.provider];
      const spentSet = this.autonomousSpentSet(reservation.provider, reservation.window_start, reservation.window_end);
      const alarmTriggered = Boolean(providerPolicy && spentSet >= providerPolicy.weeklyCeilingSet * policy.alarmFraction);
      this.database.prepare(`UPDATE budget_reservations
        SET status = 'committed', actual_set = ?, reconciled_at = ?, alarm_triggered = ?
        WHERE id = ? AND status = 'held'`)
        .run(actualSet, now, Number(alarmTriggered), reservation.id);
      return { actualSet, alarmTriggered };
    });
  }

  createBudgetReservation(input: { provider: 'claude' | 'codex'; model: string; workItemId: string; agentRunId?: string; reservedSet: number }): void {
    this.database.prepare(`INSERT INTO budget_reservations (id, provider, origin, model, work_item_id, agent_run_id, reserved_set, status, created_at)
      VALUES (?, ?, 'autonomous', ?, ?, ?, ?, 'held', ?)`)
      .run(randomUUID(), input.provider, input.model, input.workItemId, input.agentRunId ?? null, input.reservedSet, new Date().toISOString());
  }

  /** Token usage for every run created since `sinceIso`, for the usage meter. Not scoped to one work item. */
  listAgentRunUsageSince(sinceIso: string): Array<{ agent: AgentRun['agent']; origin: AgentRun['origin']; model: string | null; inputTokens: number | null; cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null; outputTokens: number | null }> {
    return (this.database.prepare(`
      SELECT agent, origin, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
      FROM agent_runs
      WHERE created_at >= ?
    `).all(sinceIso) as Array<{ agent: AgentRun['agent']; origin: AgentRun['origin']; model: string | null; input_tokens: number | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; output_tokens: number | null }>)
      .map((row) => ({ agent: row.agent, origin: row.origin, model: row.model, inputTokens: row.input_tokens, cacheCreationInputTokens: row.cache_creation_input_tokens, cacheReadInputTokens: row.cache_read_input_tokens, outputTokens: row.output_tokens }));
  }

  createUsageCalibration(input: { provider: UsageCalibration['provider']; observedAt: string; observedPercentage: number; resetsAt: string | null; workbenchSet: number; interactiveSet: number; computedCeilingSet: number }): UsageCalibration {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO usage_calibrations (id, provider, observed_at, observed_percentage, resets_at, workbench_set, interactive_set, computed_ceiling_set, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.provider, input.observedAt, input.observedPercentage, input.resetsAt, input.workbenchSet, input.interactiveSet, input.computedCeilingSet, createdAt);
    return { id, provider: input.provider, observedAt: input.observedAt, observedPercentage: input.observedPercentage, resetsAt: input.resetsAt, workbenchSet: input.workbenchSet, interactiveSet: input.interactiveSet, computedCeilingSet: input.computedCeilingSet, createdAt };
  }

  /** Most recent calibration for `provider` observed at or before `asOfIso`, or null if none exists. */
  getLatestUsageCalibration(provider: UsageCalibration['provider'], asOfIso: string): UsageCalibration | null {
    const row = this.database.prepare(`
      SELECT * FROM usage_calibrations
      WHERE provider = ? AND observed_at <= ?
      ORDER BY observed_at DESC LIMIT 1
    `).get(provider, asOfIso) as UsageCalibrationRow | undefined;
    return row ? mapUsageCalibrationRow(row) : null;
  }

  listUsageCalibrations(provider: UsageCalibration['provider'], limit = 20): UsageCalibration[] {
    const rows = this.database.prepare(`
      SELECT * FROM usage_calibrations
      WHERE provider = ?
      ORDER BY observed_at DESC LIMIT ?
    `).all(provider, Math.max(1, Math.min(200, limit))) as unknown as UsageCalibrationRow[];
    return rows.map(mapUsageCalibrationRow);
  }
}
