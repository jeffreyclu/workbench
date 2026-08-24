import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** IDs recorded in the production database. Reading this never runs migrations. */
export function recordedMigrationIds(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(({ id }) => id);
  } finally {
    database.close();
  }
}

/** A release must understand every migration already committed to production. */
export function supportedMigrationIds(releasePath: string): Set<string> {
  const file = join(releasePath, 'src/server/database.ts');
  if (!existsSync(file)) return new Set();
  return new Set([...readFileSync(file, 'utf8').matchAll(/\bid:\s*'([^']+)'/g)].map((match) => match[1]));
}

export function isDatabaseCompatible(releasePath: string, databasePath: string): boolean {
  const supported = supportedMigrationIds(releasePath);
  return recordedMigrationIds(databasePath).every((id) => supported.has(id));
}

/** Finds the newest immutable release that can safely open the current database. */
export function newestCompatibleRelease(releasesPath: string, databasePath: string): string | null {
  if (!existsSync(releasesPath)) return null;
  return readdirSync(releasesPath)
    .map((name) => join(releasesPath, name))
    .filter((path) => existsSync(join(path, 'src/server/index.ts')))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .find((path) => isDatabaseCompatible(path, databasePath)) ?? null;
}
