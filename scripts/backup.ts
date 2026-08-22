import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// source_connections.settings_json stores plaintext provider credentials (Atlassian API
// token, GitHub PAT, Slack tokens). GitHub push protection rejected an earlier unredacted
// snapshot, so every offsite copy has that column blanked out before it leaves this machine.
const REPO_ROOT = resolve(import.meta.dirname, '..');
const DB_PATH = resolve(REPO_ROOT, process.env.DATABASE_PATH ?? './data/workbench.db');
const BACKUP_DIR = resolve(REPO_ROOT, 'data/backups');
const KEEP_COUNT = 20;
const BACKUP_REMOTE = process.env.WORKBENCH_BACKUP_REMOTE ?? 'git@github.com:jeffreyclu/workbench-backups.git';
const BACKUP_BRANCH = 'main';

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createSnapshot(): string {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const target = resolve(BACKUP_DIR, `workbench-${timestamp()}.db`);
  const source = new DatabaseSync(DB_PATH, { readOnly: true });
  source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  source.close();
  redactCredentials(target);
  return target;
}

function redactCredentials(snapshotPath: string): void {
  const db = new DatabaseSync(snapshotPath);
  db.exec(
    `UPDATE source_connections SET settings_json = '{"redacted":true}' WHERE settings_json != '{"redacted":true}'`,
  );
  db.exec('VACUUM');
  db.close();
}

function pruneOldSnapshots(): void {
  const files = readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith('workbench-') && name.endsWith('.db'))
    .map((name) => resolve(BACKUP_DIR, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files.slice(KEEP_COUNT)) unlinkSync(file);
}

function pushOffsite(snapshotPath: string): void {
  const workdir = mkdtempSync(resolve(tmpdir(), 'workbench-backup-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workdir, stdio: 'pipe' });
    git('init', '-q');
    git('remote', 'add', 'origin', BACKUP_REMOTE);
    try {
      execFileSync('git', ['fetch', '-q', 'origin', BACKUP_BRANCH], { cwd: workdir, stdio: 'pipe' });
      git('checkout', '-q', BACKUP_BRANCH);
    } catch {
      git('checkout', '-q', '-b', BACKUP_BRANCH);
    }
    execFileSync('cp', [snapshotPath, resolve(workdir, 'latest.db')]);
    git('add', 'latest.db');
    git('-c', 'user.email=backup@workbench.local', '-c', 'user.name=Workbench Backup', 'commit', '-q', '-m', `Snapshot ${timestamp()}`, '--allow-empty');
    git('push', '-q', 'origin', `HEAD:${BACKUP_BRANCH}`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

const snapshot = createSnapshot();
pruneOldSnapshots();
console.log(`Snapshot written: ${snapshot}`);

if (process.env.WORKBENCH_BACKUP_SKIP_PUSH !== '1') {
  pushOffsite(snapshot);
  console.log(`Pushed redacted snapshot to ${BACKUP_REMOTE} (${BACKUP_BRANCH})`);
}
