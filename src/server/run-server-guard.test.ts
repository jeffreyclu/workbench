import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leftRunningBadge, settleRunServers, snapshotRunServers } from './run-server-guard.js';

const directories: string[] = [];

function worktree(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'run-server-guard-')));
  directories.push(directory);
  return directory;
}

/** Starts a background server in `cwd` on a known free port, like a run's `vite &`. */
async function startServer(cwd: string): Promise<{ pid: number; port: number }> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise((done) => probe.close(done));
  const child = spawn(process.execPath, ['-e', `require('http').createServer().listen(${port},'127.0.0.1')`], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((done) => {
      const socket = createServer();
      socket.once('error', () => done(true));
      socket.listen(port, '127.0.0.1', () => socket.close(() => done(false)));
    });
    if (open) return { pid: child.pid!, port };
    await new Promise((wait) => setTimeout(wait, 50));
  }
  throw new Error('fixture server did not start');
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createServer();
    socket.once('error', () => done(false));
    socket.listen(port, '127.0.0.1', () => socket.close(() => done(true)));
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('run server guard', () => {

  it('detects, kills, and badges a server the run left in the background', async () => {
    const root = worktree();
    const before = await snapshotRunServers([root]);
    const { pid, port } = await startServer(root);

    const survivors = await settleRunServers(before, [root]);

    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({ port, stopped: true });
    expect(leftRunningBadge(survivors[0])).toBe(`left a server running: ${survivors[0].command} on :${port}`);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await portFree(port)).toBe(true);
  });

  it('does not badge a run that stopped its own server', async () => {
    const root = worktree();
    const before = await snapshotRunServers([root]);
    const { pid, port } = await startServer(root);
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && !(await portFree(port)); i++) await new Promise((wait) => setTimeout(wait, 50));

    expect(await settleRunServers(before, [root])).toEqual([]);
  });

  it('leaves servers that were already running at run start alone', async () => {
    const root = worktree();
    const { pid } = await startServer(root);
    try {
      const before = await snapshotRunServers([root]);
      expect(await settleRunServers(before, [root])).toEqual([]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });

  it('ignores servers outside the run worktree', async () => {
    const root = worktree();
    const other = worktree();
    const before = await snapshotRunServers([root]);
    const { pid } = await startServer(other);
    try {
      expect(await settleRunServers(before, [root])).toEqual([]);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });
});
