import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupIntegratedRunWorktrees, integrateWorkbenchRunWorktree, isolatedRunWorkspace, shouldIsolateRunWorkspace } from './run-worktree.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { execFileSync('git', ['worktree', 'remove', '--force', join(directory, '.worktree')], { cwd: directory, stdio: 'ignore' }); } catch { /* No worktree was created. */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('isolatedRunWorkspace', () => {
  it('does not isolate a non-Workbench project workspace', () => {
    expect(shouldIsolateRunWorkspace('/Users/jeffrey.lu/dev/writer-monorepo')).toBe(false);
    expect(shouldIsolateRunWorkspace(process.cwd())).toBe(true);
  });

  it('uses a detached worktree for a mutating production run without creating a branch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', 'seed.txt'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: directory });

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'isolated-run', true);
      expect(workspace).not.toBe(directory);
      expect(execFileSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8' }).trim()).toBe('');
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
      execFileSync('git', ['worktree', 'remove', '--force', workspace], { cwd: directory });
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it('integrates a completed detached worktree into primary main before it can be collected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', 'seed.txt'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: directory });

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'handoff-run', true, true);
      writeFileSync(join(workspace, 'seed.txt'), 'integrated\n');
      const result = await integrateWorkbenchRunWorktree(directory, workspace, 'handoff-run', true);

      expect(result.integrated).toBe(true);
      expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(execFileSync('git', ['branch', '--show-current'], { cwd: directory, encoding: 'utf8' }).trim()).toBe('main');
      expect(execFileSync('git', ['show', 'HEAD:seed.txt'], { cwd: directory, encoding: 'utf8' })).toBe('integrated\n');
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' })).toBe('');
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it('removes only a clean worktree whose commit is already integrated into main', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', 'seed.txt'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: directory });

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'integrated-run', true);
      expect(await cleanupIntegratedRunWorktrees()).toBeGreaterThanOrEqual(1);
      expect(() => execFileSync('git', ['status'], { cwd: workspace, stdio: 'ignore' })).toThrow();
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });
});
