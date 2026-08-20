import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';

describe('openDatabase', () => {
  let directory: string;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('creates the memories table on first open and is a no-op on reopen (idempotency)', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');

    const first = openDatabase(path);
    first.prepare(`
      INSERT INTO memories (id, kind, scope, project_name, workspace_path, body, status, supersedes_id, source_task_id, source_conversation_id, source_message_id, source_quote, created_by, created_at, updated_at)
      VALUES ('m1', 'fact', 'global', NULL, NULL, 'A fact.', 'active', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    first.close();

    // Reopen: migration must not error, and must not touch existing rows.
    const second = openDatabase(path);
    const rows = second.prepare('SELECT id, body FROM memories').all() as Array<{ id: string; body: string }>;
    expect(rows).toEqual([{ id: 'm1', body: 'A fact.' }]);
    second.close();

    // Reopen again: still a no-op, no loss.
    const third = openDatabase(path);
    const rowsAgain = third.prepare('SELECT id, body FROM memories').all() as Array<{ id: string; body: string }>;
    expect(rowsAgain).toEqual([{ id: 'm1', body: 'A fact.' }]);
    third.close();
  });

  it('does not migrate or lose shared_memories archive rows across reopen (criterion 9)', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    const path = join(directory, 'workbench.db');

    const first = openDatabase(path);
    const insert = first.prepare('INSERT INTO shared_memories (id, kind, body, created_at) VALUES (?, ?, ?, ?)');
    const bodies: string[] = [];
    for (let index = 0; index < 74; index += 1) {
      const body = `Archived note ${index}`;
      bodies.push(body);
      insert.run(`archive-${index}`, 'task_archive', body, new Date(2026, 0, 1 + index).toISOString());
    }
    first.close();

    const second = openDatabase(path);
    const rows = second.prepare('SELECT id, body FROM shared_memories ORDER BY id').all() as Array<{ id: string; body: string }>;
    expect(rows).toHaveLength(74);
    expect(rows.map((row) => row.body).sort()).toEqual([...bodies].sort());
    second.close();
  });

  it('opens an in-memory database and creates the memories table (used by every other test suite)', () => {
    const database = openDatabase(':memory:');
    const columns = database.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id', 'kind', 'scope', 'project_name', 'workspace_path', 'body', 'status',
      'supersedes_id', 'source_task_id', 'source_conversation_id', 'source_message_id',
      'source_quote', 'created_by', 'created_at', 'updated_at',
    ]));
    database.close();
  });
});
