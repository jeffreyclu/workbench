import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, process.env.WORKBENCH_PRODUCTION_DATABASE_PATH ?? 'data/workbench.db');
const previewPath = resolve(root, process.env.PREVIEW_DATABASE_PATH ?? 'data/preview-workbench.db');
const stagingPath = `${previewPath}.next`;
const sqliteSidecars = (path: string) => [`${path}-wal`, `${path}-shm`];

if (!existsSync(sourcePath)) throw new Error(`Production database does not exist: ${sourcePath}`);
mkdirSync(dirname(previewPath), { recursive: true });
rmSync(stagingPath, { force: true });
for (const sidecar of sqliteSidecars(stagingPath)) rmSync(sidecar, { force: true });

// SQLite's VACUUM INTO produces a transactionally consistent copy even while
// production writes. Preview may migrate this copy, never the live database.
const source = new DatabaseSync(sourcePath, { readOnly: true });
source.exec(`VACUUM INTO '${stagingPath.replace(/'/g, "''")}'`);
source.close();
// A SQLite database is its main file plus optional WAL/SHM sidecars. Keeping
// the old sidecars after replacing only the main file makes SQLite replay a
// WAL whose page map belongs to the previous snapshot, corrupting preview.
// This script runs before the preview server starts, so it exclusively owns
// the preview files at this point.
for (const sidecar of sqliteSidecars(previewPath)) rmSync(sidecar, { force: true });
renameSync(stagingPath, previewPath);
console.log(`Prepared isolated preview database: ${previewPath}`);
