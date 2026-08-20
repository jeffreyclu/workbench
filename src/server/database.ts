import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
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
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_item
      ON agent_runs(work_item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS queue_proposals (
      id TEXT PRIMARY KEY,
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
    );

    CREATE TABLE IF NOT EXISTS shared_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      work_item_id TEXT,
      forked_from_conversation_id TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shared_messages_created
      ON shared_messages(created_at DESC);

    CREATE TABLE IF NOT EXISTS shared_memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

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
  `,
];

export function openDatabase(path = process.env.DATABASE_PATH ?? './data/workbench.db') {
  const absolutePath = path === ':memory:' ? path : resolve(path);
  if (absolutePath !== ':memory:') mkdirSync(dirname(absolutePath), { recursive: true });

  const database = new DatabaseSync(absolutePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  for (const migration of migrations) database.exec(migration);
  database.exec(`
    INSERT OR IGNORE INTO shared_memories (id, kind, body, created_at)
      SELECT id, 'task_archive', body, created_at FROM shared_messages
      WHERE pinned = 1 AND author = 'system' AND body LIKE 'Archived task (%';
    DELETE FROM shared_messages
      WHERE pinned = 1 AND author = 'system' AND body LIKE 'Archived task (%';
    DELETE FROM shared_conversations
      WHERE work_item_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id
      );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_active_page ON work_items(queue_position, id)
      WHERE is_queued = 1 AND archived_at IS NULL AND status NOT IN ('done', 'canceled');
    CREATE INDEX IF NOT EXISTS idx_work_items_archive_page ON work_items(archived_at DESC, id DESC)
      WHERE archived_at IS NOT NULL;
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
  const messageColumns = database.prepare('PRAGMA table_info(shared_messages)').all() as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === 'conversation_id')) database.exec('ALTER TABLE shared_messages ADD COLUMN conversation_id TEXT;');
  if (!messageColumns.some((column) => column.name === 'attachments_json')) database.exec("ALTER TABLE shared_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';");
  if (!messageColumns.some((column) => column.name === 'dispatch_target')) database.exec("ALTER TABLE shared_messages ADD COLUMN dispatch_target TEXT NOT NULL DEFAULT 'none';");
  if (!messageColumns.some((column) => column.name === 'model')) database.exec('ALTER TABLE shared_messages ADD COLUMN model TEXT;');
  if (!messageColumns.some((column) => column.name === 'execution_profile')) database.exec('ALTER TABLE shared_messages ADD COLUMN execution_profile TEXT;');
  const conversationColumns = database.prepare('PRAGMA table_info(shared_conversations)').all() as Array<{ name: string }>;
  if (!conversationColumns.some((column) => column.name === 'work_item_id')) database.exec('ALTER TABLE shared_conversations ADD COLUMN work_item_id TEXT;');
  if (!conversationColumns.some((column) => column.name === 'archived_at')) database.exec('ALTER TABLE shared_conversations ADD COLUMN archived_at TEXT;');
  if (!conversationColumns.some((column) => column.name === 'forked_from_conversation_id')) database.exec('ALTER TABLE shared_conversations ADD COLUMN forked_from_conversation_id TEXT;');
  const runColumns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === 'conversation_id')) database.exec('ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT;');
  if (!runColumns.some((column) => column.name === 'message_id')) database.exec('ALTER TABLE agent_runs ADD COLUMN message_id TEXT;');
  if (!runColumns.some((column) => column.name === 'model')) database.exec('ALTER TABLE agent_runs ADD COLUMN model TEXT;');
  if (!runColumns.some((column) => column.name === 'execution_profile')) database.exec('ALTER TABLE agent_runs ADD COLUMN execution_profile TEXT;');
  const artifactColumns = database.prepare('PRAGMA table_info(published_artifacts)').all() as Array<{ name: string }>;
  if (!artifactColumns.some((column) => column.name === 'content_hash')) database.exec('ALTER TABLE published_artifacts ADD COLUMN content_hash TEXT;');
  return database;
}

export type WorkbenchDatabase = ReturnType<typeof openDatabase>;
