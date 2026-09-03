import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { estimateCostUsd } from './model-pricing.js';
import { contentHashOfLines, splitPatchHunks } from '../shared/review-decisions.js';
import { repositoryIdentitySync } from './workspace-diff.js';

/**
 * Attribute existing history records to the repository they were captured in.
 * Only a checkout still on disk can be asked; a collected run worktree stays
 * NULL and its records are read as unattributable rather than shown under
 * whichever repository is selected next.
 */
function backfillWorkspaceDiffSnapshotRepositories(database: DatabaseSync) {
  const rows = database.prepare(`SELECT id, json_extract(diff_json, '$.workspacePath') AS workspace_path
    FROM workspace_diff_snapshots WHERE repository_identity IS NULL`).all() as Array<{ id: string; workspace_path: string | null }>;
  const identities = new Map<string, string | null>();
  const update = database.prepare('UPDATE workspace_diff_snapshots SET repository_identity = ? WHERE id = ?');
  for (const row of rows) {
    if (!row.workspace_path) continue;
    if (!identities.has(row.workspace_path)) identities.set(row.workspace_path, repositoryIdentitySync(row.workspace_path));
    const identity = identities.get(row.workspace_path);
    if (identity) update.run(identity, row.id);
  }
}

function backfillDiffHunkReviewContentHashes(database: DatabaseSync) {
  const rows = database.prepare(`SELECT id, work_item_id, conversation_id, revision, file_path, hunk_range
    FROM diff_hunk_reviews WHERE content_hash = ''`).all() as Array<{
      id: string;
      work_item_id: string | null;
      conversation_id: string | null;
      revision: string;
      file_path: string;
      hunk_range: string;
    }>;
  const workItemSnapshot = database.prepare('SELECT diff_json FROM workspace_diff_snapshots WHERE work_item_id = ? AND revision = ?');
  const conversationSnapshot = database.prepare('SELECT diff_json FROM workspace_diff_snapshots WHERE conversation_id = ? AND revision = ?');
  const update = database.prepare("UPDATE diff_hunk_reviews SET content_hash = ? WHERE id = ? AND content_hash = ''");

  for (const row of rows) {
    const snapshot = row.work_item_id
      ? workItemSnapshot.get(row.work_item_id, row.revision)
      : row.conversation_id
        ? conversationSnapshot.get(row.conversation_id, row.revision)
        : undefined;
    if (!snapshot || typeof snapshot.diff_json !== 'string') continue;

    try {
      const parsed = JSON.parse(snapshot.diff_json) as { files?: Array<{ path?: unknown; patch?: unknown; isBinary?: unknown }> };
      const file = parsed.files?.find((candidate) => candidate.path === row.file_path);
      if (!file || typeof file.patch !== 'string' || file.isBinary === true) continue;
      const hunk = splitPatchHunks({ patch: file.patch, isBinary: false }).find((candidate) => candidate.range === row.hunk_range);
      if (hunk) update.run(contentHashOfLines(hunk.lines), row.id);
    } catch {
      // A malformed historical snapshot must not block the database upgrade.
      // Its review stays revision-bound because the empty hash cannot carry.
    }
  }
}

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
      machine_proposed INTEGER NOT NULL DEFAULT 0 CHECK (machine_proposed IN (0, 1)),
      machine_proposal_run_id TEXT,
      machine_proposal_window_start TEXT,
      suggested_priority INTEGER,
      suggested_queue_position INTEGER,
      proposal_rationale TEXT,
      project_name TEXT,
      stack TEXT NOT NULL DEFAULT 'attention' CHECK (stack IN ('attention', 'workbench')),
      workspace_path TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
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
      version INTEGER NOT NULL DEFAULT 1,
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
      requested_agent TEXT,
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
      ,account_profile TEXT
      ,execution_profile TEXT
      ,input_tokens INTEGER
      ,output_tokens INTEGER
      ,estimated_cost_usd REAL
      ,cost_source TEXT CHECK (cost_source IN ('provider', 'estimated'))
      ,fallback_from TEXT
      ,fallback_reason TEXT
      ,cancel_requested INTEGER NOT NULL DEFAULT 0
      ,cancel_requested_at TEXT
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
      queue_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS queue_versions (
      stack TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0
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
      ,cost_source TEXT CHECK (cost_source IN ('provider', 'estimated'))
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
      anchor TEXT,
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
  if (!runColumns.some((column) => column.name === 'adopted_conversation_id')) database.exec('ALTER TABLE agent_runs ADD COLUMN adopted_conversation_id TEXT;');
  if (!runColumns.some((column) => column.name === 'model')) database.exec('ALTER TABLE agent_runs ADD COLUMN model TEXT;');
  if (!runColumns.some((column) => column.name === 'input_tokens')) database.exec('ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER;');
  if (!runColumns.some((column) => column.name === 'output_tokens')) database.exec('ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;');
  if (!runColumns.some((column) => column.name === 'estimated_cost_usd')) database.exec('ALTER TABLE agent_runs ADD COLUMN estimated_cost_usd REAL;');
  if (!runColumns.some((column) => column.name === 'fallback_from')) database.exec('ALTER TABLE agent_runs ADD COLUMN fallback_from TEXT;');
  if (!runColumns.some((column) => column.name === 'fallback_reason')) database.exec('ALTER TABLE agent_runs ADD COLUMN fallback_reason TEXT;');
  if (!runColumns.some((column) => column.name === 'execution_profile')) database.exec('ALTER TABLE agent_runs ADD COLUMN execution_profile TEXT;');
  if (!runColumns.some((column) => column.name === 'cancel_requested')) database.exec('ALTER TABLE agent_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;');
  if (!runColumns.some((column) => column.name === 'cancel_requested_at')) database.exec('ALTER TABLE agent_runs ADD COLUMN cancel_requested_at TEXT;');
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
  if (!proposalColumns.some((column) => column.name === 'queue_version')) database.exec('ALTER TABLE queue_proposals ADD COLUMN queue_version INTEGER NOT NULL DEFAULT 0;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS queue_versions (
      stack TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO queue_versions (stack, version) VALUES ('attention', 0), ('workbench', 0);
  `);
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
  {
    id: '010_durable_agent_run_cancellation',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'cancel_requested')) {
        database.exec('ALTER TABLE agent_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;');
      }
      if (!columns.some((column) => column.name === 'cancel_requested_at')) {
        database.exec('ALTER TABLE agent_runs ADD COLUMN cancel_requested_at TEXT;');
      }
    },
  },
  {
    id: '011_agent_run_requested_agent',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'requested_agent')) {
        database.exec('ALTER TABLE agent_runs ADD COLUMN requested_agent TEXT;');
      }
      database.exec('UPDATE agent_runs SET requested_agent = agent WHERE requested_agent IS NULL;');
    },
  },
  {
    // This table was introduced in the base schema after existing databases
    // had already recorded migration 001. Keep the upgrade additive so task
    // detail queries work for both fresh and established Workbench databases.
    id: '012_work_item_links',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS work_item_links (
          work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
          linked_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (work_item_id, linked_work_item_id),
          CHECK (work_item_id < linked_work_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_work_item_links_linked
          ON work_item_links(linked_work_item_id, created_at DESC);
      `);
    },
  },
  {
    // Additive queue revision metadata lets a newer runtime reject stale
    // proposal decisions while an older runtime can continue using its columns.
    id: '014_queue_versions',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(queue_proposals)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'queue_version')) {
        database.exec('ALTER TABLE queue_proposals ADD COLUMN queue_version INTEGER NOT NULL DEFAULT 0;');
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS queue_versions (
          stack TEXT PRIMARY KEY,
          version INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO queue_versions (stack, version) VALUES ('attention', 0), ('workbench', 0);
      `);
    },
  },
  {
    // Rendered version content is deliberately separate from source_path. A
    // source checkout is mutable and may disappear; a public version URL is
    // immutable and must remain reconstructable from SQLite alone.
    id: '015_durable_artifact_publication',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS artifact_rendered_versions (
          artifact_id TEXT NOT NULL REFERENCES published_artifacts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (artifact_id, version),
          FOREIGN KEY (artifact_id, version) REFERENCES artifact_versions(artifact_id, version) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS artifact_deployment_operations (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('publish', 'revoke')),
          state TEXT NOT NULL CHECK (state IN ('staged', 'deployed', 'completed', 'failed')),
          manifest_json TEXT NOT NULL,
          error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_deployment_operations_recovery
          ON artifact_deployment_operations(state, updated_at)
          WHERE state IN ('staged', 'deployed');
      `);
    },
  },
  {
    // A linked conversation is adopted as task execution history. The marker
    // lets unlink reverse only the synthesized run records, never real runs.
    id: '016_conversation_run_adoption',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'adopted_conversation_id')) {
        database.exec('ALTER TABLE agent_runs ADD COLUMN adopted_conversation_id TEXT;');
      }
      database.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_adopted_conversation
        ON agent_runs(adopted_conversation_id) WHERE adopted_conversation_id IS NOT NULL;`);
    },
  },
  {
    // Agent output is a scoped handoff ledger, not a generic long-term memory.
    // It gives Codex and Claude the same durable prior work on later turns.
    id: '017_durable_agent_handoffs',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_handoffs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES shared_messages(id) ON DELETE CASCADE,
          author TEXT NOT NULL CHECK (author IN ('codex', 'claude', 'system')),
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_handoffs_scope
          ON agent_handoffs(conversation_id, work_item_id, created_at DESC);
      `);
    },
  },
  {
    id: '018_structured_shared_brief',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS shared_brief_entries (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES shared_messages(id) ON DELETE CASCADE,
          author TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('decision', 'agent_handoff', 'synthesis')),
          facts TEXT NOT NULL DEFAULT '',
          decisions TEXT NOT NULL DEFAULT '',
          blockers TEXT NOT NULL DEFAULT '',
          evidence TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          UNIQUE(message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_shared_brief_entries_scope
          ON shared_brief_entries(conversation_id, work_item_id, created_at DESC);
      `);
    },
  },
  {
    id: '019_editable_shared_brief',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'shared_brief')) database.exec("ALTER TABLE shared_conversations ADD COLUMN shared_brief TEXT NOT NULL DEFAULT '';");
    },
  },
  {
    // Request middleware records every completed state-changing API request.
    // SQLite requires a table rebuild to extend the existing CHECK constraint.
    id: '020_api_mutation_audit',
    apply(database) {
      const auditLogSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() as { sql: string } | undefined;
      if (auditLogSchema && !auditLogSchema.sql.includes('api_mutation')) {
        database.exec(`
          CREATE TABLE audit_log_new (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL CHECK (category IN ('outbound_call', 'agent_file_read', 'agent_file_write', 'agent_tool_use', 'destructive_action', 'api_mutation')),
            source TEXT NOT NULL,
            detail TEXT NOT NULL,
            work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO audit_log_new SELECT id, category, source, detail, work_item_id, created_at FROM audit_log;
          DROP TABLE audit_log;
          ALTER TABLE audit_log_new RENAME TO audit_log;
          CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_audit_log_work_item ON audit_log(work_item_id, created_at DESC);
        `);
      }
    },
  },
  {
    // The usage meter (SET spent per provider, this week) needs to split manual
    // dispatch from autonomous dispatch. Nothing autonomous exists yet — every
    // current creation path is a direct human action — so backfilled and future
    // rows default to 'manual' until the phase-3 governor starts passing
    // 'autonomous' explicitly.
    id: '021_agent_run_origin',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'origin')) {
        database.exec("ALTER TABLE agent_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'autonomous'));");
        database.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_origin_created ON agent_runs(origin, created_at DESC);');
      }
    },
  },
  {
    // Two runs sharing one working tree edit each other's files. A run now
    // records the directory it resolved to and mutating runs take an expiring
    // lease on it, so a second one waits in the queue instead of overwriting
    // live work. The lease expires so a killed process cannot hold a workspace
    // hostage; the scheduler reclaims it the way it reclaims run leases.
    id: '022_workspace_run_leases',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'resolved_workspace')) {
        database.exec('ALTER TABLE agent_runs ADD COLUMN resolved_workspace TEXT;');
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspace_leases (
          workspace TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_leases_run ON workspace_leases(run_id);
      `);
    },
  },
  {
    // Phase 1a's ceiling (docs/autonomy-strategy.md "Calibration") is a guess.
    // `/usage` in an interactive Claude session reports the real weekly
    // fraction spent; recording that observation alongside the SET Workbench
    // already measured for the same week solves for a measured ceiling
    // (ceiling = observed SET ÷ observed_fraction). Each row is one manual
    // observation — there is no automatic retry or correction, only new
    // observations superseding old ones by recency.
    id: '023_usage_calibrations',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS usage_calibrations (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
          observed_at TEXT NOT NULL,
          observed_percentage REAL NOT NULL CHECK (observed_percentage > 0 AND observed_percentage <= 100),
          workbench_set REAL NOT NULL,
          interactive_set REAL NOT NULL,
          computed_ceiling_set REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_calibrations_provider_observed ON usage_calibrations(provider, observed_at DESC);
      `);
    },
  },
  {
    // The budget governor (docs/autonomy-strategy.md "Estimate, reserve,
    // dispatch, reconcile") must lock the tokens an autonomous run intends to
    // spend before the run is allowed to start, so two runs racing the
    // governor can never both claim the same slice of the weekly ceiling. A
    // reservation is 'held' the moment the governor accepts a request and
    // moves to 'released' if the run never starts, or 'committed' once phase
    // 3 reconciles it against the run's actual usage. Nothing writes this
    // table yet outside the governor itself.
    id: '024_budget_reservations',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS budget_reservations (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
          origin TEXT NOT NULL CHECK (origin IN ('manual', 'autonomous')),
          model TEXT NOT NULL,
          work_item_id TEXT NOT NULL,
          reserved_set REAL NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('held', 'released', 'committed')) DEFAULT 'held',
          created_at TEXT NOT NULL,
          released_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_budget_reservations_provider_status ON budget_reservations(provider, status, created_at DESC);
      `);
    },
  },
  {
    // Workbench is a focused view of the attention stack, not a second queue.
    // Keep the legacy column during the compatibility window, but collapse all
    // existing rows onto the canonical queue before this build starts serving.
    id: '025_workbench_is_attention_focus',
    apply(database) {
      database.exec("UPDATE work_items SET stack = 'attention' WHERE stack != 'attention';");
      // A pending proposal for the old subset cannot safely reorder the full
      // canonical queue, so require a fresh plan after this upgrade.
      database.exec("UPDATE queue_proposals SET status = 'superseded', resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP) WHERE status = 'pending' AND stack = 'workbench';");
    },
  },
  {
    // Reservations must be tied to the exact run they authorize so later
    // reconciliation cannot accidentally settle a different attempt.
    id: '026_budget_reservation_run_link',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(budget_reservations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'agent_run_id')) {
        database.exec('ALTER TABLE budget_reservations ADD COLUMN agent_run_id TEXT;');
        database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_reservations_agent_run ON budget_reservations(agent_run_id) WHERE agent_run_id IS NOT NULL;');
      }
    },
  },
  {
    // Project names are free text and Workbench membership is selected by
    // project name (migration 025), so a spelling drift silently moves a task
    // between stacks and changes its colour. This gives projects an identity
    // that survives typing: `projects` holds the canonical spelling,
    // `project_aliases` remembers every spelling that resolved to it, and
    // `work_items.project_key` carries the comparison key so queries stop
    // depending on an exact display string.
    //
    // The backfill only collapses names that differ by case, punctuation, or
    // spacing — a mechanical fold with no judgement in it. Typo merging is
    // deliberately left to write-time resolution: most existing names are
    // Linear-owned, and rewriting provider data on the strength of an edit
    // distance is not a migration's call to make.
    id: '027_project_registry',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT
        );

        CREATE TABLE IF NOT EXISTS project_aliases (
          alias_key TEXT PRIMARY KEY,
          alias_text TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_project_aliases_project
          ON project_aliases(project_id);
      `);

      const columns = database.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'project_key')) {
        database.exec('ALTER TABLE work_items ADD COLUMN project_key TEXT;');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_work_items_project_key ON work_items(project_key, queue_position);');

      // Inlined rather than imported from `project-name.ts`: a migration must
      // keep producing the same result years from now, even if the shared
      // normaliser is later tuned.
      const keyOf = (name: string) => name
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');

      // A database old enough to predate project_name has no vocabulary to
      // collect, and querying the column would fail the whole upgrade. Guarded
      // the same way as migration 005.
      if (!columns.some((column) => column.name === 'project_name')) return;

      const usage = database.prepare(`SELECT project_name AS name, COUNT(*) AS uses, MAX(COALESCE(updated_at, created_at)) AS last_used
        FROM work_items WHERE project_name IS NOT NULL AND TRIM(project_name) != ''
        GROUP BY project_name`).all() as Array<{ name: string; uses: number; last_used: string | null }>;

      const grouped = new Map<string, Array<{ raw: string; name: string; uses: number; lastUsed: string | null }>>();
      for (const row of usage) {
        const key = keyOf(row.name.trim());
        if (!key) continue;
        const spellings = grouped.get(key) ?? [];
        spellings.push({ raw: row.name, name: row.name.trim(), uses: Number(row.uses), lastUsed: row.last_used });
        grouped.set(key, spellings);
      }

      const now = new Date().toISOString();
      const insertProject = database.prepare('INSERT OR IGNORE INTO projects (id, name, key, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)');
      // Matched on the exact stored value, so a name padded with a newline is
      // relabelled too rather than silently keeping a null key.
      const relabel = database.prepare('UPDATE work_items SET project_name = ?, project_key = ? WHERE project_name = ?');
      for (const [key, spellings] of grouped) {
        // The spelling already on the most tasks wins, so the migration keeps
        // the name Jeffrey actually recognises. Recency breaks a tie.
        spellings.sort((left, right) => right.uses - left.uses
          || String(right.lastUsed ?? '').localeCompare(String(left.lastUsed ?? ''))
          || left.name.localeCompare(right.name));
        const canonical = spellings[0].name;
        insertProject.run(`project-${key}`, canonical, key, now, now, spellings[0].lastUsed ?? now);
        for (const spelling of spellings) relabel.run(canonical, key, spelling.raw);
      }
    },
  },
  {
    // A dollar amount without its provenance is not safe to call spend: Claude
    // can report a billed total while Codex currently only reports tokens. Keep
    // legacy values unclassified rather than guessing how they were produced.
    id: '028_agent_run_cost_provenance',
    apply(database) {
      const runColumns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!runColumns.some((column) => column.name === 'cost_source')) {
        database.exec("ALTER TABLE agent_runs ADD COLUMN cost_source TEXT CHECK (cost_source IN ('provider', 'estimated'));");
      }
      const messageColumns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!messageColumns.some((column) => column.name === 'cost_source')) {
        database.exec("ALTER TABLE shared_messages ADD COLUMN cost_source TEXT CHECK (cost_source IN ('provider', 'estimated'));");
      }
    },
  },
  {
    // Keep the provider's four usage classes. Combining cache traffic into
    // input_tokens loses the information required for exact SET accounting.
    id: '029_agent_run_token_breakdown',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'cache_creation_input_tokens')) {
        database.exec('ALTER TABLE agent_runs ADD COLUMN cache_creation_input_tokens INTEGER;');
      }
      if (!columns.some((column) => column.name === 'cache_read_input_tokens')) {
        database.exec('ALTER TABLE agent_runs ADD COLUMN cache_read_input_tokens INTEGER;');
      }
    },
  },
  {
    // Optimistic concurrency for work-item writes: three writers (browser,
    // MCP tools, and the scheduler/agent-runner) race against the same row.
    // A caller-supplied expectedVersion lets an update fail loudly on a stale
    // read instead of silently overwriting a concurrent change.
    id: '030_work_item_version',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'version')) {
        database.exec('ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;');
      }
    },
  },
  {
    // Vectorized, hybrid retrieval over the complete durable Workbench record
    // (memory-index.ts). One row per durable record (message, activity entry,
    // agent-run prompt/response/error, audit entry, work item, doc page) in
    // memory_documents, keyed by (source, source_id) so re-collecting is an
    // upsert rather than a growing duplicate log. memory_chunks holds the
    // chunked, embedded text; memory_chunks_fts is a standalone FTS5 mirror
    // kept in sync by triggers, matching the conversations_fts/messages_fts
    // convention above rather than an external-content table, for the same
    // reason: memory_chunks uses an INTEGER PRIMARY KEY autoincrement id here,
    // so it could use content=, but standalone keeps this migration's sync
    // triggers as trivial and uniform as the existing FTS tables.
    id: '031_memory_index',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_documents (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          conversation_id TEXT,
          work_item_id TEXT,
          actor TEXT,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          indexed_at TEXT,
          UNIQUE(source, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_documents_indexed_at
          ON memory_documents(indexed_at);
        CREATE INDEX IF NOT EXISTS idx_memory_documents_created_at
          ON memory_documents(created_at);

        CREATE TABLE IF NOT EXISTS memory_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          text TEXT NOT NULL,
          embedding BLOB,
          model TEXT,
          dims INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_memory_chunks_document
          ON memory_chunks(document_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
          chunk_id UNINDEXED,
          text
        );

        CREATE TRIGGER IF NOT EXISTS memory_chunks_fts_ai AFTER INSERT ON memory_chunks BEGIN
          INSERT INTO memory_chunks_fts(chunk_id, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_chunks_fts_au AFTER UPDATE ON memory_chunks BEGIN
          DELETE FROM memory_chunks_fts WHERE chunk_id = old.id;
          INSERT INTO memory_chunks_fts(chunk_id, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_chunks_fts_ad AFTER DELETE ON memory_chunks BEGIN
          DELETE FROM memory_chunks_fts WHERE chunk_id = old.id;
        END;
      `);
    },
  },
  {
    // A machine-readable lifecycle ledger. The existing activities table is a
    // human timeline and deliberately allows arbitrary kinds/bodies; process
    // mining needs one unambiguous row for each state transition instead.
    id: '032_work_item_lifecycle_events',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS work_item_lifecycle_events (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
          transition TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          is_initial INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0, 1)),
          actor TEXT NOT NULL,
          source TEXT NOT NULL,
          reason TEXT,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lifecycle_events_export
          ON work_item_lifecycle_events(work_item_id, occurred_at);
      `);
    },
  },
  {
    // The selected credential profile is audit data for a dispatch, not a
    // secret. Store only its name; the directory remains process-local env.
    id: '033_agent_run_account_profile',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'account_profile')) {
        database.exec("ALTER TABLE agent_runs ADD COLUMN account_profile TEXT NOT NULL DEFAULT 'default';");
      }
    },
  },
  {
    // Shared-room replies can be unlinked from a work item, so they do not
    // always have an agent_runs row to retain provider cache telemetry.
    id: '034_shared_message_token_breakdown',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'cache_creation_input_tokens')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN cache_creation_input_tokens INTEGER;');
      }
      if (!columns.some((column) => column.name === 'cache_read_input_tokens')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN cache_read_input_tokens INTEGER;');
      }
    },
  },
  {
    // Unlinked shared-room replies have no agent_runs row. Persist their
    // selected profile on the visible reply itself so dispatch provenance is
    // both durable and inspectable without exposing any credential material.
    id: '035_shared_message_account_profile',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'account_profile')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN account_profile TEXT;');
      }
    },
  },
  {
    // /usage reports a reset date alongside its observed percentage; storing
    // it lets the calibration history show when each reading's window closed
    // without recomputing it from the observed timestamp.
    id: '036_usage_calibration_resets_at',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(usage_calibrations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'resets_at')) {
        database.exec('ALTER TABLE usage_calibrations ADD COLUMN resets_at TEXT;');
      }
    },
  },
  {
    // Phase 3a keeps the autonomous budget policy in SQLite so plan and quota
    // changes never require a code release. The global row starts disabled;
    // runtime approval must explicitly enable it after the gate is promoted.
    // Provider rows are intentionally not seeded because an invented weekly
    // ceiling would turn a missing configuration into permission to spend.
    id: '037_autonomy_governor_policy',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS autonomy_policy (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          global_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_enabled IN (0, 1)),
          target_fraction REAL NOT NULL CHECK (target_fraction > 0 AND target_fraction < 1),
          alarm_fraction REAL NOT NULL CHECK (alarm_fraction > 0 AND alarm_fraction < 1),
          updated_at TEXT NOT NULL,
          CHECK (target_fraction < alarm_fraction)
        );
        INSERT OR IGNORE INTO autonomy_policy (id, global_enabled, target_fraction, alarm_fraction, updated_at)
        VALUES (1, 0, 0.16, 0.20, CURRENT_TIMESTAMP);

        CREATE TABLE IF NOT EXISTS autonomy_provider_policy (
          provider TEXT PRIMARY KEY CHECK (provider IN ('claude', 'codex')),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          weekly_ceiling_set REAL NOT NULL CHECK (weekly_ceiling_set > 0),
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS autonomy_governor_decisions (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
          model TEXT NOT NULL,
          work_item_id TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'refused')),
          reason_code TEXT NOT NULL,
          reason TEXT NOT NULL,
          estimated_set REAL,
          reservation_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_created
          ON autonomy_governor_decisions(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_provider_outcome
          ON autonomy_governor_decisions(provider, outcome, created_at DESC);
      `);

      const columns = database.prepare('PRAGMA table_info(budget_reservations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'window_start')) database.exec('ALTER TABLE budget_reservations ADD COLUMN window_start TEXT;');
      if (!columns.some((column) => column.name === 'window_end')) database.exec('ALTER TABLE budget_reservations ADD COLUMN window_end TEXT;');
      if (!columns.some((column) => column.name === 'actual_set')) database.exec('ALTER TABLE budget_reservations ADD COLUMN actual_set REAL;');
      if (!columns.some((column) => column.name === 'reconciled_at')) database.exec('ALTER TABLE budget_reservations ADD COLUMN reconciled_at TEXT;');
      if (!columns.some((column) => column.name === 'alarm_triggered')) database.exec('ALTER TABLE budget_reservations ADD COLUMN alarm_triggered INTEGER NOT NULL DEFAULT 0 CHECK (alarm_triggered IN (0, 1));');
      database.exec('CREATE INDEX IF NOT EXISTS idx_budget_reservations_window ON budget_reservations(provider, window_start, status);');
    },
  },
  {
    // Phase 4 proposals remain normal work items, but their machine origin and
    // human-review requirement must survive queue reads and dispatcher restarts.
    id: '038_machine_discovery_proposals',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'machine_proposed')) database.exec('ALTER TABLE work_items ADD COLUMN machine_proposed INTEGER NOT NULL DEFAULT 0 CHECK (machine_proposed IN (0, 1));');
      if (!columns.some((column) => column.name === 'machine_proposal_run_id')) database.exec('ALTER TABLE work_items ADD COLUMN machine_proposal_run_id TEXT;');
      if (!columns.some((column) => column.name === 'machine_proposal_window_start')) database.exec('ALTER TABLE work_items ADD COLUMN machine_proposal_window_start TEXT;');
      if (!columns.some((column) => column.name === 'suggested_priority')) database.exec('ALTER TABLE work_items ADD COLUMN suggested_priority INTEGER;');
      if (!columns.some((column) => column.name === 'suggested_queue_position')) database.exec('ALTER TABLE work_items ADD COLUMN suggested_queue_position INTEGER;');
      if (!columns.some((column) => column.name === 'proposal_rationale')) database.exec('ALTER TABLE work_items ADD COLUMN proposal_rationale TEXT;');
      database.exec('CREATE INDEX IF NOT EXISTS idx_work_items_machine_proposal_window ON work_items(machine_proposed, machine_proposal_window_start);');
    },
  },
  {
    // RAG retrieval already runs on every shared-room reply, but nothing
    // recorded whether it found anything, so the UI had no way to show it
    // happened. Persisting the match count on the reply itself makes
    // retrieval visible without a separate lookup.
    id: '039_shared_message_retrieved_memory_count',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'retrieved_memory_count')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN retrieved_memory_count INTEGER;');
      }
    },
  },
  {
    // withConversationState() runs its "latest agent status" lookup once per
    // conversation on every listConversations() call (every poll, plus again
    // inside dispatchNextSharedTurn on every send). With no index covering
    // conversation_id, that query did a full SCAN of shared_messages plus a
    // temp B-tree sort per conversation, which is what made Send freeze the
    // whole event loop for a second or more once the table grew.
    id: '040_shared_messages_conversation_author_created_index',
    apply(database) {
      database.exec(
        'CREATE INDEX IF NOT EXISTS idx_shared_messages_conv_author_created ON shared_messages(conversation_id, author, created_at DESC);',
      );
    },
  },
  {
    // Task files are durable, pre-execution context. Existing databases need
    // this forward migration; changing only the base schema would skip them.
    id: '041_work_item_attachments',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'attachments_json')) {
        database.exec("ALTER TABLE work_items ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';");
      }
    },
  },
  {
    // The RAG badge only ever showed a count. Persisting the query and the
    // actual matched items lets the badge open into an exact record of what
    // was requested and retrieved, instead of just how many results came back.
    id: '042_shared_message_retrieved_memory_detail',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'retrieved_memory_detail_json')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN retrieved_memory_detail_json TEXT;');
      }
    },
  },
  {
    // A reply typed on one machine was invisible on another, since drafts
    // lived only in that browser's localStorage. Persisting the draft body
    // server-side lets it follow the conversation across devices.
    id: '043_shared_conversation_draft_body',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'draft_body')) {
        database.exec("ALTER TABLE shared_conversations ADD COLUMN draft_body TEXT NOT NULL DEFAULT '';");
      }
    },
  },
  {
    // Composer choices are conversation state, not a byproduct of the last
    // message. Persist all three so a selection survives a reload or another
    // Workbench device before Jeffrey sends the next turn.
    id: '044_shared_conversation_composer_preferences',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'preferred_account_profile')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN preferred_account_profile TEXT;');
      }
      if (!columns.some((column) => column.name === 'preferred_dispatch_target')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN preferred_dispatch_target TEXT;');
      }
    },
  },
  {
    // Interject must reorder scheduled work without falsifying the message's
    // authored timestamp, which is also the transcript's chronological order.
    id: '045_shared_message_queue_priority',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'queue_priority')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0;');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_shared_messages_queue_priority ON shared_messages(conversation_id, status, queue_priority DESC, created_at ASC);');
    },
  },
  {
    // Comments need a page-local anchor so the shared artifact can reopen the
    // exact row a coworker was discussing without storing mutable page HTML.
    id: '046_artifact_comment_anchors',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(artifact_comments)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'anchor')) {
        database.exec('ALTER TABLE artifact_comments ADD COLUMN anchor TEXT;');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_artifact_comments_anchor ON artifact_comments(artifact_id, anchor, created_at DESC);');
    },
  },
  {
    // A dual-agent dispatch is one user action. Persist its identity instead
    // of inferring it from adjacent transcript rows.
    id: '047_shared_message_dispatch_group',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'dispatch_group_id')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN dispatch_group_id TEXT;');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_shared_messages_dispatch_group ON shared_messages(conversation_id, dispatch_group_id);');
    },
  },
  {
    // Agent output is useful as a final report, but it loses the decisions and
    // tool calls that led there. Keep a compact, append-only stream per reply
    // so the debugger can show actual provider events for each live agent.
    id: '048_agent_stream_events',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_stream_events (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES shared_messages(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
          kind TEXT NOT NULL CHECK (kind IN ('decision', 'tool', 'file_read', 'file_write')),
          detail TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_stream_events_message_created
          ON agent_stream_events(message_id, created_at ASC);
      `);
    },
  },
  {
    // An accepted interjection is part of the active reply's activity feed.
    // Persist its boundary so reopening the conversation keeps it in place.
    id: '049_shared_message_interjection_stream_offset',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'interjection_stream_offset')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN interjection_stream_offset INTEGER;');
      }
    },
  },
  {
    // Human outcome ratings must retain the exact agent-event evidence that
    // was visible when the session ended; later stream/UI changes cannot
    // rewrite a recorded verdict.
    id: '050_session_feedback_decision_tree_snapshot',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS session_feedback (
          id TEXT PRIMARY KEY,
          conversation_id TEXT REFERENCES shared_conversations(id) ON DELETE SET NULL,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
          rating TEXT NOT NULL CHECK (rating IN ('positive', 'neutral', 'negative')),
          decision_tree_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CHECK (conversation_id IS NOT NULL OR work_item_id IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_feedback_conversation
          ON session_feedback(conversation_id) WHERE conversation_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_feedback_work_item
          ON session_feedback(work_item_id) WHERE work_item_id IS NOT NULL;
      `);
    },
  },
  {
    // A `--no-session-persistence` Claude invocation per turn re-pays cold
    // process/context/MCP startup on every reply. Coding conversations reuse
    // the prior turn's Claude session id (via `--resume`) instead; this column
    // is that continuity anchor, scoped to one conversation at a time.
    id: '051_shared_conversation_claude_session_id',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'claude_session_id')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN claude_session_id TEXT;');
      }
    },
  },
  {
    // A workspace diff disappears from Git once it is committed. Persist each
    // distinct review revision so task and conversation history remains useful
    // after a successful commit and push.
    id: '052_workspace_diff_snapshots',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspace_diff_snapshots (
          id TEXT PRIMARY KEY,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES shared_conversations(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          diff_json TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          CHECK (work_item_id IS NOT NULL OR conversation_id IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_work_item_revision
          ON workspace_diff_snapshots(work_item_id, revision) WHERE work_item_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_conversation_revision
          ON workspace_diff_snapshots(conversation_id, revision) WHERE conversation_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_work_item_captured
          ON workspace_diff_snapshots(work_item_id, captured_at DESC) WHERE work_item_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_conversation_captured
          ON workspace_diff_snapshots(conversation_id, captured_at DESC) WHERE conversation_id IS NOT NULL;
      `);
    },
  },
  {
    // Shared-room Codex replies use the app-server thread protocol. Persist a
    // non-ephemeral thread id per conversation so a later Codex turn can use
    // thread/resume instead of paying a fresh conversation startup.
    id: '053_shared_conversation_codex_thread_id',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'codex_thread_id')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN codex_thread_id TEXT;');
      }
    },
  },
  {
    // Final token totals show that a run was expensive, but not whether the
    // prompt, a tool loop, or repeated provider usage caused it. Keep compact,
    // append-only diagnostics; never persist raw tool output here.
    id: '054_agent_run_diagnostics',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_run_diagnostics (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES shared_messages(id) ON DELETE SET NULL,
          agent TEXT NOT NULL CHECK (agent IN ('codex', 'claude')),
          kind TEXT NOT NULL CHECK (kind IN ('prompt', 'usage', 'tool')),
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_run_diagnostics_run_created
          ON agent_run_diagnostics(run_id, created_at ASC);
      `);
    },
  },
  {
    id: '055_shared_conversation_pinning',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'pinned')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_shared_conversations_pinned_updated ON shared_conversations(pinned DESC, updated_at DESC);');
    },
  },
  {
    id: '056_diff_confidence_cache',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS diff_confidence_cache (
          hash TEXT PRIMARY KEY,
          risk INTEGER NOT NULL,
          reasoning TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // A conversation can intentionally span repositories. Persist its active
    // explorer selection server-side so desktop and mobile render the same
    // Changes view, and never fall back to the Workbench checkout by accident.
    id: '057_shared_conversation_workspace_selection',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS shared_conversation_workspace_selection (
          conversation_id TEXT PRIMARY KEY REFERENCES shared_conversations(id) ON DELETE CASCADE,
          workspace_path TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Task Views can span repositories just like conversations. Keep the
    // selected checkout server-side so every device sees the same diff.
    id: '058_work_item_workspace_selection',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS work_item_workspace_selection (
          work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
          workspace_path TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Review notes previously only reached the conversation draft, so marking
    // a hunk reviewed didn't survive a refresh. Key on revision (a content
    // hash) rather than a snapshot id so state applies to the diff a reviewer
    // is actually looking at, live or snapshotted.
    id: '059_diff_hunk_reviews',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS diff_hunk_reviews (
          id TEXT PRIMARY KEY,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES shared_conversations(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          file_path TEXT NOT NULL,
          hunk_range TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reviewed', 'needs_changes', 'commented')),
          note TEXT,
          updated_at TEXT NOT NULL,
          CHECK (work_item_id IS NOT NULL OR conversation_id IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_diff_hunk_reviews_work_item_key
          ON diff_hunk_reviews(work_item_id, revision, file_path, hunk_range) WHERE work_item_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_diff_hunk_reviews_conversation_key
          ON diff_hunk_reviews(conversation_id, revision, file_path, hunk_range) WHERE conversation_id IS NOT NULL;
      `);
    },
  },
  {
    // Keep immutable review records traceable to the agent and Git state that
    // produced them. Existing snapshots deliberately remain un-attributed.
    id: '060_workspace_diff_snapshot_provenance',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(workspace_diff_snapshots)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'originating_agent_run_id')) {
        database.exec('ALTER TABLE workspace_diff_snapshots ADD COLUMN originating_agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;');
      }
      if (!columns.some((column) => column.name === 'commit_hash')) {
        database.exec('ALTER TABLE workspace_diff_snapshots ADD COLUMN commit_hash TEXT;');
      }
      database.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_agent_run
        ON workspace_diff_snapshots(originating_agent_run_id) WHERE originating_agent_run_id IS NOT NULL;`);
    },
  },
  {
    // A completed coding run produces one reviewer map. Keep it distinct from
    // agent_handoffs, which is conversation memory rather than review evidence.
    // The JSON sections are versioned and stored together because capture and
    // review always write/read the handoff as one document:
    // - changes: affected files plus what changed and why
    // - acceptance criteria: each criterion mapped to files and decisions
    // - contract changes: API, schema, and externally visible behavior changes
    // - verification: commands and explicitly observed results
    // - uncertainties and tradeoffs: what remains unknown or was deliberate
    id: '061_agent_run_review_handoffs',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_run_review_handoffs (
          agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
          format_version INTEGER NOT NULL DEFAULT 1 CHECK (format_version = 1),
          summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
          changes_json TEXT NOT NULL CHECK (json_valid(changes_json) AND json_type(changes_json) = 'array'),
          acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json) AND json_type(acceptance_criteria_json) = 'array'),
          contract_changes_json TEXT NOT NULL CHECK (json_valid(contract_changes_json) AND json_type(contract_changes_json) = 'array'),
          verification_json TEXT NOT NULL CHECK (json_valid(verification_json) AND json_type(verification_json) = 'array'),
          uncertainties_json TEXT NOT NULL CHECK (json_valid(uncertainties_json) AND json_type(uncertainties_json) = 'array'),
          tradeoffs_json TEXT NOT NULL CHECK (json_valid(tradeoffs_json) AND json_type(tradeoffs_json) = 'array'),
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Review handoffs are evidence captured at the end of a coding run. A
    // correction must be a new run, not an in-place rewrite that destroys the
    // reviewer’s original map.
    id: '062_agent_run_review_handoffs_immutable',
    apply(database) {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS agent_run_review_handoffs_immutable
        BEFORE UPDATE ON agent_run_review_handoffs
        BEGIN
          SELECT RAISE(ABORT, 'agent run review handoffs are immutable');
        END;
      `);
    },
  },
  {
    // Kept as a forward-only compatibility migration after the conversation
    // reorder UI was rolled back. Existing databases have already recorded it;
    // new databases must still receive the same schema before any later build.
    id: '063_shared_conversation_manual_position',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'manual_position')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN manual_position REAL NOT NULL DEFAULT 0;');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_shared_conversations_manual_position ON shared_conversations(manual_position, updated_at DESC);');
    },
  },
  {
    // On-demand AI assist (explain / what-could-break / compare-to-task) was
    // re-asked from scratch every time a reviewer revisited a hunk, which read
    // as both slow (a fresh CLI turn) and forgetful (no record it was ever
    // answered). Keyed on request content hash, like diff_confidence_cache, so
    // the same question against the same decision reuses its answer.
    id: '064_review_assist_cache',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS review_assist_cache (
          hash TEXT PRIMARY KEY,
          answer TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Cost columns existed since migration 028 but nothing ever wrote them, so
    // every recorded run reads as $0. Now that Workbench has a meter
    // (model-pricing.ts), price the history it already holds instead of
    // leaving months of usage indistinguishable from free. Only rows with
    // usable token telemetry on a known model are touched; the rest stay NULL,
    // which reads as unknown. Backfilled rows are stamped 'estimated' -- never
    // 'provider', because no provider amount was captured at the time.
    id: '065_backfill_estimated_cost',
    apply(database) {
      for (const table of ['agent_runs', 'shared_messages']) {
        const rows = database.prepare(`SELECT id, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
          FROM ${table}
          WHERE estimated_cost_usd IS NULL AND model IS NOT NULL
            AND (input_tokens IS NOT NULL OR cache_creation_input_tokens IS NOT NULL OR cache_read_input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`)
          .all() as Array<{ id: string; model: string | null; input_tokens: number | null; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null; output_tokens: number | null }>;
        const update = database.prepare(`UPDATE ${table} SET estimated_cost_usd = ?, cost_source = 'estimated' WHERE id = ?`);
        for (const row of rows) {
          const cost = estimateCostUsd(row.model, {
            inputTokens: row.input_tokens, cacheCreationInputTokens: row.cache_creation_input_tokens,
            cacheReadInputTokens: row.cache_read_input_tokens, outputTokens: row.output_tokens,
          });
          if (cost !== null) update.run(cost, row.id);
        }
      }
    },
  },
  {
    id: '066_shared_message_kind',
    // Standalone conversations already classify each turn (research/execute/etc)
    // for agent routing, but that classification was discarded instead of being
    // recorded on the reply. This column lets every reply, linked or not, carry
    // the execution type it was actually dispatched under.
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'kind')) {
        database.exec('ALTER TABLE shared_messages ADD COLUMN kind TEXT;');
      }
    },
  },
  {
    id: '067_shared_turn_groundings',
    // A continuation or retry must reuse the objective resolved for its human
    // dispatch message. Recomputing from an ever-growing transcript allowed
    // terse callbacks to drift back to old task text after a classifier timeout.
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS shared_turn_groundings (
          message_id TEXT PRIMARY KEY REFERENCES shared_messages(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
          grounding_json TEXT NOT NULL CHECK (json_valid(grounding_json) AND json_type(grounding_json) = 'object'),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_shared_turn_groundings_conversation_created
          ON shared_turn_groundings(conversation_id, created_at DESC);
      `);
    },
  },
  {
    // The review stack addresses a change at logic-block granularity, which
    // `diff_hunk_reviews` cannot express: that table is keyed on a hunk range
    // and already holds rows recorded against those ranges. Splitting them in
    // place would orphan every existing verdict, so blocks get their own
    // table. The content hash is part of the key, so a rewritten block asks
    // its question again rather than inheriting an answer about other code.
    id: '068_diff_block_reviews',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS diff_block_reviews (
          id TEXT PRIMARY KEY,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES shared_conversations(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          file_path TEXT NOT NULL,
          block_range TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reviewed', 'needs_changes', 'commented')),
          note TEXT,
          updated_at TEXT NOT NULL,
          CHECK (work_item_id IS NOT NULL OR conversation_id IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_diff_block_reviews_work_item_key
          ON diff_block_reviews(work_item_id, revision, file_path, block_range, content_hash) WHERE work_item_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_diff_block_reviews_conversation_key
          ON diff_block_reviews(conversation_id, revision, file_path, block_range, content_hash) WHERE conversation_id IS NOT NULL;
      `);
    },
  },
  {
    // A review no longer needs a conversation to exist. Its source is its own
    // record: a pull request URL, or a local checkout plus the ref to read.
    //
    // Its verdicts get their own tables rather than a third scope column on
    // `diff_hunk_reviews` / `diff_block_reviews`. Those tables carry a
    // `CHECK (work_item_id IS NOT NULL OR conversation_id IS NOT NULL)` that
    // a review-scoped row would violate, and relaxing it in SQLite means
    // rebuilding tables that already hold recorded verdicts. Additive tables
    // leave every existing verdict exactly where it is.
    id: '069_standalone_reviews',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS standalone_reviews (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('pull-request', 'repository')),
          pull_request_url TEXT,
          repository_path TEXT,
          ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((source_kind = 'pull-request' AND pull_request_url IS NOT NULL)
              OR (source_kind = 'repository' AND repository_path IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_standalone_reviews_updated
          ON standalone_reviews(updated_at DESC);

        CREATE TABLE IF NOT EXISTS standalone_review_hunk_reviews (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES standalone_reviews(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          file_path TEXT NOT NULL,
          hunk_range TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reviewed', 'needs_changes', 'commented')),
          note TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_standalone_review_hunk_reviews_key
          ON standalone_review_hunk_reviews(review_id, revision, file_path, hunk_range);

        CREATE TABLE IF NOT EXISTS standalone_review_block_reviews (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES standalone_reviews(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          file_path TEXT NOT NULL,
          block_range TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reviewed', 'needs_changes', 'commented')),
          note TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_standalone_review_block_reviews_key
          ON standalone_review_block_reviews(review_id, revision, file_path, block_range, content_hash);
      `);
    },
  },
  {
    // Give Changes' hunk verdicts the same content identity Review's block
    // verdicts already have, so a verdict survives the branch moving under it.
    // Existing rows keep an empty hash: they were recorded before content was
    // tracked, so they stay answers about their own revision and never carry
    // forward onto content nobody has judged.
    id: '070_diff_hunk_review_content_hash',
    apply(database) {
      database.exec(`
        ALTER TABLE diff_hunk_reviews ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        DROP INDEX IF EXISTS idx_diff_hunk_reviews_work_item_key;
        DROP INDEX IF EXISTS idx_diff_hunk_reviews_conversation_key;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_diff_hunk_reviews_work_item_key
          ON diff_hunk_reviews(work_item_id, revision, file_path, hunk_range, content_hash) WHERE work_item_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_diff_hunk_reviews_conversation_key
          ON diff_hunk_reviews(conversation_id, revision, file_path, hunk_range, content_hash) WHERE conversation_id IS NOT NULL;

        ALTER TABLE standalone_review_hunk_reviews ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        DROP INDEX IF EXISTS idx_standalone_review_hunk_reviews_key;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_standalone_review_hunk_reviews_key
          ON standalone_review_hunk_reviews(review_id, revision, file_path, hunk_range, content_hash);
      `);
    },
  },
  {
    // Migration 070 introduced the hash column but deliberately left legacy
    // rows empty. Recover exact hunk bodies from immutable workspace snapshots
    // where possible; anything ambiguous remains revision-bound.
    id: '071_diff_hunk_review_hash_backfill',
    apply(database) {
      backfillDiffHunkReviewContentHashes(database);
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_diff_hunk_reviews_work_item_carry
          ON diff_hunk_reviews(work_item_id, revision, state, file_path, content_hash) WHERE work_item_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_diff_hunk_reviews_conversation_carry
          ON diff_hunk_reviews(conversation_id, revision, state, file_path, content_hash) WHERE conversation_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS standalone_review_diff_snapshots (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES standalone_reviews(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          diff_json TEXT NOT NULL,
          captured_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_standalone_review_diff_snapshots_revision
          ON standalone_review_diff_snapshots(review_id, revision);
        CREATE INDEX IF NOT EXISTS idx_standalone_review_diff_snapshots_captured
          ON standalone_review_diff_snapshots(review_id, captured_at DESC);
      `);
    },
  },
  {
    // History was scoped to a repository by re-reading the recorded
    // workspacePath's Git identity at read time. Agent run worktrees are
    // deliberately collected, so that path stops resolving and the record
    // became unattributable - and was then shown in every repository the
    // conversation had ever selected. Record the identity when it is still
    // knowable, at capture time, and backfill it for the paths that survive.
    id: '072_workspace_diff_snapshot_repository',
    apply(database) {
      database.exec(`
        ALTER TABLE workspace_diff_snapshots ADD COLUMN repository_identity TEXT;
        CREATE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_repository
          ON workspace_diff_snapshots(repository_identity) WHERE repository_identity IS NOT NULL;
      `);
      backfillWorkspaceDiffSnapshotRepositories(database);
    },
  },
  {
    // Uniqueness still ignored the repository, so a record was identified by
    // conversation and revision alone. Two checkouts that produce the same
    // revision - a second clone, a fork, the same edit made twice - then
    // collided: the INSERT OR IGNORE dropped the second repository's record
    // and the read-back returned the first repository's row, permanently
    // filed under the wrong repository. Identity is part of what makes a
    // record unique, so it belongs in the index.
    id: '073_workspace_diff_snapshot_repository_uniqueness',
    apply(database) {
      database.exec(`
        DROP INDEX IF EXISTS idx_workspace_diff_snapshots_work_item_revision;
        DROP INDEX IF EXISTS idx_workspace_diff_snapshots_conversation_revision;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_work_item_revision_repository
          ON workspace_diff_snapshots(work_item_id, revision, ifnull(repository_identity, ''))
          WHERE work_item_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_diff_snapshots_conversation_revision_repository
          ON workspace_diff_snapshots(conversation_id, revision, ifnull(repository_identity, ''))
          WHERE conversation_id IS NOT NULL;
      `);
    },
  },
  {
    // Favoriting mirrors conversation pinning: a nullable timestamp rather than
    // a boolean flag, so the favorites list can sort by when Jeffrey starred it.
    id: '074_artifact_favorites',
    apply(database) {
      database.exec(`
        ALTER TABLE published_artifacts ADD COLUMN favorited_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_published_artifacts_favorited
          ON published_artifacts(favorited_at DESC) WHERE favorited_at IS NOT NULL;
      `);
    },
  },
  {
    // The composer's provider selector is conversation state, exactly like the
    // account and dispatch preferences beside it: the choice has to survive a
    // reload and reach the server-side turn-grounding call, which has no
    // request body of its own to carry it.
    id: '075_shared_conversation_ai_provider',
    apply(database) {
      const columns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'preferred_ai_provider')) {
        database.exec('ALTER TABLE shared_conversations ADD COLUMN preferred_ai_provider TEXT;');
      }
    },
  },
  {
    // palmyra-execution-parity LEGACY-AFFECTING: migrations 017 and 054
    // constrained handoffs and diagnostics to CLI providers. Rebuild them
    // forward-only so Palmyra keeps the same durable execution records.
    id: '076_palmyra_agent_records',
    apply(database) {
      database.exec(`
        CREATE TABLE agent_run_diagnostics_next (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES shared_messages(id) ON DELETE SET NULL,
          agent TEXT NOT NULL CHECK (agent IN ('codex', 'claude', 'palmyra')),
          kind TEXT NOT NULL CHECK (kind IN ('prompt', 'usage', 'tool')),
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO agent_run_diagnostics_next (id, run_id, message_id, agent, kind, detail_json, created_at)
          SELECT id, run_id, message_id, agent, kind, detail_json, created_at FROM agent_run_diagnostics;
        DROP TABLE agent_run_diagnostics;
        ALTER TABLE agent_run_diagnostics_next RENAME TO agent_run_diagnostics;
        CREATE INDEX idx_agent_run_diagnostics_run_created
          ON agent_run_diagnostics(run_id, created_at ASC);

        CREATE TABLE agent_handoffs_next (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
          work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES shared_messages(id) ON DELETE CASCADE,
          author TEXT NOT NULL CHECK (author IN ('codex', 'claude', 'palmyra', 'system')),
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(message_id)
        );
        INSERT INTO agent_handoffs_next (id, conversation_id, work_item_id, message_id, author, body, created_at)
          SELECT id, conversation_id, work_item_id, message_id, author, body, created_at FROM agent_handoffs;
        DROP TABLE agent_handoffs;
        ALTER TABLE agent_handoffs_next RENAME TO agent_handoffs;
        CREATE INDEX idx_agent_handoffs_scope
          ON agent_handoffs(conversation_id, work_item_id, created_at DESC);
      `);
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
  // A bounded wait handles normal writer handoffs between API and scheduler
  // connections without turning an actual lock leak into an indefinite stall.
  // The ceiling must outlast the longest routine write-lock holder, which is a
  // promoting runtime applying migrations against this same file; at 1s those
  // migrations starved every live writer for the length of the promotion.
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  applyMigrations(database);
  return database;
}

export type WorkbenchDatabase = ReturnType<typeof openDatabase>;
