import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectManagedCommand, listManagedCommands, startManagedCommand, stopManagedCommand } from './managed-command.js';

describe('managed commands', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workbench-managed-command-'));
    process.env.WORKBENCH_MANAGED_COMMANDS_DIR = join(root, 'jobs');
  });

  afterEach(async () => {
    for (const job of listManagedCommands(100)) {
      if (job.status === 'running') await stopManagedCommand(job.jobId);
    }
    delete process.env.WORKBENCH_MANAGED_COMMANDS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('streams output to disk and reuses the same completed job on retry', async () => {
    const started = await startManagedCommand({
      key: 'focused-bench',
      cwd: root,
      command: "printf 'first\\n'; sleep 0.1; printf 'second\\n'",
    });
    expect(started.status).toBe('running');
    expect(started.logPath).toContain(join('jobs', started.jobId, 'output.log'));

    const completed = await inspectManagedCommand(started.jobId, 2_000);
    expect(completed).toEqual(expect.objectContaining({ status: 'completed', exitCode: 0, attempt: 1 }));
    expect(completed.outputTail).toContain('first\nsecond');
    expect(readFileSync(completed.statusPath, 'utf8')).toContain('"status": "completed"');

    const retried = await startManagedCommand({ key: 'focused-bench', cwd: root, command: "printf 'first\\n'; sleep 0.1; printf 'second\\n'" });
    expect(retried).toEqual(expect.objectContaining({ jobId: started.jobId, status: 'completed', reused: true, attempt: 1 }));
    expect(retried.outputTail).toContain('first\nsecond');
  });

  it('stops the whole tracked process group without deleting its saved log', async () => {
    const started = await startManagedCommand({
      key: 'cancel-me',
      cwd: root,
      command: "printf 'checkpoint\\n'; sleep 30",
    });
    await inspectManagedCommand(started.jobId, 100);
    const stopped = await stopManagedCommand(started.jobId);

    expect(stopped.status).not.toBe('running');
    expect(stopped.outputTail).toContain('checkpoint');
    expect(listManagedCommands()).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: started.jobId, logPath: stopped.logPath }),
    ]));
  });
});
