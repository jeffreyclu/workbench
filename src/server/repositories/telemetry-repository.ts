import { randomUUID } from 'node:crypto';

import type { AuditLogEntry, AuditLogPage, DiagnosticEvent } from '../../shared/contracts.js';
import type { UnitOfWork } from '../unit-of-work.js';

/** Audit and diagnostic persistence for Workbench operations. */
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
}
