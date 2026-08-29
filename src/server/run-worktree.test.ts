import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupIntegratedRunWorktrees, integrateWorkbenchRunWorktree, isolatedRunWorkspace, provisionRunWorktreeDependencies, shouldIsolateRunWorkspace } from './run-worktree.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: directory, encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
      // The first entry is the temporary primary checkout. Everything after it
      // was created by the test and must be removed even when an assertion fails.
      for (const worktree of registered.slice(1)) {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: directory, stdio: 'ignore' });
        // isolatedRunWorkspace groups runs under a repository-key directory.
        // Temporary repositories get a unique group, so remove that empty test
        // container too instead of leaking one ~/.workbench directory per test.
        rmSync(dirname(worktree), { recursive: true, force: true });
      }
    } catch { /* The assertion may have failed before Git/worktree setup. */ }
    try {
      const repository = realpathSync(directory);
      const key = createHash('sha256').update(repository).digest('hex').slice(0, 12);
      rmSync(join(homedir(), '.workbench', 'run-worktrees', `${basename(repository)}-${key}`), { recursive: true, force: true });
    } catch { /* The temporary primary may already be gone. */ }
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

  it('provisions the primary dependency tree without installing a second copy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'seed.txt'), 'seed\n');
    mkdirSync(join(directory, 'frontend'), { recursive: true });
    writeFileSync(join(directory, 'frontend', 'package.json'), '{}\n');
    execFileSync('git', ['add', 'seed.txt', 'frontend/package.json'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    mkdirSync(join(directory, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', '.bin', 'vitest'), 'shared executable\n');
    mkdirSync(join(directory, 'frontend', 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(directory, 'frontend', 'node_modules', '.bin', 'vite'), 'nested shared executable\n');

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'provisioned-run', true, true);
      expect(realpathSync(join(workspace, 'node_modules'))).toBe(realpathSync(join(directory, 'node_modules')));
      expect(execFileSync('cat', ['node_modules/.bin/vitest'], { cwd: workspace, encoding: 'utf8' })).toBe('shared executable\n');
      expect(realpathSync(join(workspace, 'frontend', 'node_modules'))).toBe(realpathSync(join(directory, 'frontend', 'node_modules')));
      expect(execFileSync('cat', ['frontend/node_modules/.bin/vite'], { cwd: workspace, encoding: 'utf8' })).toBe('nested shared executable\n');
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
      // Provisioning is idempotent for retries of the same run.
      provisionRunWorktreeDependencies(directory, workspace);
      expect(realpathSync(join(workspace, 'node_modules'))).toBe(realpathSync(join(directory, 'node_modules')));
      execFileSync('git', ['worktree', 'remove', '--force', workspace], { cwd: directory });
      expect(execFileSync('cat', ['node_modules/.bin/vitest'], { cwd: directory, encoding: 'utf8' })).toBe('shared executable\n');
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

  it('integrates through unrelated primary working-tree edits without committing or discarding them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'seed.txt'), 'seed\n');
    writeFileSync(join(directory, 'draft.txt'), 'draft\n');
    execFileSync('git', ['add', 'seed.txt', 'draft.txt'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: directory });

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'dirty-primary-run', true, true);
      writeFileSync(join(workspace, 'seed.txt'), 'integrated\n');
      writeFileSync(join(directory, 'draft.txt'), 'local work\n');

      const result = await integrateWorkbenchRunWorktree(directory, workspace, 'dirty-primary-run', true);

      expect(result.integrated).toBe(true);
      expect(execFileSync('git', ['show', 'HEAD:seed.txt'], { cwd: directory, encoding: 'utf8' })).toBe('integrated\n');
      expect(execFileSync('git', ['show', 'HEAD:draft.txt'], { cwd: directory, encoding: 'utf8' })).toBe('draft\n');
      expect(execFileSync('git', ['diff', '--', 'draft.txt'], { cwd: directory, encoding: 'utf8' })).toContain('+local work');
      expect(execFileSync('git', ['diff', '--cached'], { cwd: directory, encoding: 'utf8' })).toBe('');
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it('integrates newly created files from the detached run worktree', async () => {
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
      const workspace = await isolatedRunWorkspace(directory, 'new-file-run', true, true);
      writeFileSync(join(workspace, 'created.ts'), 'export const created = true;\n');

      const result = await integrateWorkbenchRunWorktree(directory, workspace, 'new-file-run', true);

      expect(result.integrated).toBe(true);
      expect(execFileSync('git', ['show', 'HEAD:created.ts'], { cwd: directory, encoding: 'utf8' })).toBe('export const created = true;\n');
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' })).toBe('');
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it('never integrates or checks out a nested node_modules repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', 'seed.txt'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: directory });
    mkdirSync(join(directory, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', '.bin', 'tsx'), 'local executable\n');

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'dependency-safe-run', true, true);
      writeFileSync(join(workspace, 'created.ts'), 'export const created = true;\n');
      rmSync(join(workspace, 'node_modules'), { recursive: true, force: true });
      mkdirSync(join(workspace, 'node_modules'), { recursive: true });
      execFileSync('git', ['init', '--quiet'], { cwd: join(workspace, 'node_modules') });

      await expect(integrateWorkbenchRunWorktree(directory, workspace, 'dependency-safe-run', true)).resolves.toEqual(expect.objectContaining({ integrated: true }));
      expect(execFileSync('git', ['show', 'HEAD:created.ts'], { cwd: directory, encoding: 'utf8' })).toBe('export const created = true;\n');
      expect(execFileSync('git', ['ls-tree', 'HEAD', 'node_modules'], { cwd: directory, encoding: 'utf8' })).toBe('');
      expect(execFileSync('cat', ['node_modules/.bin/tsx'], { cwd: directory, encoding: 'utf8' })).toBe('local executable\n');
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it('lands every clean file when one hot file conflicts with an advanced main', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'hot.css'), 'base\n');
    writeFileSync(join(directory, 'quiet.ts'), 'export const quiet = 0;\n');
    execFileSync('git', ['add', 'hot.css', 'quiet.ts'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: directory });

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'partial-run', true, true);
      writeFileSync(join(workspace, 'hot.css'), 'this run\n');
      writeFileSync(join(workspace, 'quiet.ts'), 'export const quiet = 1;\n');
      // Another run integrates the same hot file first, exactly as parallel
      // runs on shared stylesheets do in production.
      writeFileSync(join(directory, 'hot.css'), 'other run\n');
      execFileSync('git', ['commit', '-qam', 'other run'], { cwd: directory });

      const result = await integrateWorkbenchRunWorktree(directory, workspace, 'partial-run', true);

      expect(result.integrated).toBe(true);
      expect(result.conflicted).toEqual(['hot.css']);
      // The conflicting file keeps main's content; the rest of the run lands.
      expect(execFileSync('git', ['show', 'HEAD:hot.css'], { cwd: directory, encoding: 'utf8' })).toBe('other run\n');
      expect(execFileSync('git', ['show', 'HEAD:quiet.ts'], { cwd: directory, encoding: 'utf8' })).toBe('export const quiet = 1;\n');
      // The unintegrated work must survive in the detached tree.
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toContain('hot.css');
      execFileSync('git', ['worktree', 'remove', '--force', workspace], { cwd: directory });
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });


  it('reports a primary checkout parked off main instead of failing the completed run', async () => {
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
      const workspace = await isolatedRunWorkspace(directory, 'off-main-run', true, true);
      writeFileSync(join(workspace, 'seed.txt'), 'run work\n');
      // Jeffrey parks the primary checkout on a branch while the run works.
      execFileSync('git', ['checkout', '-q', '-b', 'wip'], { cwd: directory });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

      const result = await integrateWorkbenchRunWorktree(directory, workspace, 'off-main-run', true);

      expect(result.integrated).toBe(false);
      expect(result.blocked).toContain('requires the primary checkout on main');
      // No commit was invented on the wrong branch, and the run's work survives.
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()).toBe(head);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toContain('seed.txt');
      execFileSync('git', ['worktree', 'remove', '--force', workspace], { cwd: directory });
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });

  it('names a wholly conflicting single-file run instead of discarding it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-run-worktree-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'workbench@example.test'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Workbench Test'], { cwd: directory });
    writeFileSync(join(directory, 'hot.css'), 'base\n');
    execFileSync('git', ['add', 'hot.css'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: directory });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: directory });

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const workspace = await isolatedRunWorkspace(directory, 'single-conflict-run', true, true);
      writeFileSync(join(workspace, 'hot.css'), 'this run\n');
      writeFileSync(join(directory, 'hot.css'), 'other run\n');
      execFileSync('git', ['commit', '-qam', 'other run'], { cwd: directory });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

      const result = await integrateWorkbenchRunWorktree(directory, workspace, 'single-conflict-run', true);

      expect(result.integrated).toBe(false);
      expect(result.conflicted).toEqual(['hot.css']);
      // Main keeps its content, no empty commit lands, and the work survives.
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()).toBe(head);
      expect(execFileSync('git', ['show', 'HEAD:hot.css'], { cwd: directory, encoding: 'utf8' })).toBe('other run\n');
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toContain('hot.css');
      execFileSync('git', ['worktree', 'remove', '--force', workspace], { cwd: directory });
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
    // Cleanup sweeps the real ~/.workbench/run-worktrees root, so this test's
    // cost scales with however many run worktrees the machine has accumulated.
  }, 30_000);
});
