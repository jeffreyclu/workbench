import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { clearTurnCapability, createExternalActionProcessGuard, externalActionGuardEnvironment, observeExternalActionRefusals, recordExternalActionRefusal, writeTurnCapability } from './external-action-command-guard.js';

const guard = fileURLToPath(new URL('../../scripts/agent-bin/external-action-command-guard.mjs', import.meta.url));
const bin = (name: 'git' | 'gh') => fileURLToPath(new URL(`../../scripts/agent-bin/${name}`, import.meta.url));
const temporaryDirectories: string[] = [];

function environmentWithoutCapabilityFile(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.WORKBENCH_EXTERNAL_CAPABILITY_FILE;
  return environment;
}

function check(name: 'git' | 'gh', args: string[], capability: Record<string, string> = {}) {
  return spawnSync(process.execPath, [guard, bin(name), ...args], {
    encoding: 'utf8',
    env: { ...environmentWithoutCapabilityFile(), WORKBENCH_EXTERNAL_ACTION_GUARD_CHECK_ONLY: '1', WORKBENCH_EXTERNAL_CAPABILITY: JSON.stringify(capability) },
  });
}

function checkWithGuard(name: 'git' | 'gh', args: string[], processGuard: ReturnType<typeof createExternalActionProcessGuard>) {
  return spawnSync(process.execPath, [guard, bin(name), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...externalActionGuardEnvironment(processGuard), WORKBENCH_EXTERNAL_ACTION_GUARD_CHECK_ONLY: '1' },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('external action command guard', () => {
  it.each([
    ['git', ['push', '--dry-run'], 'push'],
    ['gh', ['pr', 'create'], 'pr_create'],
    ['gh', ['pr', 'merge', '12'], 'pr_lifecycle'],
    ['gh', ['pr', 'review', '12', '--approve'], 'pr_review'],
    ['gh', ['pr', 'comment', '12', '--body', 'done'], 'pr_review'],
    ['gh', ['api', '-X', 'POST', 'repos/org/repo/issues/12/comments'], 'pr_review'],
  ] as const)('refuses %s %j without capability %s', (name, args, requiredCapability) => {
    const result = check(name, [...args]);
    expect(result.status).toBe(126);
    expect(JSON.parse(result.stdout)).toEqual({ allowed: false, required: expect.objectContaining({ id: requiredCapability }) });
  });

  it.each([
    ['git', ['status']],
    ['git', ['log', '--oneline']],
    ['gh', ['pr', 'view', '12']],
    ['gh', ['api', 'repos/org/repo/pulls/12']],
  ] as const)('leaves read-only %s %j untouched', (name, args) => {
    expect(check(name, [...args]).status).toBe(0);
  });

  it('requires an unexpired exact capability', () => {
    expect(check('git', ['push'], { push: new Date(Date.now() + 60_000).toISOString() }).status).toBe(0);
    expect(check('git', ['push'], { pr_review: new Date(Date.now() + 60_000).toISOString() }).status).toBe(126);
    expect(check('git', ['push'], { push: new Date(Date.now() - 1).toISOString() }).status).toBe(126);
  });

  it('reads the current turn capability from a mode-0600 file', () => {
    const processGuard = createExternalActionProcessGuard({ granted: false, operation: null });
    temporaryDirectories.push(dirname(processGuard.capabilityFile));
    writeTurnCapability(processGuard, { push: new Date(Date.now() + 60_000).toISOString() });
    expect(statSync(processGuard.capabilityFile).mode & 0o777).toBe(0o600);
    expect(checkWithGuard('git', ['push'], processGuard).status).toBe(0);
  });

  it('refuses a push after the turn capability file is cleared', () => {
    const processGuard = createExternalActionProcessGuard({ granted: false, operation: null });
    temporaryDirectories.push(dirname(processGuard.capabilityFile));
    writeTurnCapability(processGuard, { push: new Date(Date.now() + 60_000).toISOString() });
    clearTurnCapability(processGuard);
    expect(checkWithGuard('git', ['push'], processGuard).status).toBe(126);
  });

  it('refuses an expired capability from the turn file', () => {
    const processGuard = createExternalActionProcessGuard({ granted: false, operation: null });
    temporaryDirectories.push(dirname(processGuard.capabilityFile));
    writeTurnCapability(processGuard, { push: new Date(Date.now() - 1).toISOString() });
    expect(checkWithGuard('git', ['push'], processGuard).status).toBe(126);
  });

  it('keeps the environment-only capability fallback', () => {
    expect(check('git', ['push'], { push: new Date(Date.now() + 60_000).toISOString() }).status).toBe(0);
  });

  it('accepts the existing scoped capabilities that include the guarded operation', () => {
    const active = new Date(Date.now() + 60_000).toISOString();
    expect(check('git', ['push'], { pr_create: active }).status).toBe(0);
    expect(check('git', ['push', '--delete', 'origin', 'old'], { remote_branch: active }).status).toBe(0);
    expect(check('gh', ['api', '-X', 'POST', 'repos/org/repo/issues/12/comments'], { github_issue: active }).status).toBe(0);
  });

  it('records a refused push for the run timeline channel', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const item = repository.create({ title: 'Guard', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
    const message = repository.createSharedMessage('codex', '', 'running', conversation.id);
    const run = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Push it.', conversation.id, message.id);
    const processGuard = createExternalActionProcessGuard({ granted: false, operation: null });
    const stop = observeExternalActionRefusals(processGuard, (refusal) => recordExternalActionRefusal(repository, run, refusal));
    const result = spawnSync(process.execPath, [guard, bin('git'), 'push'], {
      encoding: 'utf8', env: { ...process.env, ...externalActionGuardEnvironment(processGuard) },
    });
    stop();
    expect(result.status).toBe(126);
    expect(result.stderr).toBe('refused: git push (needs capability push)\n');
    expect(repository.listAgentStreamEvents(conversation.id).map((event) => event.detail)).toEqual(['refused: git push (needs capability push)']);
    expect(database.prepare('SELECT detail_json FROM agent_run_diagnostics WHERE run_id = ?').get(run.id)).toBeTruthy();
    database.close();
  });

  it('pushes successfully to a scratch local remote with capability', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-guard-test-'));
    temporaryDirectories.push(directory);
    const remote = join(directory, 'remote.git');
    const source = join(directory, 'source');
    expect(spawnSync('git', ['init', '--bare', remote]).status).toBe(0);
    expect(spawnSync('git', ['init', source]).status).toBe(0);
    expect(spawnSync('git', ['-C', source, 'commit', '--allow-empty', '-m', 'scratch'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).status).toBe(0);
    expect(spawnSync('git', ['-C', source, 'remote', 'add', 'origin', remote]).status).toBe(0);
    const result = spawnSync(bin('git'), ['push', 'origin', 'HEAD:refs/heads/main'], {
      cwd: source,
      encoding: 'utf8',
      env: { ...environmentWithoutCapabilityFile(), WORKBENCH_EXTERNAL_CAPABILITY: JSON.stringify({ push: new Date(Date.now() + 60_000).toISOString() }) },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', 'refs/heads/main']).status).toBe(0);
  });
});
