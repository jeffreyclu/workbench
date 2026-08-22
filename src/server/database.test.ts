import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';

/**
 * The full migration roster, in application order. Listed explicitly rather than
 * imported from the module under test so that renaming, reordering, or dropping a
 * migration fails here instead of silently agreeing with itself. Adding a
 * migration is expected to require one edit to this list.
 */
const EXPECTED_MIGRATIONS = [
  '001_base_schema',
  '002_legacy_schema_upgrade',
  '003_audit_log',
  '004_soft_delete_destructive_actions',
  '005_work_item_stack',
  '006_work_item_dependencies',
  '007_work_item_review',
  '008_provider_sync_overrides',
  '009_remove_memories',
  '010_durable_agent_run_cancellation',
  '011_agent_run_requested_agent',
  '012_work_item_links',
  '014_queue_versions',
  '015_durable_artifact_publication',
  '016_conversation_run_adoption',
  '017_durable_agent_handoffs',
  '018_structured_shared_brief',
  '019_editable_shared_brief',
];

describe('openDatabase', () => {
  let directory: string;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('removes legacy memory tables permanently', () => {
    const database = openDatabase(':memory:');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memories', 'shared_memories')").all();
    expect(tables).toEqual([]);
    database.close();
  });

  it('records each schema migration once instead of replaying upgrades at startup', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');

    const first = openDatabase(path);
    const firstMigrations = first.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>;
    expect(firstMigrations).toEqual(EXPECTED_MIGRATIONS.map((id) => ({ id })));
    first.close();

    // Reopening must not replay anything: the ledger stays exactly as the first
    // open left it, rather than merely matching some fixed number.
    const second = openDatabase(path);
    expect(second.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: EXPECTED_MIGRATIONS.length });
    second.close();
  });

  it('configures a bounded busy timeout and exposes write contention across two connections', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const first = openDatabase(path);
    const second = openDatabase(path);
    expect(first.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1000 });
    first.exec('BEGIN IMMEDIATE');
    second.exec('PRAGMA busy_timeout = 1');
    expect(() => second.prepare("UPDATE queue_versions SET version = version + 1 WHERE stack = 'attention'").run()).toThrow(/busy|locked/i);
    first.exec('ROLLBACK');
    first.close();
    second.close();
  });

  it('adds durable cancellation fields to agent runs', () => {
    const database = openDatabase(':memory:');
    const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cancel_requested', notnull: 1, dflt_value: '0' }),
      expect.objectContaining({ name: 'cancel_requested_at', notnull: 0 }),
    ]));
    database.close();
  });

  it('upgrades an unversioned legacy database before marking it current', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE work_items (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog', priority INTEGER NOT NULL DEFAULT 2,
      queue_position REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    legacy.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining(['is_queued', 'workspace_path', 'archived_at', 'stack']));
    expect(upgraded.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).toHaveLength(EXPECTED_MIGRATIONS.length);
    upgraded.close();
  });

  it('creates the requested-agent column for durable routing identity', () => {
    const database = openDatabase(':memory:');
    const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain('requested_agent');
    database.close();
  });

  it('adds immutable artifact content and recoverable deployment-operation state on upgrade', () => {
    const database = openDatabase(':memory:');
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_rendered_versions'").get()).toBeTruthy();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_deployment_operations'").get()).toBeTruthy();
    database.close();
  });

  it('upgrades a database recorded through the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE artifact_rendered_versions; DROP TABLE artifact_deployment_operations; DROP INDEX idx_agent_runs_adopted_conversation;');
    current.prepare("DELETE FROM schema_migrations WHERE id IN ('015_durable_artifact_publication', '016_conversation_run_adoption')").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_rendered_versions'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '015_durable_artifact_publication'").get()).toBeTruthy();
    expect((upgraded.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('adopted_conversation_id');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runs_adopted_conversation'").get()).toBeTruthy();
    upgraded.close();
  });

  it('creates an append-only audit_log table with the expected columns and category constraint', () => {
    const database = openDatabase(':memory:');
    const columns = database.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id', 'category', 'source', 'detail', 'work_item_id', 'created_at',
    ]));
    database.prepare(`
      INSERT INTO audit_log (id, category, source, detail, work_item_id, created_at)
      VALUES ('a1', 'outbound_call', 'linear', 'detail', NULL, '2026-01-01T00:00:00.000Z')
    `).run();
    expect(() => database.prepare(`
      INSERT INTO audit_log (id, category, source, detail, work_item_id, created_at)
      VALUES ('a2', 'not_a_category', 'linear', 'detail', NULL, '2026-01-01T00:00:00.000Z')
    `).run()).toThrow();
    database.close();
  });

  it('accepts destructive_action as an audit category and adds deleted_at soft-delete columns', () => {
    const database = openDatabase(':memory:');
    expect(() => database.prepare(`
      INSERT INTO audit_log (id, category, source, detail, work_item_id, created_at)
      VALUES ('a1', 'destructive_action', 'workbench', 'Deleted work item x', NULL, '2026-01-01T00:00:00.000Z')
    `).run()).not.toThrow();

    for (const table of ['work_items', 'shared_conversations', 'source_connections']) {
      const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toContain('deleted_at');
    }
    database.close();
  });

  it('rejects a database created by a newer Workbench build', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const database = openDatabase(path);
    database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('999_future_schema', new Date().toISOString());
    database.close();

    expect(() => openDatabase(path)).toThrow('newer than this Workbench build');
  });
});
