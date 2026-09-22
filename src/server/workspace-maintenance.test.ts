import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVELOPMENT_ROOT } from './run-worktree.js';
import { cleanupStaleLocalGitState } from './workspace-maintenance.js';

const roots: string[] = [];
const run = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      const paths = run(root, ['worktree', 'list', '--porcelain']).split('\n')
        .filter((line) => line.startsWith('worktree ')).slice(1).map((line) => line.slice(9));
      for (const path of paths) execFileSync('git', ['worktree', 'remove', '--force', path], { cwd: root, stdio: 'ignore' });
    } catch { /* The assertion may have failed after a worktree was removed. */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-merged`, { recursive: true, force: true });
    rmSync(`${root}-dirty`, { recursive: true, force: true });
    rmSync(`${root}-recent`, { recursive: true, force: true });
  }
});

describe('cleanupStaleLocalGitState', () => {
  it('removes only clean, old, merged worktrees and their local branches', async () => {
    const root = mkdtempSync(join(DEVELOPMENT_ROOT, 'workspace-maintenance-test-'));
    roots.push(root);
    run(root, ['init', '-q']);
    run(root, ['config', 'user.email', 'workbench@example.test']);
    run(root, ['config', 'user.name', 'Workbench Test']);
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    run(root, ['add', 'seed.txt']);
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
    run(root, ['branch', '-M', 'main']);
    run(root, ['branch', 'merged']);
    run(root, ['worktree', 'add', '-q', `${root}-merged`, 'merged']);
    run(root, ['branch', 'recent']);
    run(root, ['worktree', 'add', '-q', `${root}-recent`, 'recent']);
    run(root, ['worktree', 'add', '-q', '-b', 'dirty', `${root}-dirty`, 'main']);
    writeFileSync(join(`${root}-dirty`, 'unfinished.txt'), 'keep me\n');
    run(root, ['checkout', '-qb', 'unmerged']);
    writeFileSync(join(root, 'unmerged.txt'), 'not on main\n');
    run(root, ['add', 'unmerged.txt']);
    execFileSync('git', ['commit', '-qm', 'unmerged'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-02T00:00:00Z' } });
    run(root, ['checkout', 'main']);
    const old = new Date('2020-01-03T00:00:00Z');
    utimesSync(`${root}-merged`, old, old);
    utimesSync(join(`${root}-merged`, '.git'), old, old);
    const staleBefore = Date.now() - 24 * 60 * 60 * 1_000;

    const preview = await cleanupStaleLocalGitState({ workspaces: [root], staleBefore, dryRun: true });
    expect(preview.worktrees).toEqual([`${root}-merged`]);

    const result = await cleanupStaleLocalGitState({ workspaces: [root], staleBefore });

    expect(result.worktrees).toEqual([`${root}-merged`]);
    expect(result.branches).toContainEqual({ repository: root, branch: 'merged' });
    expect(run(root, ['branch', '--list', 'merged'])).toBe('');
    expect(run(root, ['branch', '--list', 'dirty'])).toContain('dirty');
    expect(run(root, ['branch', '--list', 'recent'])).toContain('recent');
    expect(run(root, ['branch', '--list', 'unmerged'])).toContain('unmerged');
    expect(run(root, ['worktree', 'list', '--porcelain'])).toContain(`${root}-dirty`);
    expect(run(root, ['worktree', 'list', '--porcelain'])).toContain(`${root}-recent`);
  });
});
