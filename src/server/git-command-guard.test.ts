import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const guard = resolve(process.cwd(), 'scripts', 'workbench-agent-bin', 'git-command-guard.mjs');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runGuard(args: string[], cwd: string) {
  return spawnSync(process.execPath, [guard, ...args], { cwd, encoding: 'utf8' });
}

function scratchRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-git-guard-'));
  directories.push(directory);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
  writeFileSync(join(directory, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', 'seed.txt'], { cwd: directory });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
  return directory;
}

describe('git-command-guard', () => {
  it('blocks a branch mutation aimed at the Workbench checkout', () => {
    const result = runGuard(['checkout', '-b', 'agent-branch'], process.cwd());
    expect(result.status).toBe(126);
    expect(result.stderr).toContain('Workbench blocked Git branch/worktree mutation');
    // Nothing was handed to real Git, so the checkout is untouched.
    expect(execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main');
  });

  it('allows a pathspec-scoped restore, which integration needs and never moves HEAD', () => {
    const result = runGuard(['checkout', '--quiet', 'HEAD', '--', 'package.json'], process.cwd());
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Workbench blocked');
  });

  it('allows branch and worktree work in a repository that is not Workbench', () => {
    const directory = scratchRepository();
    const branch = runGuard(['branch', '-M', 'main'], directory);
    expect(branch.status).toBe(0);
    expect(branch.stderr).not.toContain('Workbench blocked');

    const worktree = runGuard(['worktree', 'add', '--detach', join(directory, 'wt'), 'HEAD'], directory);
    expect(worktree.status).toBe(0);
    execFileSync('git', ['worktree', 'remove', '--force', join(directory, 'wt')], { cwd: directory });
  });

  it('still reads Workbench state that never mutates it', () => {
    expect(runGuard(['worktree', 'list'], process.cwd()).status).toBe(0);
    expect(runGuard(['branch', '--show-current'], process.cwd()).status).toBe(0);
  });
});
