import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabaseBackup, stageAndValidateDatabaseRestore } from './database-backup.js';
import { openDatabase } from './database.js';

describe('database backup and staged restore', () => {
  let directory: string;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('creates a consistent backup and validates a migrated staging copy', async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-backup-test-'));
    const sourcePath = join(directory, 'source.db');
    const source = openDatabase(sourcePath);
    source.prepare("INSERT INTO work_items (id, title, queue_position, created_at, updated_at) VALUES ('item-1', 'Task', 1, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    source.prepare("INSERT INTO agent_runs (id, work_item_id, kind, requested_target, agent, status, created_at) VALUES ('run-1', 'item-1', 'execute', 'codex', 'codex', 'queued', ?)").run(new Date().toISOString());
    const backupPath = join(directory, 'backup.db');
    await expect(createDatabaseBackup(source, backupPath)).resolves.toBeGreaterThan(0);
    source.close();

    expect(stageAndValidateDatabaseRestore(backupPath, join(directory, 'staged.db'))).toMatchObject({ integrity: 'ok', foreignKeyViolations: 0, queuedRuns: 1, runningRuns: 0 });
  });

  it('rejects a non-SQLite upload before staging it', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-backup-test-'));
    const source = join(directory, 'not-a-database');
    writeFileSync(source, 'not sqlite');
    expect(() => stageAndValidateDatabaseRestore(source, join(directory, 'staged.db'))).toThrow('not a SQLite database');
  });
});
