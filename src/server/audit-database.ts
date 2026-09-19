import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const AUDIT_SCHEMA = 'audit_store';

/**
 * Audit events are operational telemetry, not durable conversation memory.
 * Keep them in a physically separate SQLite file while attaching that file to
 * the existing connection so callers retain one synchronous persistence API.
 */
export function auditDatabasePath(mainDatabasePath: string): string {
  if (mainDatabasePath === ':memory:') return ':memory:';
  const configured = process.env.AUDIT_DATABASE_PATH?.trim();
  return configured ? resolve(configured) : join(dirname(mainDatabasePath), 'workbench-audit.db');
}

export function attachAuditDatabase(database: DatabaseSync, mainDatabasePath: string): void {
  const path = auditDatabasePath(mainDatabasePath);
  if (path !== ':memory:' && resolve(path) === resolve(mainDatabasePath)) {
    throw new Error('AUDIT_DATABASE_PATH must be different from DATABASE_PATH.');
  }

  database.prepare(`ATTACH DATABASE ? AS ${AUDIT_SCHEMA}`).run(path);
  database.exec(`
    PRAGMA ${AUDIT_SCHEMA}.journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ${AUDIT_SCHEMA}.schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationId = '001_audit_store';
  const applied = database.prepare(`SELECT 1 FROM ${AUDIT_SCHEMA}.schema_migrations WHERE id = ?`).get(migrationId);
  if (!applied) {
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(`
        CREATE TABLE ${AUDIT_SCHEMA}.audit_log (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL CHECK (category IN ('outbound_call', 'agent_file_read', 'agent_file_write', 'agent_tool_use', 'destructive_action', 'api_mutation')),
          source TEXT NOT NULL,
          detail TEXT NOT NULL,
          work_item_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX ${AUDIT_SCHEMA}.idx_audit_log_created
          ON audit_log(created_at DESC);
        CREATE INDEX ${AUDIT_SCHEMA}.idx_audit_log_category
          ON audit_log(category, created_at DESC);
        CREATE INDEX ${AUDIT_SCHEMA}.idx_audit_log_work_item
          ON audit_log(work_item_id, created_at DESC);
      `);
      database.prepare(`INSERT INTO ${AUDIT_SCHEMA}.schema_migrations (id, applied_at) VALUES (?, ?)`)
        .run(migrationId, new Date().toISOString());
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  const importStateMigrationId = '002_legacy_import_watermark';
  const importStateApplied = database.prepare(`SELECT 1 FROM ${AUDIT_SCHEMA}.schema_migrations WHERE id = ?`).get(importStateMigrationId);
  if (!importStateApplied) {
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(`CREATE TABLE ${AUDIT_SCHEMA}.legacy_import_state (
        source TEXT PRIMARY KEY,
        last_created_at TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );`);
      database.prepare(`INSERT INTO ${AUDIT_SCHEMA}.schema_migrations (id, applied_at) VALUES (?, ?)`)
        .run(importStateMigrationId, new Date().toISOString());
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  // Compatibility import for databases created before audit storage was
  // split. INSERT OR IGNORE makes reopening idempotent and also captures any
  // final rows written by an older runtime during a rolling handoff.
  const legacyTable = database.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
  if (legacyTable) {
    const state = database.prepare(`SELECT last_created_at FROM ${AUDIT_SCHEMA}.legacy_import_state WHERE source = 'main.audit_log'`)
      .get() as { last_created_at: string } | undefined;
    if (state) {
      database.prepare(`
        INSERT OR IGNORE INTO ${AUDIT_SCHEMA}.audit_log (id, category, source, detail, work_item_id, created_at)
        SELECT id, category, source, detail, work_item_id, created_at FROM main.audit_log
        WHERE created_at >= ?
      `).run(state.last_created_at);
    } else {
      database.exec(`
        INSERT OR IGNORE INTO ${AUDIT_SCHEMA}.audit_log (id, category, source, detail, work_item_id, created_at)
        SELECT id, category, source, detail, work_item_id, created_at FROM main.audit_log;
      `);
    }
    const latest = database.prepare('SELECT MAX(created_at) AS created_at FROM main.audit_log').get() as { created_at: string | null };
    if (latest.created_at) {
      database.prepare(`INSERT INTO ${AUDIT_SCHEMA}.legacy_import_state (source, last_created_at, imported_at)
        VALUES ('main.audit_log', ?, ?)
        ON CONFLICT(source) DO UPDATE SET last_created_at = excluded.last_created_at, imported_at = excluded.imported_at`)
        .run(latest.created_at, new Date().toISOString());
    }
  }
}

export const AUDIT_DATABASE_SCHEMA = AUDIT_SCHEMA;
