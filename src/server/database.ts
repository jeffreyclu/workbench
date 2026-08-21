import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const baseSchemaStatements = [
  `
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      priority INTEGER NOT NULL DEFAULT 2,
      queue_position REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      is_queued INTEGER NOT NULL DEFAULT 1,
      source_identifier TEXT,
      source_url TEXT,
      project_name TEXT,
      stack TEXT NOT NULL DEFAULT 'attention' CHECK (stack IN ('attention', 'workbench')),
      workspace_path TEXT,
      strategy TEXT NOT NULL DEFAULT '',
      assignees_json TEXT NOT NULL DEFAULT '[]',
      agent_assignment_mode TEXT NOT NULL DEFAULT 'manual',
      labels_json TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      provider_payload_json TEXT,
      provider_updated_at TEXT,
      archived_at TEXT,
      completed_at TEXT,
      parent_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_touched_at TEXT,
      UNIQUE(source, source_identifier)
    );

    CREATE INDEX IF NOT EXISTS idx_work_items_queue
      ON work_items(status, priority, queue_position);

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activities_item
      ON activities(work_item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sync_state (
      provider TEXT PRIMARY KEY,
      cursor TEXT,
      last_synced_at TEXT,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      requested_target TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      instructions TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      conversation_id TEXT,
      message_id TEXT
      ,model TEXT
      ,execution_profile TEXT
      ,input_tokens INTEGER
      ,output_tokens INTEGER
      ,estimated_cost_usd REAL
      ,fallback_from TEXT
      ,fallback_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_item
      ON agent_runs(work_item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_item_classifications (
      work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      agent TEXT NOT NULL,
      complex INTEGER NOT NULL DEFAULT 0,
      instructions TEXT NOT NULL DEFAULT '',
      classified_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'automatic',
      classifier_version INTEGER NOT NULL DEFAULT 2
    );

    CREATE TABLE IF NOT EXISTS queue_proposals (
      id TEXT PRIMARY KEY,
      stack TEXT NOT NULL DEFAULT 'attention',
      status TEXT NOT NULL DEFAULT 'pending',
      previous_order_json TEXT NOT NULL,
      proposed_order_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS shared_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      error TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      dispatch_target TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL
      ,model TEXT
      ,execution_profile TEXT
      ,input_tokens INTEGER
      ,output_tokens INTEGER
      ,estimated_cost_usd REAL
      ,fallback_from TEXT
      ,fallback_reason TEXT
      ,completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS shared_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      work_item_id TEXT,
      forked_from_conversation_id TEXT,
      archived_at TEXT,
      preferred_execution_profile TEXT,
      last_read_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shared_messages_created
      ON shared_messages(created_at DESC);

    CREATE TABLE IF NOT EXISTS execution_plans (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL,
      tasks_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS source_connections (
      provider TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      settings_json TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_scanned_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS published_artifacts (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      work_item_id TEXT,
      conversation_id TEXT,
      title TEXT NOT NULL,
      public_url TEXT NOT NULL,
      content_hash TEXT,
      published_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS discovery_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS discovery_candidates (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      occurred_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      snoozed_until TEXT,
      work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES discovery_runs(id) ON DELETE SET NULL
      ,relevance INTEGER NOT NULL DEFAULT 1
      ,suggested_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_inbox
      ON discovery_candidates(status, snoozed_until, updated_at DESC);

    CREATE TABLE IF NOT EXISTS work_item_references (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'other',
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_item_references_item
      ON work_item_references(work_item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_item_links (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      linked_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (work_item_id, linked_work_item_id),
      CHECK (work_item_id < linked_work_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_item_links_linked
      ON work_item_links(linked_work_item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS artifact_versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES published_artifacts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL,
      UNIQUE(artifact_id, version)
    );

    CREATE TABLE IF NOT EXISTS artifact_events (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES published_artifacts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      version INTEGER,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifact_events_artifact
      ON artifact_events(artifact_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS artifact_comments (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES published_artifacts(id) ON DELETE CASCADE,
      version INTEGER,
      author TEXT NOT NULL DEFAULT 'Coworker',
      body TEXT NOT NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact
      ON artifact_comments(artifact_id, created_at DESC);

  `,
  `
    CREATE TABLE IF NOT EXISTS queue_order_history (
      id TEXT PRIMARY KEY,
      stack TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      reason TEXT NOT NULL DEFAULT '',
      previous_order_json TEXT NOT NULL,
      new_order_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      undone_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_order_history_stack
      ON queue_order_history(stack, created_at DESC);
  `,
  `
    -- Full-text search (FTS5) over shared conversation titles and message
    -- bodies. Design choice: standalone FTS5 tables that store their own
    -- copy of the text, rather than 'content=""' (contentless) or
    -- 'content="<table>"' (external content). External content tables map
    -- rows by content_rowid, which would have to be the base table's
    -- implicit rowid — but shared_conversations/shared_messages use a TEXT
    -- PRIMARY KEY id, not INTEGER PRIMARY KEY, so "id" and "rowid" are two
    -- different values on those tables. That mismatch is an easy source of
    -- silent drift between the index and the row it's supposed to point at.
    -- Duplicating the (small) title/body text costs a bit of disk space at
    -- this app's scale and keeps every sync trigger below trivial: one
    -- INSERT, one DELETE+INSERT, one DELETE.
    CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
      id UNINDEXED,
      title
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id UNINDEXED,
      body
    );

    -- Kept in sync with triggers rather than application-level writes:
    -- repository.ts has several entry points that insert or update
    -- shared_conversations and shared_messages (createConversation,
    -- createSharedMessage, updateSharedMessage, forkConversation, the
    -- title-touch inside createSharedMessage, the archive/restore path,
    -- etc.). A trigger on the base table guarantees the index can't drift
    -- no matter which of those paths — present or future — writes the row.
    CREATE TRIGGER IF NOT EXISTS conversations_fts_ai AFTER INSERT ON shared_conversations BEGIN
      INSERT INTO conversations_fts(id, title) VALUES (new.id, new.title);
    END;
    CREATE TRIGGER IF NOT EXISTS conversations_fts_au AFTER UPDATE ON shared_conversations BEGIN
      DELETE FROM conversations_fts WHERE id = old.id;
      INSERT INTO conversations_fts(id, title) VALUES (new.id, new.title);
    END;
    CREATE TRIGGER IF NOT EXISTS conversations_fts_ad AFTER DELETE ON shared_conversations BEGIN
      DELETE FROM conversations_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON shared_messages BEGIN
      INSERT INTO messages_fts(id, body) VALUES (new.id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON shared_messages BEGIN
      DELETE FROM messages_fts WHERE id = old.id;
      INSERT INTO messages_fts(id, body) VALUES (new.id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON shared_messages BEGIN
      DELETE FROM messages_fts WHERE id = old.id;
    END;

    -- Backfill for rows that existed before these tables/triggers did.
    -- Idempotent (NOT EXISTS guard) so it's safe to run on every startup.
    INSERT INTO conversations_fts (id, title)
      SELECT id, title FROM shared_conversations
      WHERE NOT EXISTS (SELECT 1 FROM conversations_fts WHERE conversations_fts.id = shared_conversations.id);
    INSERT INTO messages_fts (id, body)
      SELECT id, body FROM shared_messages
      WHERE NOT EXISTS (SELECT 1 FROM messages_fts WHERE messages_fts.id = shared_messages.id);
  `,
  `
    -- Diagnostics: structured logging for scheduler, retention, and agent events.
    -- Self-prunes rows older than 30 days to keep the table bounded and queryable.
    CREATE TABLE IF NOT EXISTS diagnostics (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL CHECK (event IN ('scheduler_tick', 'scheduler_error', 'retention_cleanup', 'message_prune', 'run_compact', 'run_recovery', 'agent_failure', 'lease_expired')),
      subsystem TEXT NOT NULL CHECK (subsystem IN ('scheduler', 'retention', 'recovery', 'agent')),
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
      error_code TEXT,
      detail TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_diagnostics_created
      ON diagnostics(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_subsystem
      ON diagnostics(subsystem, created_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS saved_work_item_filters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      view TEXT NOT NULL CHECK (view IN ('active', 'workbench', 'archive')),
      filter_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(view, name COLLATE NOCASE)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_work_item_filters_view_order
      ON saved_work_item_filters(view, sort_order, created_at, id);
  `,
];

