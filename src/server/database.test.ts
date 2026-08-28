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
  '020_api_mutation_audit',
  '021_agent_run_origin',
  '022_workspace_run_leases',
  '023_usage_calibrations',
  '024_budget_reservations',
  '025_workbench_is_attention_focus',
  '026_budget_reservation_run_link',
  '027_project_registry',
  '028_agent_run_cost_provenance',
  '029_agent_run_token_breakdown',
  '030_work_item_version',
  '031_memory_index',
  '032_work_item_lifecycle_events',
  '033_agent_run_account_profile',
  '034_shared_message_token_breakdown',
  '035_shared_message_account_profile',
  '036_usage_calibration_resets_at',
  '037_autonomy_governor_policy',
  '038_machine_discovery_proposals',
  '039_shared_message_retrieved_memory_count',
  '040_shared_messages_conversation_author_created_index',
  '041_work_item_attachments',
  '042_shared_message_retrieved_memory_detail',
  '043_shared_conversation_draft_body',
  '044_shared_conversation_composer_preferences',
  '045_shared_message_queue_priority',
  '046_artifact_comment_anchors',
  '047_shared_message_dispatch_group',
  '048_agent_stream_events',
  '049_shared_message_interjection_stream_offset',
  '050_session_feedback_decision_tree_snapshot',
  '051_shared_conversation_claude_session_id',
  '052_workspace_diff_snapshots',
  '053_shared_conversation_codex_thread_id',
  '054_agent_run_diagnostics',
  '055_shared_conversation_pinning',
  '056_diff_confidence_cache',
  '057_shared_conversation_workspace_selection',
  '058_work_item_workspace_selection',
  '059_diff_hunk_reviews',
  '060_workspace_diff_snapshot_provenance',
  '061_agent_run_review_handoffs',
  '062_agent_run_review_handoffs_immutable',
  '063_shared_conversation_manual_position',
  '064_review_assist_cache',
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

  it('keeps the recorded conversation-position migration compatible on upgrade', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP INDEX idx_shared_conversations_manual_position; ALTER TABLE shared_conversations DROP COLUMN manual_position;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '063_shared_conversation_manual_position'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('manual_position');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_shared_conversations_manual_position'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds composer preferences when upgrading from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec(`
      ALTER TABLE shared_conversations DROP COLUMN preferred_account_profile;
      ALTER TABLE shared_conversations DROP COLUMN preferred_dispatch_target;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '044_shared_conversation_composer_preferences'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['preferred_execution_profile', 'preferred_account_profile', 'preferred_dispatch_target']));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '044_shared_conversation_composer_preferences'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds artifact-comment anchors when upgrading from migration 045', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP INDEX idx_artifact_comments_anchor; ALTER TABLE artifact_comments DROP COLUMN anchor;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '046_artifact_comment_anchors'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(artifact_comments)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('anchor');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_artifact_comments_anchor'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds server-persisted conversation workspace selection on upgrade', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare("DELETE FROM schema_migrations WHERE id = '057_shared_conversation_workspace_selection'").run();
    current.exec('DROP TABLE shared_conversation_workspace_selection;');
    current.close();
    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shared_conversation_workspace_selection'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '057_shared_conversation_workspace_selection'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds persistent diff hunk review state when upgrading from migration 058', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare("DELETE FROM schema_migrations WHERE id = '059_diff_hunk_reviews'").run();
    current.exec('DROP TABLE diff_hunk_reviews;');
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diff_hunk_reviews'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '059_diff_hunk_reviews'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the conversation draft body when upgrading from migration 042', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE shared_conversations DROP COLUMN draft_body;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '043_shared_conversation_draft_body'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('draft_body');
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

  it('adds the retrieved-memory-count column when upgrading from migration 038', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE shared_messages DROP COLUMN retrieved_memory_count;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '039_shared_message_retrieved_memory_count'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('retrieved_memory_count');
    upgraded.close();
  });

  it('adds the conversation/author/created-at index when upgrading from migration 039', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP INDEX idx_shared_messages_conv_author_created;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '040_shared_messages_conversation_author_created_index'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_shared_messages_conv_author_created'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds task attachments when upgrading from migration 040', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE work_items DROP COLUMN attachments_json;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '041_work_item_attachments'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('attachments_json');
    upgraded.close();
  });

  it('adds the retrieved-memory-detail column when upgrading from migration 041', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE shared_messages DROP COLUMN retrieved_memory_detail_json;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '042_shared_message_retrieved_memory_detail'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('retrieved_memory_detail_json');
    upgraded.close();
  });

  it('adds queue priority when upgrading from migration 044', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP INDEX idx_shared_messages_queue_priority; ALTER TABLE shared_messages DROP COLUMN queue_priority;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '045_shared_message_queue_priority'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('queue_priority');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_shared_messages_queue_priority'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the structured lifecycle ledger when upgrading from migration 031', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE work_item_lifecycle_events;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '032_work_item_lifecycle_events'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(work_item_lifecycle_events)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'work_item_id', 'transition', 'from_status', 'to_status', 'is_initial', 'actor', 'source', 'reason', 'occurred_at',
    ]));
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_lifecycle_events_export'").get()).toBeTruthy();
    upgraded.close();
  });

  it('collapses legacy Workbench queue membership into the attention queue on upgrade', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare("INSERT INTO work_items (id, title, description, status, priority, queue_position, source, is_queued, stack, created_at, updated_at, last_touched_at) VALUES ('legacy-workbench', 'Legacy', '', 'ready', 2, 1, 'manual', 1, 'workbench', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')").run();
    current.prepare("DELETE FROM schema_migrations WHERE id = '025_workbench_is_attention_focus'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT stack FROM work_items WHERE id = 'legacy-workbench'").get()).toEqual({ stack: 'attention' });
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '025_workbench_is_attention_focus'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the calibration reset-date column when upgrading from migration 035', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE usage_calibrations DROP COLUMN resets_at;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '036_usage_calibration_resets_at'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(usage_calibrations)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('resets_at');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '036_usage_calibration_resets_at'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds stored governor policy and reconciliation fields when upgrading from migration 036', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec(`
      DROP TABLE autonomy_governor_decisions;
      DROP TABLE autonomy_provider_policy;
      DROP TABLE autonomy_policy;
      DROP INDEX idx_budget_reservations_window;
      ALTER TABLE budget_reservations DROP COLUMN alarm_triggered;
      ALTER TABLE budget_reservations DROP COLUMN reconciled_at;
      ALTER TABLE budget_reservations DROP COLUMN actual_set;
      ALTER TABLE budget_reservations DROP COLUMN window_end;
      ALTER TABLE budget_reservations DROP COLUMN window_start;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '037_autonomy_governor_policy'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '037_autonomy_governor_policy'").get()).toBeTruthy();
    expect(upgraded.prepare('SELECT global_enabled, target_fraction, alarm_fraction FROM autonomy_policy WHERE id = 1').get())
      .toEqual({ global_enabled: 0, target_fraction: 0.16, alarm_fraction: 0.2 });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'autonomy_provider_policy'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'autonomy_governor_decisions'").get()).toBeTruthy();
    const reservationColumns = (upgraded.prepare('PRAGMA table_info(budget_reservations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(reservationColumns).toEqual(expect.arrayContaining(['window_start', 'window_end', 'actual_set', 'reconciled_at', 'alarm_triggered']));
    upgraded.close();
  });

  it('adds machine-proposal metadata when upgrading from migration 037', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec(`
      DROP INDEX idx_work_items_machine_proposal_window;
      ALTER TABLE work_items DROP COLUMN proposal_rationale;
      ALTER TABLE work_items DROP COLUMN suggested_queue_position;
      ALTER TABLE work_items DROP COLUMN suggested_priority;
      ALTER TABLE work_items DROP COLUMN machine_proposal_window_start;
      ALTER TABLE work_items DROP COLUMN machine_proposal_run_id;
      ALTER TABLE work_items DROP COLUMN machine_proposed;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '038_machine_discovery_proposals'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'machine_proposed', 'machine_proposal_run_id', 'machine_proposal_window_start',
      'suggested_priority', 'suggested_queue_position', 'proposal_rationale',
    ]));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '038_machine_discovery_proposals'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_items_machine_proposal_window'").get()).toBeTruthy();
    upgraded.close();
  });

  it('registers the canonical project vocabulary and collapses spelling variants on upgrade', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    const insert = (id: string, projectName: string, updatedAt: string) => current
      .prepare(`INSERT INTO work_items (id, title, description, status, priority, queue_position, source, is_queued, project_name, created_at, updated_at, last_touched_at)
        VALUES (?, 'Task', '', 'ready', 2, 1, 'manual', 1, ?, '2026-08-23T00:00:00.000Z', ?, ?)`)
      .run(id, projectName, updatedAt, updatedAt);
    insert('variant-a', 'Workbench', '2026-08-23T00:00:00.000Z');
    insert('variant-b', 'Workbench', '2026-08-23T00:00:01.000Z');
    insert('variant-c', 'work bench', '2026-08-23T00:00:02.000Z');
    insert('variant-d', 'workbench', '2026-08-23T00:00:03.000Z');
    insert('distinct', 'Connectors', '2026-08-23T00:00:04.000Z');
    // Rebuild the pre-027 shape: existing databases have already recorded the
    // preceding migration set, so the upgrade must run against that, not a
    // fresh schema.
    current.exec('DROP INDEX IF EXISTS idx_work_items_project_key; DROP TABLE project_aliases; DROP TABLE projects;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '027_project_registry'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '027_project_registry'").get()).toBeTruthy();
    expect((upgraded.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('project_key');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_items_project_key'").get()).toBeTruthy();

    // The spelling on the most tasks wins, and every variant now reads the same.
    expect(upgraded.prepare("SELECT DISTINCT project_name AS name FROM work_items WHERE project_key = 'workbench'").all())
      .toEqual([{ name: 'Workbench' }]);
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM work_items WHERE project_key = 'workbench'").get()).toEqual({ count: 4 });
    expect(upgraded.prepare("SELECT name, key FROM projects ORDER BY key").all())
      .toEqual([{ name: 'Connectors', key: 'connectors' }, { name: 'Workbench', key: 'workbench' }]);
    upgraded.close();
  });

  it('adds cost provenance on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE agent_runs DROP COLUMN cost_source; ALTER TABLE shared_messages DROP COLUMN cost_source;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '028_agent_run_cost_provenance'").run();
    current.close();

    const upgraded = openDatabase(path);
    const runColumns = (upgraded.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name);
    const messageColumns = (upgraded.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(runColumns).toContain('cost_source');
    expect(messageColumns).toContain('cost_source');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '028_agent_run_cost_provenance'").get()).toBeTruthy();
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

  it('adds per-message agent stream events on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE agent_stream_events;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '048_agent_stream_events'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(agent_stream_events)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['message_id', 'run_id', 'kind', 'detail', 'created_at']));
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_stream_events_message_created'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds compact per-run diagnostics on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE agent_run_diagnostics;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '054_agent_run_diagnostics'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(agent_run_diagnostics)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['run_id', 'message_id', 'agent', 'kind', 'detail_json', 'created_at']));
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_run_diagnostics_run_created'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds persistent conversation pins on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare('DROP INDEX idx_shared_conversations_pinned_updated').run();
    current.prepare("DELETE FROM schema_migrations WHERE id = '055_shared_conversation_pinning'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('pinned');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '055_shared_conversation_pinning'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_shared_conversations_pinned_updated'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the diff confidence cache table on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE diff_confidence_cache;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '056_diff_confidence_cache'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(diff_confidence_cache)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['hash', 'risk', 'reasoning', 'created_at']));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '056_diff_confidence_cache'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the review assist cache table on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE review_assist_cache;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '064_review_assist_cache'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(review_assist_cache)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['hash', 'answer', 'created_at']));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '064_review_assist_cache'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds persisted Task View repository selection on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE work_item_workspace_selection;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '058_work_item_workspace_selection'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(work_item_workspace_selection)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['work_item_id', 'workspace_path', 'updated_at']));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '058_work_item_workspace_selection'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the persisted live-interjection boundary when upgrading from migration 048', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare("DELETE FROM schema_migrations WHERE id = '049_shared_message_interjection_stream_offset'").run();
    current.exec('ALTER TABLE shared_messages DROP COLUMN interjection_stream_offset;');
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('interjection_stream_offset');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '049_shared_message_interjection_stream_offset'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds session-feedback snapshots when upgrading from migration 049', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE session_feedback;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '050_session_feedback_decision_tree_snapshot'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(session_feedback)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['conversation_id', 'work_item_id', 'rating', 'decision_tree_json', 'created_at']));
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_feedback_conversation'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_feedback_work_item'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the claude session id column when upgrading from migration 050', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare("DELETE FROM schema_migrations WHERE id = '051_shared_conversation_claude_session_id'").run();
    current.exec('ALTER TABLE shared_conversations DROP COLUMN claude_session_id;');
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('claude_session_id');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '051_shared_conversation_claude_session_id'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds immutable workspace diff snapshots when upgrading from migration 051', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE workspace_diff_snapshots;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '052_workspace_diff_snapshots'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_diff_snapshots'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_diff_snapshots_work_item_captured'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '052_workspace_diff_snapshots'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the Codex thread id column when upgrading from migration 052', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare("DELETE FROM schema_migrations WHERE id = '053_shared_conversation_codex_thread_id'").run();
    current.exec('ALTER TABLE shared_conversations DROP COLUMN codex_thread_id;');
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('codex_thread_id');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '053_shared_conversation_codex_thread_id'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds immutable snapshot provenance when upgrading from migration 059', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP INDEX idx_workspace_diff_snapshots_agent_run;');
    current.exec('ALTER TABLE workspace_diff_snapshots DROP COLUMN originating_agent_run_id;');
    current.exec('ALTER TABLE workspace_diff_snapshots DROP COLUMN commit_hash;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '060_workspace_diff_snapshot_provenance'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(workspace_diff_snapshots)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('originating_agent_run_id');
    expect(columns).toContain('commit_hash');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_diff_snapshots_agent_run'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '060_workspace_diff_snapshot_provenance'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds structured review handoffs when upgrading from migration 060', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE agent_run_review_handoffs;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '061_agent_run_review_handoffs'").run();
    current.prepare("DELETE FROM schema_migrations WHERE id = '062_agent_run_review_handoffs_immutable'").run();
    expect(current.prepare("SELECT id FROM schema_migrations WHERE id = '060_workspace_diff_snapshot_provenance'").get())
      .toEqual({ id: '060_workspace_diff_snapshot_provenance' });
    current.close();

    const upgraded = openDatabase(path);
    const columns = upgraded.prepare('PRAGMA table_info(agent_run_review_handoffs)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      'agent_run_id',
      'format_version',
      'summary',
      'changes_json',
      'acceptance_criteria_json',
      'contract_changes_json',
      'verification_json',
      'uncertainties_json',
      'tradeoffs_json',
      'created_at',
    ]);
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'agent_run_id', pk: 1 }),
      expect.objectContaining({ name: 'format_version', notnull: 1, dflt_value: '1' }),
    ]));
    expect(upgraded.prepare('PRAGMA foreign_key_list(agent_run_review_handoffs)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'agent_runs', from: 'agent_run_id', to: 'id', on_delete: 'CASCADE' }),
    ]));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '061_agent_run_review_handoffs'").get())
      .toEqual({ id: '061_agent_run_review_handoffs' });

    upgraded.prepare(`
      INSERT INTO work_items (id, title, queue_position, created_at, updated_at)
      VALUES ('handoff-item', 'Review handoff', 1, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')
    `).run();
    upgraded.prepare(`
      INSERT INTO agent_runs (id, work_item_id, kind, requested_target, agent, status, created_at)
      VALUES ('handoff-run', 'handoff-item', 'coding', 'codex', 'codex', 'completed', '2026-08-27T00:00:00.000Z')
    `).run();
    upgraded.prepare(`
      INSERT INTO agent_run_review_handoffs (
        agent_run_id, summary, changes_json, acceptance_criteria_json,
        contract_changes_json, verification_json, uncertainties_json,
        tradeoffs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'handoff-run',
      'Added the structured review handoff schema.',
      '[{"path":"src/server/database.ts","summary":"Added migration","rationale":"Persist review evidence"}]',
      '[{"criterion":"Upgrade from migration 060","files":["src/server/database.test.ts"],"decisions":["Use one row per run"]}]',
      '[{"kind":"schema","summary":"Added agent_run_review_handoffs"}]',
      '[{"command":"vitest run src/server/database.test.ts","exitCode":0,"result":"passed"}]',
      '["Capture logic is a separate task"]',
      '[{"decision":"Use validated JSON sections","rationale":"The handoff is written and read as one document"}]',
      '2026-08-27T00:01:00.000Z',
    );
    expect(upgraded.prepare("SELECT format_version FROM agent_run_review_handoffs WHERE agent_run_id = 'handoff-run'").get())
      .toEqual({ format_version: 1 });
    expect(() => upgraded.prepare("UPDATE agent_run_review_handoffs SET summary = 'Rewritten' WHERE agent_run_id = 'handoff-run'").run())
      .toThrow(/immutable/i);

    upgraded.prepare("DELETE FROM agent_runs WHERE id = 'handoff-run'").run();
    expect(upgraded.prepare('SELECT count(*) AS count FROM agent_run_review_handoffs').get()).toEqual({ count: 0 });
    upgraded.close();
  });

  it('makes review handoffs immutable when upgrading from migration 061', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TRIGGER agent_run_review_handoffs_immutable;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '062_agent_run_review_handoffs_immutable'").run();
    expect(current.prepare("SELECT id FROM schema_migrations WHERE id = '061_agent_run_review_handoffs'").get())
      .toEqual({ id: '061_agent_run_review_handoffs' });
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '062_agent_run_review_handoffs_immutable'").get())
      .toEqual({ id: '062_agent_run_review_handoffs_immutable' });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_run_review_handoffs_immutable'").get())
      .toEqual({ name: 'agent_run_review_handoffs_immutable' });
    upgraded.close();
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

  it('upgrades the audit constraint from the preceding migration set for API mutation records', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec(`
      DROP TABLE audit_log;
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('outbound_call', 'agent_file_read', 'agent_file_write', 'agent_tool_use', 'destructive_action')),
        source TEXT NOT NULL,
        detail TEXT NOT NULL,
        work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
      CREATE INDEX idx_audit_log_category ON audit_log(category, created_at DESC);
      CREATE INDEX idx_audit_log_work_item ON audit_log(work_item_id, created_at DESC);
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '020_api_mutation_audit'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(() => upgraded.prepare(`
      INSERT INTO audit_log (id, category, source, detail, work_item_id, created_at)
      VALUES ('api-1', 'api_mutation', 'workbench_api', 'POST /api/work-items → 201', NULL, '2026-01-01T00:00:00.000Z')
    `).run()).not.toThrow();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '020_api_mutation_audit'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the origin column to agent_runs on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    // Simulate a database recorded through migration 020: rebuild agent_runs
    // exactly as it was before 021 added the origin column, then drop the
    // migration record so the next open() must re-run 021 for real.
    current.exec(`
      CREATE TABLE agent_runs_pre_origin AS SELECT
        id, work_item_id, kind, requested_target, requested_agent, agent, status,
        instructions, output, error, started_at, completed_at, created_at,
        conversation_id, message_id, model, execution_profile, input_tokens,
        output_tokens, estimated_cost_usd, fallback_from, fallback_reason,
        cancel_requested, cancel_requested_at
      FROM agent_runs;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_pre_origin RENAME TO agent_runs;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '021_agent_run_origin'").run();
    current.close();

    const raw = new DatabaseSync(path);
    const columnsBefore = (raw.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columnsBefore).not.toContain('origin');
    raw.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('origin');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '021_agent_run_origin'").get()).toBeTruthy();
    upgraded.prepare(`
      INSERT INTO agent_runs (id, work_item_id, kind, requested_target, requested_agent, agent, status, instructions, created_at)
      VALUES ('r1', 'w1', 'analysis', 'claude', 'claude', 'claude', 'queued', '', '2026-01-01T00:00:00.000Z')
    `).run();
    expect(upgraded.prepare("SELECT origin FROM agent_runs WHERE id = 'r1'").get()).toEqual({ origin: 'manual' });
    upgraded.close();
  });

  it('upgrades a database recorded through 021 with the workspace lease schema', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    // Simulate a database recorded through 021: rebuild agent_runs without the
    // resolved_workspace column, drop the lease table, then drop the migration
    // record so the next open() must re-run 022 for real.
    current.exec(`
      CREATE TABLE agent_runs_pre_leases AS SELECT
        id, work_item_id, kind, requested_target, requested_agent, agent, status,
        instructions, output, error, started_at, completed_at, created_at,
        conversation_id, message_id, model, execution_profile, input_tokens,
        output_tokens, estimated_cost_usd, fallback_from, fallback_reason,
        cancel_requested, cancel_requested_at, origin
      FROM agent_runs;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_pre_leases RENAME TO agent_runs;
      DROP TABLE IF EXISTS workspace_leases;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '022_workspace_run_leases'").run();
    current.close();

    const raw = new DatabaseSync(path);
    const columnsBefore = (raw.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columnsBefore).not.toContain('resolved_workspace');
    raw.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('resolved_workspace');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '022_workspace_run_leases'").get()).toBeTruthy();
    expect(() => upgraded.prepare(`
      INSERT INTO workspace_leases (workspace, run_id, owner_id, acquired_at, expires_at)
      VALUES ('/Users/jeffrey.lu/dev/workbench', 'r1', 'owner-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z')
    `).run()).not.toThrow();
    upgraded.close();
  });

  it('adds account_profile to runs upgraded from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec(`
      CREATE TABLE agent_runs_pre_account AS SELECT
        id, work_item_id, kind, requested_target, agent, status, instructions, output, error,
        started_at, completed_at, created_at, conversation_id, message_id, model, execution_profile,
        input_tokens, output_tokens, estimated_cost_usd, fallback_from, fallback_reason, owner_id,
        lease_expires_at, attempt, max_attempts, next_attempt_at, cancel_requested,
        cancel_requested_at, requested_agent, adopted_conversation_id, origin, resolved_workspace,
        cost_source, cache_creation_input_tokens, cache_read_input_tokens
      FROM agent_runs;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_pre_account RENAME TO agent_runs;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '033_agent_run_account_profile'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('account_profile');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '033_agent_run_account_profile'").get()).toBeTruthy();
    upgraded.prepare(`INSERT INTO agent_runs (id, work_item_id, kind, requested_target, agent, status, instructions, created_at)
      VALUES ('profile-run', 'w1', 'analysis', 'codex', 'codex', 'queued', '', '2026-01-01T00:00:00.000Z')`).run();
    expect(upgraded.prepare("SELECT account_profile FROM agent_runs WHERE id = 'profile-run'").get()).toEqual({ account_profile: 'default' });
    upgraded.close();
  });

  it('adds shared-message cache columns on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec(`
      CREATE TABLE shared_messages_pre_cache AS SELECT
        id, conversation_id, author, body, pinned, status, error, attachments_json,
        dispatch_target, created_at, completed_at, execution_profile, model,
        input_tokens, output_tokens, estimated_cost_usd, cost_source, fallback_from,
        fallback_reason, attempt, max_attempts, next_attempt_at, owner_id, lease_expires_at
      FROM shared_messages;
      DROP TABLE shared_messages;
      ALTER TABLE shared_messages_pre_cache RENAME TO shared_messages;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '034_shared_message_token_breakdown'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['cache_creation_input_tokens', 'cache_read_input_tokens']));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '034_shared_message_token_breakdown'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds account_profile to shared replies upgraded from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec(`
      CREATE TABLE shared_messages_pre_account AS SELECT
        id, conversation_id, author, body, pinned, status, error, attachments_json,
        dispatch_target, created_at, completed_at, execution_profile, model,
        input_tokens, output_tokens, estimated_cost_usd, cost_source, fallback_from,
        fallback_reason, attempt, max_attempts, next_attempt_at, owner_id, lease_expires_at,
        cache_creation_input_tokens, cache_read_input_tokens
      FROM shared_messages;
      DROP TABLE shared_messages;
      ALTER TABLE shared_messages_pre_account RENAME TO shared_messages;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '035_shared_message_account_profile'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('account_profile');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '035_shared_message_account_profile'").get()).toBeTruthy();
    upgraded.close();
  });

  it('upgrades a database recorded through 022 with the usage_calibrations table', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE IF EXISTS usage_calibrations;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '023_usage_calibrations'").run();
    current.close();

    const raw = new DatabaseSync(path);
    const tablesBefore = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_calibrations'").all();
    expect(tablesBefore).toEqual([]);
    raw.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '023_usage_calibrations'").get()).toBeTruthy();
    expect(() => upgraded.prepare(`
      INSERT INTO usage_calibrations (id, provider, observed_at, observed_percentage, workbench_set, interactive_set, computed_ceiling_set, created_at)
      VALUES ('c1', 'claude', '2026-08-19T12:00:00.000Z', 10, 15000, 0, 150000, '2026-08-19T12:00:00.000Z')
    `).run()).not.toThrow();
    upgraded.close();
  });

  it('upgrades a database recorded through 023 with the budget_reservations table', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE IF EXISTS budget_reservations;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '024_budget_reservations'").run();
    current.close();

    const raw = new DatabaseSync(path);
    const tablesBefore = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'budget_reservations'").all();
    expect(tablesBefore).toEqual([]);
    raw.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '024_budget_reservations'").get()).toBeTruthy();
    expect(() => upgraded.prepare(`
      INSERT INTO budget_reservations (id, provider, origin, model, work_item_id, reserved_set, status, created_at)
      VALUES ('b1', 'claude', 'autonomous', 'sonnet', 'w1', 107000, 'held', '2026-08-19T12:00:00.000Z')
    `).run()).not.toThrow();
    upgraded.close();
  });

  it('upgrades a database recorded through 025 with the budget reservation run link', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE budget_reservations RENAME TO budget_reservations_pre_run_link;');
    current.exec(`CREATE TABLE budget_reservations (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, origin TEXT NOT NULL, model TEXT NOT NULL,
      work_item_id TEXT NOT NULL, reserved_set REAL NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, released_at TEXT
    );`);
    current.exec('INSERT INTO budget_reservations SELECT id, provider, origin, model, work_item_id, reserved_set, status, created_at, released_at FROM budget_reservations_pre_run_link;');
    current.exec('DROP TABLE budget_reservations_pre_run_link;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '026_budget_reservation_run_link'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(budget_reservations)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('agent_run_id');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '026_budget_reservation_run_link'").get()).toBeTruthy();
    upgraded.close();
  });

  it('adds the work-item version column on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('ALTER TABLE work_items DROP COLUMN version;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '030_work_item_version'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('version');
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '030_work_item_version'").get()).toBeTruthy();
    upgraded.close();
  });

  it('rejects a database created by a newer Workbench build', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const database = openDatabase(path);
    database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('999_future_schema', new Date().toISOString());
    database.close();

    expect(() => openDatabase(path)).toThrow('newer than this Workbench build');
  });

  it('upgrades a database recorded through 028 with exact agent-run token fields', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.prepare("DELETE FROM schema_migrations WHERE id = '029_agent_run_token_breakdown'").run();
    current.close();

    const upgraded = openDatabase(path);
    const columns = (upgraded.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['cache_creation_input_tokens', 'cache_read_input_tokens']));
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '029_agent_run_token_breakdown'").get()).toBeTruthy();
    upgraded.close();
  });

  it('creates the memory index tables on upgrade from the preceding migration set', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    // Rebuild the pre-031 shape: existing databases have already recorded
    // migration 030 and nothing past it, so the upgrade must run against that.
    current.exec(`
      DROP TRIGGER IF EXISTS memory_chunks_fts_ai;
      DROP TRIGGER IF EXISTS memory_chunks_fts_au;
      DROP TRIGGER IF EXISTS memory_chunks_fts_ad;
      DROP TABLE IF EXISTS memory_chunks_fts;
      DROP TABLE IF EXISTS memory_chunks;
      DROP TABLE IF EXISTS memory_documents;
    `);
    current.prepare("DELETE FROM schema_migrations WHERE id = '031_memory_index'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_documents'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_chunks'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_chunks_fts'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '031_memory_index'").get()).toBeTruthy();

    // The FTS mirror stays in sync via triggers on memory_chunks, the same
    // convention as conversations_fts/messages_fts.
    upgraded.prepare("INSERT INTO memory_documents (id, source, source_id, conversation_id, work_item_id, actor, title, body, created_at, content_hash, indexed_at) VALUES ('doc-1', 'doc', 'readme.md', NULL, NULL, NULL, 'Readme', 'hello world', '2026-08-23T00:00:00.000Z', 'hash', NULL)").run();
    upgraded.prepare("INSERT INTO memory_chunks (document_id, ordinal, text, embedding, model, dims) VALUES ('doc-1', 0, 'hello world', NULL, NULL, NULL)").run();
    expect(upgraded.prepare("SELECT chunk_id FROM memory_chunks_fts WHERE memory_chunks_fts MATCH 'hello'").all()).toEqual([{ chunk_id: 1 }]);
    upgraded.close();
  });
});
