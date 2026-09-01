import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockedPersistentForegroundCommand, blockedWorkbenchBranchCommand, blockedWorkbenchDependencyBootstrapCommand, blockedWriterTestSuiteCommand, bypassesWriterTestCommandGuard, isWorkbenchWorkspace, isWriterWorkspace } from './agent-runner.js';

const guard = fileURLToPath(new URL('../../scripts/writer-agent-bin/test-command-guard.mjs', import.meta.url));
const bin = (name: string) => fileURLToPath(new URL(`../../scripts/writer-agent-bin/${name}`, import.meta.url));
function check(name: string, ...args: string[]) {
  return spawnSync(process.execPath, [guard, bin(name), ...args], { encoding: 'utf8', env: { ...process.env, WORKBENCH_WRITER_TEST_GUARD_CHECK_ONLY: '1' } });
}
function checkInWorkspace(cwd: string, name: string, ...args: string[]) {
  return spawnSync(process.execPath, [guard, bin(name), ...args], {
    encoding: 'utf8',
    env: { ...process.env, WORKBENCH_WRITER_TEST_GUARD_CHECK_ONLY: '1', WORKBENCH_WRITER_TEST_GUARD_CWD: cwd },
  });
}

describe('Writer agent test command guard', () => {
  it('detects the Writer workspace and provider-level test-binary bypasses', () => {
    expect(isWriterWorkspace('/Users/jeffrey.lu/dev/writer-monorepo/frontend')).toBe(true);
    expect(isWriterWorkspace('/Users/jeffrey.lu/dev/workbench')).toBe(false);
    expect(blockedWriterTestSuiteCommand('npx vitest run')).toBe(true);
    expect(blockedWriterTestSuiteCommand('node_modules/.bin/vitest run')).toBe(true);
    expect(blockedWriterTestSuiteCommand('node node_modules/vitest/vitest.mjs run')).toBe(true);
    expect(blockedWriterTestSuiteCommand('pnpm --filter frontend test:unit')).toBe(true);
    expect(blockedWriterTestSuiteCommand('node_modules/.bin/vitest run src/components/feature.test.ts')).toBe(false);
    expect(bypassesWriterTestCommandGuard('npx vitest run')).toBe(false);
    expect(bypassesWriterTestCommandGuard('node node_modules/vitest/vitest.mjs run')).toBe(true);
    expect(bypassesWriterTestCommandGuard('/repo/node_modules/.bin/vitest run')).toBe(true);
  });

  it('scopes the executable test guard to the shell current working directory', () => {
    expect(checkInWorkspace('/Users/jeffrey.lu/dev/writer-monorepo', 'npx', 'vitest', 'run').status).toBe(126);
    expect(checkInWorkspace('/Users/jeffrey.lu/dev/workbench', 'npx', 'vitest', 'run').status).toBe(0);
  });

  it('blocks Workbench branch and worktree mutations while allowing inspection', () => {
    expect(isWorkbenchWorkspace('/Users/jeffrey.lu/dev/workbench')).toBe(true);
    expect(isWorkbenchWorkspace('/Users/jeffrey.lu/dev/writer-monorepo')).toBe(false);
    expect(blockedWorkbenchBranchCommand('git checkout -b fix/bad')).toBe(true);
    expect(blockedWorkbenchBranchCommand('git switch main')).toBe(true);
    expect(blockedWorkbenchBranchCommand('git branch fix/bad')).toBe(true);
    expect(blockedWorkbenchBranchCommand('git worktree add /tmp/bad')).toBe(true);
    expect(blockedWorkbenchBranchCommand('git status && git branch --show-current')).toBe(false);
  });

  it('blocks dependency bootstraps in provisioned run worktrees but allows explicit package changes', () => {
    expect(blockedWorkbenchDependencyBootstrapCommand('npm ci')).toBe(true);
    expect(blockedWorkbenchDependencyBootstrapCommand('npm install')).toBe(true);
    expect(blockedWorkbenchDependencyBootstrapCommand('pnpm install --frozen-lockfile')).toBe(true);
    expect(blockedWorkbenchDependencyBootstrapCommand('yarn')).toBe(true);
    expect(blockedWorkbenchDependencyBootstrapCommand('npm install zod')).toBe(false);
    expect(blockedWorkbenchDependencyBootstrapCommand('npm install --save-dev vitest')).toBe(false);
    expect(blockedWorkbenchDependencyBootstrapCommand('npm run build')).toBe(false);
  });

  it('blocks foreground services that cannot return control to the agent turn', () => {
    expect(blockedPersistentForegroundCommand('./scripts/worktree-start.sh')).toBe(true);
    expect(blockedPersistentForegroundCommand('pnpm dev')).toBe(true);
    expect(blockedPersistentForegroundCommand('npm run serve')).toBe(true);
    expect(blockedPersistentForegroundCommand('tail -f /tmp/backend.log')).toBe(true);
    expect(blockedPersistentForegroundCommand('while true; do curl localhost:3000; done')).toBe(true);
    expect(blockedPersistentForegroundCommand('timeout 30s pnpm dev')).toBe(false);
    expect(blockedPersistentForegroundCommand('pnpm dev >/tmp/app.log 2>&1 &')).toBe(false);
    expect(blockedPersistentForegroundCommand('npm run build')).toBe(false);
    expect(blockedPersistentForegroundCommand('./scripts/worktree-start.sh --help')).toBe(true);
  });
  it.each([
    ['npm', ['test']], ['npm', ['run', 'test']], ['npm', ['--prefix', 'frontend', 'test']], ['pnpm', ['--filter', 'frontend', 'test:unit']], ['pnpm', ['test', '--', 'use-manage-connectors-view-model']], ['yarn', ['test']],
    ['vitest', ['run']], ['vitest', ['run', '--', 'use-manage-connectors-view-model']], ['jest', ['--runInBand']], ['npx', ['vitest', 'run', '--', 'use-manage-connectors-view-model']],
  ])('rejects full-suite invocation %s %j', (name, args) => {
    const result = check(name, ...args); expect(result.status).toBe(126); expect(result.stdout).toBe('denied\n');
  });
  it.each([
    ['vitest', ['run', 'src/components/feature.test.ts']], ['npm', ['test', '--', 'src/components/feature.test.ts']],
    ['pnpm', ['test', '--', 'src/components/feature.spec.tsx']], ['npx', ['vitest', 'run', 'src/components/feature.test.ts']], ['npx', ['vitest', '--version']], ['npm', ['run', 'build']],
  ])('allows a focused or non-test invocation %s %j', (name, args) => {
    const result = check(name, ...args); expect(result.status).toBe(0); expect(result.stdout).toBe('allowed\n');
  });
});
