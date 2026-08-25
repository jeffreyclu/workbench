import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
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

const CHUNK_PREFIX = 'latest.db.gz.part';
const CHUNK_SIZE_MB = 90; // stay well under GitHub's 100 MB per-file limit

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
    // GitHub hard-rejects any single blob over 100 MB, and the DB has already outgrown
    // that once. Compress, then split into fixed-size chunks so no single pushed file
    // can cross the limit no matter how large the source database grows.
    copyFileSync(snapshotPath, resolve(workdir, 'latest.db'));
    // The remote checkout already contains the prior latest.db.gz; replace it.
    execFileSync('gzip', ['-9', '-f', 'latest.db'], { cwd: workdir, stdio: 'pipe' });
    execFileSync(
      'split',
      ['-d', '-a', '4', '-b', `${CHUNK_SIZE_MB}m`, 'latest.db.gz', CHUNK_PREFIX],
      { cwd: workdir, stdio: 'pipe' },
    );
    unlinkSync(resolve(workdir, 'latest.db.gz'));
    git('rm', '--ignore-unmatch', '-q', 'latest.db', 'latest.db.gz');
    for (const name of readdirSync(workdir)) {
      // Backup repositories commonly ignore generated archives. These chunk files
      // are the intentional restore artifact, so stage them explicitly.
      if (name.startsWith(CHUNK_PREFIX)) git('add', '-f', name);
    }
    // Remove any leftover chunks from a previous, larger backup that this snapshot no
    // longer needs (e.g. the DB shrank after a vacuum/prune).
    for (const name of git('ls-files').toString().split('\n')) {
      if (name.startsWith(CHUNK_PREFIX) && !readdirSync(workdir).includes(name)) git('rm', '-q', name);
    }
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
