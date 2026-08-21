import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { openDatabase, type WorkbenchDatabase } from './database.js';

const SQLITE_HEADER = 'SQLite format 3\u0000';

export type RestoreValidation = {
  bytes: number;
  integrity: 'ok';
  foreignKeyViolations: number;
  queuedRuns: number;
  runningRuns: number;
};

/** Creates a consistent SQLite snapshot without copying WAL files by hand. */
export async function createDatabaseBackup(database: WorkbenchDatabase, destination: string) {
  mkdirSync(dirname(destination), { recursive: true });
  await backup(database, destination);
  return statSync(destination).size;
}

/**
 * Copies an uploaded candidate to an application-owned staging path, validates
 * it, then migrates that staged copy. Activation is deliberately separate: a
 * live SQLite connection must be closed by a clean backend restart first.
 */
export function stageAndValidateDatabaseRestore(candidatePath: string, stagingPath: string): RestoreValidation {
  const header = readFileSync(candidatePath, { encoding: 'utf8', flag: 'r' }).slice(0, SQLITE_HEADER.length);
  if (header !== SQLITE_HEADER) throw new Error('Restore file is not a SQLite database.');

  mkdirSync(dirname(stagingPath), { recursive: true });
  copyFileSync(candidatePath, stagingPath);

  const candidate = new DatabaseSync(stagingPath);
  try {
    const integrity = candidate.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw new Error(`Restore integrity check failed: ${integrity.integrity_check}`);
    const foreignKeyViolations = (candidate.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    if (foreignKeyViolations) throw new Error(`Restore has ${foreignKeyViolations} foreign-key violation(s).`);
  } finally {
    candidate.close();
  }

  // Applies our transactional migrations and rejects databases from a future
  // build before a restart can ever activate the staged file.
  const migrated = openDatabase(stagingPath);
  try {
    const queuedRuns = (migrated.prepare("SELECT count(*) AS count FROM agent_runs WHERE status = 'queued'").get() as { count: number }).count;
    const runningRuns = (migrated.prepare("SELECT count(*) AS count FROM agent_runs WHERE status = 'running'").get() as { count: number }).count;
    return { bytes: statSync(stagingPath).size, integrity: 'ok', foreignKeyViolations: 0, queuedRuns, runningRuns };
  } finally {
    migrated.close();
  }
}
