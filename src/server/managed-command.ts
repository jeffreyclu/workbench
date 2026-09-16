import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ManagedCommandState = 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted';

export interface ManagedCommandRecord {
  jobId: string;
  key: string | null;
  command: string;
  cwd: string;
  status: ManagedCommandState;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  attempt: number;
  startedAt: string;
  completedAt: string | null;
  logPath: string;
  statusPath: string;
}

export interface ManagedCommandSnapshot extends ManagedCommandRecord {
  outputTail: string;
  reused?: boolean;
}

const WORKER_PATH = fileURLToPath(new URL('./managed-command-worker.mjs', import.meta.url));
const MAX_TAIL_BYTES = 16_000;
const MAX_LIST_TAIL_BYTES = 2_000;

function commandsRoot(): string {
  const configured = process.env.WORKBENCH_MANAGED_COMMANDS_DIR?.trim();
  if (configured) return resolve(configured);
  const databasePath = resolve(process.env.DATABASE_PATH?.trim() || './data/workbench.db');
  return join(dirname(databasePath), 'managed-commands');
}

function jobIdFor(cwd: string, key: string | null, command: string): string {
  return createHash('sha256').update(cwd).update('\0').update(key || command).digest('hex').slice(0, 24);
}

function pathsFor(jobId: string): { directory: string; logPath: string; statusPath: string } {
  const directory = join(commandsRoot(), jobId);
  return { directory, logPath: join(directory, 'output.log'), statusPath: join(directory, 'status.json') };
}

function readRecord(statusPath: string): ManagedCommandRecord | null {
  try {
    return JSON.parse(readFileSync(statusPath, 'utf8')) as ManagedCommandRecord;
  } catch {
    return null;
  }
}

function writeRecord(statusPath: string, record: ManagedCommandRecord): void {
  const temporary = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2));
  renameSync(temporary, statusPath);
}

function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function outputTail(logPath: string, maxBytes = MAX_TAIL_BYTES): string {
  try {
    const output = readFileSync(logPath);
    return output.subarray(Math.max(0, output.length - maxBytes)).toString('utf8');
  } catch {
    return '';
  }
}

function reconcile(record: ManagedCommandRecord): ManagedCommandRecord {
  if (record.status !== 'running' || processAlive(record.pid)) return record;
  const interrupted = {
    ...record,
    status: 'interrupted' as const,
    completedAt: record.completedAt ?? new Date().toISOString(),
    error: record.error ?? 'The managed worker stopped before recording a terminal result. The saved log is still available.',
  };
  writeRecord(record.statusPath, interrupted);
  return interrupted;
}

function snapshot(record: ManagedCommandRecord, reused?: boolean): ManagedCommandSnapshot {
  return { ...reconcile(record), outputTail: outputTail(record.logPath), ...(reused === undefined ? {} : { reused }) };
}

function validateCwd(cwd: string): string {
  const absolute = resolve(cwd);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`Managed command cwd is not a directory: ${absolute}`);
  return absolute;
}

export async function startManagedCommand(input: { command: string; cwd: string; key?: string | null; restart?: boolean }): Promise<ManagedCommandSnapshot> {
  const command = input.command.trim();
  if (!command) throw new Error('Managed command cannot be empty.');
  const cwd = validateCwd(input.cwd);
  const key = input.key?.trim() || null;
  const jobId = jobIdFor(cwd, key, command);
  const paths = pathsFor(jobId);
  mkdirSync(paths.directory, { recursive: true });

  const existing = readRecord(paths.statusPath);
  if (existing && !input.restart) return snapshot(existing, true);
  if (existing?.status === 'running' && processAlive(existing.pid)) {
    throw new Error(`Managed command ${jobId} is still running; inspect or stop it before restarting.`);
  }

  const attempt = (existing?.attempt ?? 0) + 1;
  const startedAt = new Date().toISOString();
  writeFileSync(paths.logPath, `\n[workbench] attempt ${attempt} started ${startedAt}\n[workbench] cwd: ${cwd}\n[workbench] command: ${command}\n`, { flag: 'a' });
  const record: ManagedCommandRecord = {
    jobId,
    key,
    command,
    cwd,
    status: 'running',
    pid: null,
    exitCode: null,
    signal: null,
    error: null,
    attempt,
    startedAt,
    completedAt: null,
    logPath: paths.logPath,
    statusPath: paths.statusPath,
  };
  writeRecord(paths.statusPath, record);

  const worker = spawn(process.execPath, [WORKER_PATH, paths.statusPath, paths.logPath, cwd, command], {
    cwd,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    worker.once('spawn', resolveSpawn);
    worker.once('error', rejectSpawn);
  });
  worker.unref();
  const handshakeDeadline = Date.now() + 2_000;
  let launched = readRecord(paths.statusPath);
  while (!launched?.pid && Date.now() < handshakeDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    launched = readRecord(paths.statusPath);
  }
  if (!launched?.pid) throw new Error(`Managed command worker ${jobId} did not record its PID.`);
  return snapshot(launched, false);
}

function recordById(jobId: string): ManagedCommandRecord {
  if (!/^[a-f0-9]{24}$/.test(jobId)) throw new Error('Invalid managed command job ID.');
  const { statusPath } = pathsFor(jobId);
  const record = readRecord(statusPath);
  if (!record) throw new Error(`Managed command not found: ${jobId}`);
  return record;
}

export async function inspectManagedCommand(jobId: string, waitMs = 0): Promise<ManagedCommandSnapshot> {
  const boundedWait = Math.max(0, Math.min(waitMs, 55_000));
  const deadline = Date.now() + boundedWait;
  let record = reconcile(recordById(jobId));
  while (record.status === 'running' && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(250, deadline - Date.now())));
    record = reconcile(recordById(jobId));
  }
  return snapshot(record);
}

export async function stopManagedCommand(jobId: string): Promise<ManagedCommandSnapshot> {
  const record = reconcile(recordById(jobId));
  if (record.status !== 'running' || !record.pid) return snapshot(record);
  try {
    if (process.platform !== 'win32') process.kill(-record.pid, 'SIGTERM');
    else process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const stopped = await inspectManagedCommand(jobId, 3_000);
  if (stopped.status !== 'running') return stopped;
  try {
    if (process.platform !== 'win32') process.kill(-record.pid, 'SIGKILL');
    else process.kill(record.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const canceled: ManagedCommandRecord = {
    ...record,
    status: 'canceled',
    exitCode: null,
    signal: 'SIGKILL',
    error: null,
    completedAt: new Date().toISOString(),
  };
  writeRecord(record.statusPath, canceled);
  return snapshot(canceled);
}

export function listManagedCommands(limit = 20): ManagedCommandSnapshot[] {
  const root = commandsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))
    .map((entry) => readRecord(join(root, entry.name, 'status.json')))
    .filter((record): record is ManagedCommandRecord => Boolean(record))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map((record) => ({ ...reconcile(record), outputTail: outputTail(record.logPath, MAX_LIST_TAIL_BYTES) }));
}
