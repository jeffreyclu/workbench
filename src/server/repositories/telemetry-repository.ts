import { randomUUID } from 'node:crypto';

import type { AgentRun, AuditLogEntry, AuditLogPage, DiagnosticEvent, UsageCalibration } from '../../shared/contracts.js';
import { estimateModelCost } from '../model-pricing.js';
import type { UnitOfWork } from '../unit-of-work.js';

interface UsageCalibrationRow {
  id: string; provider: UsageCalibration['provider']; observed_at: string; observed_percentage: number;
  workbench_set: number; interactive_set: number; computed_ceiling_set: number; created_at: string;
}

function mapUsageCalibrationRow(row: UsageCalibrationRow): UsageCalibration {
  return {
    id: row.id, provider: row.provider, observedAt: row.observed_at, observedPercentage: row.observed_percentage,
    workbenchSet: row.workbench_set, interactiveSet: row.interactive_set, computedCeilingSet: row.computed_ceiling_set,
    createdAt: row.created_at,
  };
}

/**
 * Audit trail, diagnostics, cost backfill, and autonomous-budget bookkeeping.
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
      SELECT id, agent, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM agent_runs
      WHERE estimated_cost_usd IS NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
    `).all() as Array<{ id: string; agent: 'codex' | 'claude'; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null }>;
    const messages = this.database.prepare(`
      SELECT id, author, model, input_tokens, output_tokens FROM shared_messages
      WHERE estimated_cost_usd IS NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
        AND author IN ('codex', 'claude')
    `).all() as Array<{ id: string; author: 'codex' | 'claude'; model: string | null; input_tokens: number | null; output_tokens: number | null }>;
    const updateRun = this.database.prepare('UPDATE agent_runs SET estimated_cost_usd = ? WHERE id = ?');
    const updateMessage = this.database.prepare('UPDATE shared_messages SET estimated_cost_usd = ? WHERE id = ?');
    let filled = 0;
    this.unitOfWork.transaction(() => {
      for (const row of rows) {
        const cost = estimateModelCost(row.agent, row.model, row.input_tokens, row.output_tokens, row.cache_creation_input_tokens, row.cache_read_input_tokens);
        if (cost === null) continue;
        updateRun.run(cost, row.id);
        filled += 1;
      }
      for (const row of messages) {
        const cost = estimateModelCost(row.author, row.model, row.input_tokens, row.output_tokens, null, null);
        if (cost === null) continue;
        updateMessage.run(cost, row.id);
        filled += 1;
      }
    });
    return filled;
  }

  averageSetEstimate(agent: AgentRun['agent'], model: string): number | null {
    const row = this.database.prepare(`SELECT AVG(input_tokens + 5 * output_tokens) AS estimate
      FROM agent_runs WHERE agent = ? AND model = ? AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL`).get(agent, model) as { estimate: number | null };
    return row.estimate === null ? null : Number(row.estimate);
  }

  heldBudgetReservationSet(provider: 'claude' | 'codex', sinceIso: string): number {
    const row = this.database.prepare("SELECT COALESCE(SUM(reserved_set), 0) AS total FROM budget_reservations WHERE provider = ? AND status = 'held' AND created_at >= ?").get(provider, sinceIso) as { total: number };
    return Number(row.total);
  }

  /**
   * Atomically verifies the remaining autonomous budget and creates its hold.
   * The caller supplies already-measured committed usage; concurrent callers
   * are serialized by this transaction and see each other's held amounts.
   */
  tryReserveAutonomousBudget(input: {
    provider: 'claude' | 'codex'; model: string; workItemId: string;
    requiredTokenCount: number; spentTokenCount: number; budgetTokenLimit: number;
    windowStart: string; now?: string;
  }): { reservationId: string } | null {
    return this.unitOfWork.transaction(() => {
      const held = this.heldBudgetReservationSet(input.provider, input.windowStart);
      if (input.spentTokenCount + held + input.requiredTokenCount > input.budgetTokenLimit) return null;

      const reservationId = randomUUID();
      this.database.prepare(`INSERT INTO budget_reservations (id, provider, origin, model, work_item_id, reserved_set, status, created_at)
        VALUES (?, ?, 'autonomous', ?, ?, ?, 'held', ?)`)
        .run(reservationId, input.provider, input.model, input.workItemId, input.requiredTokenCount, input.now ?? new Date().toISOString());
      return { reservationId };
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

  createUsageCalibration(input: { provider: UsageCalibration['provider']; observedAt: string; observedPercentage: number; workbenchSet: number; interactiveSet: number; computedCeilingSet: number }): UsageCalibration {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO usage_calibrations (id, provider, observed_at, observed_percentage, workbench_set, interactive_set, computed_ceiling_set, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.provider, input.observedAt, input.observedPercentage, input.workbenchSet, input.interactiveSet, input.computedCeilingSet, createdAt);
    return { id, provider: input.provider, observedAt: input.observedAt, observedPercentage: input.observedPercentage, workbenchSet: input.workbenchSet, interactiveSet: input.interactiveSet, computedCeilingSet: input.computedCeilingSet, createdAt };
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
