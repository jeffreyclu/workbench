import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { relative, resolve, isAbsolute } from 'node:path';
import { listManagedCommands, stopManagedCommand } from './managed-command.js';

const execFileAsync = promisify(execFile);
const GRACE_MS = 1_500;

interface Listener {
  pid: number;
  pgid: number;
  port: number;
  command: string;
}

/** What was already running under the run's worktrees when the run began. */
export interface RunServerSnapshot {
  managed: Set<string>;
  pids: Set<number>;
}

/** A server or watcher the run started and did not stop. */
export interface LeftRunningServer {
  command: string;
  port: number | null;
  /** True when the process was gone after cleanup. */
  stopped: boolean;
}

export function leftRunningBadge(server: LeftRunningServer): string {
  return `left a server running: ${server.command}${server.port ? ` on :${server.port}` : ''}`;
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function under(root: string, path: string): boolean {
  const rel = relative(real(root), real(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function run(file: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    // lsof exits 1 when nothing matches; partial output is still valid.
    return (error as { stdout?: string }).stdout ?? '';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every TCP listener whose cwd or command line sits under one of the worktrees. */
async function listenersUnder(worktrees: string[]): Promise<Listener[]> {
  if (process.platform === 'win32' || worktrees.length === 0) return [];
  const raw = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  const ports = new Map<number, number[]>();
  let pid = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port) ports.set(pid, [...(ports.get(pid) ?? []), port]);
    }
  }
  const pids = [...ports.keys()].filter((candidate) => candidate !== process.pid);
  if (!pids.length) return [];
  const list = pids.join(',');
  const [cwdOut, psOut] = await Promise.all([
    run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', list]),
    run('ps', ['-o', 'pid=,pgid=,command=', '-p', list]),
  ]);
  const cwds = new Map<number, string>();
  pid = 0;
  for (const line of cwdOut.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
  }
  const found: Listener[] = [];
  for (const line of psOut.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const processId = Number(match[1]);
    const command = match[3].trim();
    const cwd = cwds.get(processId);
    const owned = worktrees.some((root) => (cwd && under(root, cwd)) || command.includes(real(root)) || command.includes(resolve(root)));
    if (!owned) continue;
    for (const port of ports.get(processId) ?? []) found.push({ pid: processId, pgid: Number(match[2]), port, command });
  }
  return found;
}

function managedUnder(worktrees: string[]) {
  return listManagedCommands(100).filter((job) => job.status === 'running' && worktrees.some((root) => under(root, job.cwd)));
}

export async function snapshotRunServers(worktrees: string[]): Promise<RunServerSnapshot> {
  const listeners = await listenersUnder(worktrees);
  return {
    managed: new Set(managedUnder(worktrees).map((job) => `${job.jobId}:${job.attempt}`)),
    pids: new Set(listeners.map((listener) => listener.pid)),
  };
}

async function ownProcessGroup(): Promise<number | null> {
  const out = await run('ps', ['-o', 'pgid=', '-p', String(process.pid)]);
  const value = Number(out.trim());
  return value || null;
}

async function terminate(pid: number, pgid: number, ownGroup: number | null): Promise<boolean> {
  // Never take down Workbench's own group; fall back to the single process.
  const target = pgid > 1 && pgid !== ownGroup ? -pgid : pid;
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(target, name); } catch { /* already gone */ }
  };
  signal('SIGTERM');
  const deadline = Date.now() + GRACE_MS;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  if (alive(pid)) {
    signal('SIGKILL');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !alive(pid);
}

/**
 * Compares against the start snapshot, kills anything the run left behind
 * (managed services first, then raw listeners), and names each survivor.
 */
export async function settleRunServers(before: RunServerSnapshot, worktrees: string[]): Promise<LeftRunningServer[]> {
  const survivors: LeftRunningServer[] = [];
  const ownGroup = await ownProcessGroup();
  const initial = await listenersUnder(worktrees);

  for (const job of managedUnder(worktrees)) {
    if (before.managed.has(`${job.jobId}:${job.attempt}`)) continue;
    const ports = initial.filter((listener) => job.pid !== null && listener.pgid === job.pid).map((listener) => listener.port);
    const stopped = await stopManagedCommand(job.jobId).then((snapshot) => snapshot.status !== 'running').catch(() => false);
    if (!ports.length) survivors.push({ command: job.command, port: null, stopped });
    for (const port of ports) survivors.push({ command: job.command, port, stopped });
  }

  // Re-list: stopping a managed job takes its listeners with it.
  const remaining = (await listenersUnder(worktrees)).filter((listener) => !before.pids.has(listener.pid));
  const byPid = new Map<number, Listener[]>();
  for (const listener of remaining) byPid.set(listener.pid, [...(byPid.get(listener.pid) ?? []), listener]);
  for (const [pid, listeners] of byPid) {
    const stopped = await terminate(pid, listeners[0].pgid, ownGroup);
    for (const listener of listeners) survivors.push({ command: listener.command, port: listener.port, stopped });
  }
  return survivors;
}