/**
 * Brings pre-ledger databases up to the schema represented by
 * `baseSchemaStatements`. This deliberately contains the old conditional
 * upgrades intact: it runs once, as migration 002, rather than on every
 * application start.
 */
function applyLegacyUpgrades(database: DatabaseSync) {
  database.exec(`
    DELETE FROM shared_messages
      WHERE pinned = 1 AND author = 'system' AND body LIKE 'Archived task (%';
    DELETE FROM shared_conversations
      WHERE work_item_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id
      );
  `);
  const columns = database.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'is_queued')) {
    database.exec(`
      ALTER TABLE work_items ADD COLUMN is_queued INTEGER NOT NULL DEFAULT 0;
      UPDATE work_items SET is_queued = 1 WHERE source = 'manual';
    `);
  }
  if (!columns.some((column) => column.name === 'workspace_path')) {
    database.exec('ALTER TABLE work_items ADD COLUMN workspace_path TEXT;');
  }
  if (!columns.some((column) => column.name === 'archived_at')) {
    database.exec('ALTER TABLE work_items ADD COLUMN archived_at TEXT;');
  }
  if (!columns.some((column) => column.name === 'completed_at')) {
    database.exec('ALTER TABLE work_items ADD COLUMN completed_at TEXT;');
  }
  if (!columns.some((column) => column.name === 'parent_work_item_id')) {
    database.exec('ALTER TABLE work_items ADD COLUMN parent_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL;');
  }
  if (!columns.some((column) => column.name === 'agent_assignment_mode')) {
    database.exec(`
      ALTER TABLE work_items ADD COLUMN agent_assignment_mode TEXT NOT NULL DEFAULT 'manual';
      UPDATE work_items
      SET agent_assignment_mode = 'auto'
      WHERE EXISTS (
        SELECT 1 FROM agent_runs
        WHERE agent_runs.work_item_id = work_items.id
          AND agent_runs.requested_target = 'auto'
      );
    `);
  }
  if (!columns.some((column) => column.name === 'last_touched_at')) {
    database.exec('ALTER TABLE work_items ADD COLUMN last_touched_at TEXT; UPDATE work_items SET last_touched_at = created_at WHERE last_touched_at IS NULL;');
  }
  const messageColumns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
  const classificationColumns = database.prepare('PRAGMA table_info(work_item_classifications)').all() as Array<{ name: string }>;
  if (!classificationColumns.some((column) => column.name === 'source')) {
    database.exec("ALTER TABLE work_item_classifications ADD COLUMN source TEXT NOT NULL DEFAULT 'automatic';");
    database.exec(`UPDATE work_item_classifications SET source = 'manual'
      WHERE EXISTS (
        SELECT 1 FROM activities
        WHERE activities.work_item_id = work_item_classifications.work_item_id
          AND activities.actor = 'jeffrey'
          AND activities.kind = 'classification'
      )`);
  }
  if (!classificationColumns.some((column) => column.name === 'classifier_version')) {
    database.exec('ALTER TABLE work_item_classifications ADD COLUMN classifier_version INTEGER NOT NULL DEFAULT 1;');
  }
  if (!messageColumns.some((column) => column.name === 'conversation_id')) database.exec('ALTER TABLE shared_messages ADD COLUMN conversation_id TEXT;');
  if (!messageColumns.some((column) => column.name === 'attachments_json')) database.exec("ALTER TABLE shared_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';");
  if (!messageColumns.some((column) => column.name === 'dispatch_target')) database.exec("ALTER TABLE shared_messages ADD COLUMN dispatch_target TEXT NOT NULL DEFAULT 'none';");
  if (!messageColumns.some((column) => column.name === 'model')) database.exec('ALTER TABLE shared_messages ADD COLUMN model TEXT;');
  if (!messageColumns.some((column) => column.name === 'execution_profile')) database.exec('ALTER TABLE shared_messages ADD COLUMN execution_profile TEXT;');
  if (!messageColumns.some((column) => column.name === 'input_tokens')) database.exec('ALTER TABLE shared_messages ADD COLUMN input_tokens INTEGER;');
  if (!messageColumns.some((column) => column.name === 'output_tokens')) database.exec('ALTER TABLE shared_messages ADD COLUMN output_tokens INTEGER;');
  if (!messageColumns.some((column) => column.name === 'estimated_cost_usd')) database.exec('ALTER TABLE shared_messages ADD COLUMN estimated_cost_usd REAL;');
  if (!messageColumns.some((column) => column.name === 'fallback_from')) database.exec('ALTER TABLE shared_messages ADD COLUMN fallback_from TEXT;');
  if (!messageColumns.some((column) => column.name === 'fallback_reason')) database.exec('ALTER TABLE shared_messages ADD COLUMN fallback_reason TEXT;');
  if (!messageColumns.some((column) => column.name === 'completed_at')) database.exec('ALTER TABLE shared_messages ADD COLUMN completed_at TEXT;');
  const conversationColumns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
  if (!conversationColumns.some((column) => column.name === 'work_item_id')) database.exec('ALTER TABLE shared_conversations ADD COLUMN work_item_id TEXT;');
  if (!conversationColumns.some((column) => column.name === 'archived_at')) database.exec('ALTER TABLE shared_conversations ADD COLUMN archived_at TEXT;');
  if (!conversationColumns.some((column) => column.name === 'forked_from_conversation_id')) database.exec('ALTER TABLE shared_conversations ADD COLUMN forked_from_conversation_id TEXT;');
  if (!conversationColumns.some((column) => column.name === 'preferred_execution_profile')) database.exec('ALTER TABLE shared_conversations ADD COLUMN preferred_execution_profile TEXT;');
  if (!conversationColumns.some((column) => column.name === 'last_read_at')) database.exec('ALTER TABLE shared_conversations ADD COLUMN last_read_at TEXT;');
  const runColumns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === 'conversation_id')) database.exec('ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT;');
  if (!runColumns.some((column) => column.name === 'message_id')) database.exec('ALTER TABLE agent_runs ADD COLUMN message_id TEXT;');
  if (!runColumns.some((column) => column.name === 'model')) database.exec('ALTER TABLE agent_runs ADD COLUMN model TEXT;');
  if (!runColumns.some((column) => column.name === 'input_tokens')) database.exec('ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER;');
  if (!runColumns.some((column) => column.name === 'output_tokens')) database.exec('ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;');
  if (!runColumns.some((column) => column.name === 'estimated_cost_usd')) database.exec('ALTER TABLE agent_runs ADD COLUMN estimated_cost_usd REAL;');
  if (!runColumns.some((column) => column.name === 'fallback_from')) database.exec('ALTER TABLE agent_runs ADD COLUMN fallback_from TEXT;');
  if (!runColumns.some((column) => column.name === 'fallback_reason')) database.exec('ALTER TABLE agent_runs ADD COLUMN fallback_reason TEXT;');
  if (!runColumns.some((column) => column.name === 'execution_profile')) database.exec('ALTER TABLE agent_runs ADD COLUMN execution_profile TEXT;');
  const artifactColumns = database.prepare('PRAGMA table_info(published_artifacts)').all() as Array<{ name: string }>;
  if (!artifactColumns.some((column) => column.name === 'content_hash')) database.exec('ALTER TABLE published_artifacts ADD COLUMN content_hash TEXT;');
  if (!artifactColumns.some((column) => column.name === 'current_version')) database.exec('ALTER TABLE published_artifacts ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;');
  database.exec(`
    INSERT INTO artifact_versions (id, artifact_id, version, title, source_path, content_hash, url, note, published_at)
      SELECT 'v1-' || id, id, 1, title, source_path, COALESCE(content_hash, ''), public_url, '', published_at
      FROM published_artifacts
      WHERE NOT EXISTS (SELECT 1 FROM artifact_versions WHERE artifact_versions.artifact_id = published_artifacts.id);
    INSERT INTO artifact_events (id, artifact_id, kind, version, detail, created_at)
      SELECT 'e1-' || id, id, 'published', 1, '', published_at
      FROM published_artifacts
      WHERE NOT EXISTS (SELECT 1 FROM artifact_events WHERE artifact_events.artifact_id = published_artifacts.id);
  `);
  const discoveryColumns = database.prepare('PRAGMA table_info(discovery_candidates)').all() as Array<{ name: string }>;
  if (!discoveryColumns.some((column) => column.name === 'relevance')) database.exec('ALTER TABLE discovery_candidates ADD COLUMN relevance INTEGER NOT NULL DEFAULT 1;');
  if (!discoveryColumns.some((column) => column.name === 'suggested_work_item_id')) database.exec('ALTER TABLE discovery_candidates ADD COLUMN suggested_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL;');

  // Reliability: lease + retry bookkeeping so a restarted or crashed process
  // can recover in-flight work instead of orphaning it. owner_id/lease_expires_at
  // implement a claim lease (whoever holds a live lease owns the row); attempt/
  // max_attempts/next_attempt_at implement bounded, scheduled retry.
  if (!runColumns.some((column) => column.name === 'owner_id')) database.exec('ALTER TABLE agent_runs ADD COLUMN owner_id TEXT;');
  if (!runColumns.some((column) => column.name === 'lease_expires_at')) database.exec('ALTER TABLE agent_runs ADD COLUMN lease_expires_at TEXT;');
  if (!runColumns.some((column) => column.name === 'attempt')) database.exec('ALTER TABLE agent_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;');
  if (!runColumns.some((column) => column.name === 'max_attempts')) database.exec('ALTER TABLE agent_runs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;');
  if (!runColumns.some((column) => column.name === 'next_attempt_at')) database.exec('ALTER TABLE agent_runs ADD COLUMN next_attempt_at TEXT;');
  if (!messageColumns.some((column) => column.name === 'owner_id')) database.exec('ALTER TABLE shared_messages ADD COLUMN owner_id TEXT;');
  if (!messageColumns.some((column) => column.name === 'lease_expires_at')) database.exec('ALTER TABLE shared_messages ADD COLUMN lease_expires_at TEXT;');
  if (!messageColumns.some((column) => column.name === 'attempt')) database.exec('ALTER TABLE shared_messages ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;');
  if (!messageColumns.some((column) => column.name === 'max_attempts')) database.exec('ALTER TABLE shared_messages ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;');
  if (!messageColumns.some((column) => column.name === 'next_attempt_at')) database.exec('ALTER TABLE shared_messages ADD COLUMN next_attempt_at TEXT;');
  const proposalColumns = database.prepare('PRAGMA table_info(queue_proposals)').all() as Array<{ name: string }>;
  if (!proposalColumns.some((column) => column.name === 'explanations_json')) database.exec('ALTER TABLE queue_proposals ADD COLUMN explanations_json TEXT;');
  if (!proposalColumns.some((column) => column.name === 'stack')) database.exec("ALTER TABLE queue_proposals ADD COLUMN stack TEXT NOT NULL DEFAULT 'attention';");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_active_page ON work_items(queue_position, id)
      WHERE is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled');
    CREATE INDEX IF NOT EXISTS idx_work_items_archive_page ON work_items(archived_at DESC, id DESC)
      WHERE archived_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_runs_scheduler ON agent_runs(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_lease ON agent_runs(status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_shared_messages_scheduler ON shared_messages(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_shared_messages_lease ON shared_messages(status, lease_expires_at);
  `);
}

type Migration = {
  id: string;
  apply: (database: DatabaseSync) => void;
};

const schemaMigrations: readonly Migration[] = [
  {
    id: '001_base_schema',
    apply(database) {
      for (const statement of baseSchemaStatements) database.exec(statement);
    },
  },
  { id: '002_legacy_schema_upgrade', apply: applyLegacyUpgrades },
  {
    id: '003_audit_log',
    apply(database) {
      database.exec(`
        -- Append-only audit trail for outbound calls to third parties (Linear,
        -- Slack, Cloudflare, arbitrary source scans) and for agent file
        -- reads/writes/tool use during a run. Never updated or deleted from
        -- application code; work_item_id uses SET NULL so history survives a
        -- deleted work item.
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL CHECK (category IN ('outbound_call', 'agent_file_read', 'agent_file_write', 'agent_tool_use')),
          source TEXT NOT NULL,
          detail TEXT NOT NULL,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_created
          ON audit_log(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_log_category
          ON audit_log(category, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_log_work_item
          ON audit_log(work_item_id, created_at DESC);
      `);
    },
  },
  {
    // Every step here is guarded so replaying this migration against a
    // database that already has it applied (e.g. a legacy database whose
    // schema_migrations ledger was reset) is a no-op rather than an error,
    // matching 002_legacy_schema_upgrade's pattern.
    id: '004_soft_delete_destructive_actions',
    apply(database) {
      // Destructive delete endpoints (work items, conversations, source
      // connections) now soft-delete: the row stays for recovery via direct
      // DB access and for audit history, but is filtered out of every
      // list/get query by application code.
      const workItemColumns = database.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
      if (!workItemColumns.some((column) => column.name === 'deleted_at')) {
        database.exec('ALTER TABLE work_items ADD COLUMN deleted_at TEXT;');
      }
      const conversationColumns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!conversationColumns.some((column) => column.name === 'deleted_at')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN deleted_at TEXT;');
      }
      const sourceConnectionColumns = database.prepare('PRAGMA table_info(source_connections)').all() as Array<{ name: string }>;
      if (!sourceConnectionColumns.some((column) => column.name === 'deleted_at')) {
        database.exec('ALTER TABLE source_connections ADD COLUMN deleted_at TEXT;');
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_work_items_deleted ON work_items(deleted_at)
          WHERE deleted_at IS NOT NULL;
      `);

      // SQLite can't ALTER a CHECK constraint in place, so the audit_log
      // table is rebuilt to add 'destructive_action' to the category enum.
      const auditLogSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() as { sql: string } | undefined;
      if (auditLogSchema && !auditLogSchema.sql.includes('destructive_action')) {
        database.exec(`
          CREATE TABLE audit_log_new (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL CHECK (category IN ('outbound_call', 'agent_file_read', 'agent_file_write', 'agent_tool_use', 'destructive_action')),
            source TEXT NOT NULL,
            detail TEXT NOT NULL,
            work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO audit_log_new SELECT id, category, source, detail, work_item_id, created_at FROM audit_log;
          DROP TABLE audit_log;
          ALTER TABLE audit_log_new RENAME TO audit_log;

          CREATE INDEX IF NOT EXISTS idx_audit_log_created
            ON audit_log(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_audit_log_category
            ON audit_log(category, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_audit_log_work_item
            ON audit_log(work_item_id, created_at DESC);
        `);
      }
    },
  },
  {
    // Stack membership used to be derived at query time from
    // `project_name = 'Workbench'`. That made a provider-owned, user-editable
    // string load-bearing: renaming a project or bulk-reassigning one silently
    // moved tasks between the attention and workbench stacks. `stack` is now an
    // explicit, locally owned column that nothing but a deliberate stack change
    // writes. Guarded so replaying it is a no-op, matching 002 and 004.
    id: '005_work_item_stack',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'stack')) {
        database.exec(`ALTER TABLE work_items ADD COLUMN stack TEXT NOT NULL DEFAULT 'attention'
          CHECK (stack IN ('attention', 'workbench'));`);
        // One-time backfill reproducing exactly what the old query-time
        // predicate matched, so no task changes stack as a result of this
        // migration. COLLATE NOCASE mirrors the predicate it replaces.
        // Databases old enough to predate project_name have nothing that could
        // ever have matched that predicate, so they correctly stay 'attention'.
        if (columns.some((column) => column.name === 'project_name')) {
          database.exec(`UPDATE work_items SET stack = 'workbench'
            WHERE project_name = 'Workbench' COLLATE NOCASE;`);
        }
      }
      database.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_stack
        ON work_items(stack, queue_position);`);
    },
  },
  {
    id: '006_work_item_dependencies',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS work_item_dependencies (
          work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
          blocker_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (work_item_id, blocker_work_item_id),
          CHECK (work_item_id != blocker_work_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_work_item_dependencies_blocker
          ON work_item_dependencies(blocker_work_item_id, work_item_id);
      `);
    },
  },
  {
    // Historical tombstone. Existing databases recorded this migration before
    // the agent-result review feature was removed; retaining the id keeps their
    // migration ledger readable without recreating any review behavior.
    id: '007_work_item_review',
    apply() {},
  },
  {
    id: '008_provider_sync_overrides',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS provider_work_item_snapshots (
          work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          normalized_json TEXT NOT NULL,
          raw_payload_json TEXT NOT NULL,
          provider_updated_at TEXT,
          synced_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_work_item_snapshots_provider
          ON provider_work_item_snapshots(provider, provider_updated_at);

        CREATE TABLE IF NOT EXISTS provider_field_overrides (
          work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
          field TEXT NOT NULL CHECK (field IN ('title', 'description', 'status', 'projectName', 'labels', 'dueDate')),
          provider_baseline_json TEXT NOT NULL,
          conflicted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (work_item_id, field)
        );
        CREATE INDEX IF NOT EXISTS idx_provider_field_overrides_conflicts
          ON provider_field_overrides(work_item_id, conflicted_at)
          WHERE conflicted_at IS NOT NULL;
      `);
    },
  },
  {
    id: '009_remove_memories',
    apply(database) {
      // Erase the retired feature's data without dropping tables underneath an
      // older live runtime during an atomic release handoff. Fresh databases do
      // not create either table; compatibility shells on upgraded databases can
      // be dropped after every runtime is on this release.
      const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memories', 'shared_memories')").all() as Array<{ name: string }>).map(({ name }) => name));
      if (tables.has('memories')) database.exec('DELETE FROM memories;');
      if (tables.has('shared_memories')) database.exec('DELETE FROM shared_memories;');
    },
  },
];

function applyMigrations(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = database.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>;
  const known = new Set(schemaMigrations.map((migration) => migration.id));
  const unknown = applied.find(({ id }) => !known.has(id));
  if (unknown) {
    throw new Error(`Database migration ${unknown.id} is newer than this Workbench build.`);
  }

  const appliedIds = new Set(applied.map(({ id }) => id));
  for (const migration of schemaMigrations) {
    if (appliedIds.has(migration.id)) continue;
    database.exec('BEGIN IMMEDIATE;');
    try {
      migration.apply(database);
      database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString());
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }
}

export function openDatabase(path = process.env.DATABASE_PATH ?? './data/workbench.db') {
  const absolutePath = path === ':memory:' ? path : resolve(path);
  if (absolutePath !== ':memory:') mkdirSync(dirname(absolutePath), { recursive: true });

  const database = new DatabaseSync(absolutePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  applyMigrations(database);
  return database;
}

export type WorkbenchDatabase = ReturnType<typeof openDatabase>;
