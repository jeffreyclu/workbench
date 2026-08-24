import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, process.env.WORKBENCH_PRODUCTION_DATABASE_PATH ?? 'data/workbench.db');
const previewPath = resolve(root, process.env.PREVIEW_DATABASE_PATH ?? 'data/preview-workbench.db');
const stagingPath = `${previewPath}.next`;

if (!existsSync(sourcePath)) throw new Error(`Production database does not exist: ${sourcePath}`);
mkdirSync(dirname(previewPath), { recursive: true });
rmSync(stagingPath, { force: true });

// SQLite's VACUUM INTO produces a transactionally consistent copy even while
// production writes. Preview may migrate this copy, never the live database.
const source = new DatabaseSync(sourcePath, { readOnly: true });
source.exec(`VACUUM INTO '${stagingPath.replace(/'/g, "''")}'`);
source.close();
renameSync(stagingPath, previewPath);
console.log(`Prepared isolated preview database: ${previewPath}`);
