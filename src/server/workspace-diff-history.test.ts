import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { captureRecordedWorkspaceDiffSnapshots } from './workspace-diff-history.js';

const directories: string[] = [];

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-diff-history-'));
  directories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'workbench@example.com'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Workbench'], { cwd: directory });
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('recorded workspace diff history', () => {
  it('persists only a commit explicitly recorded in the owning conversation', async () => {
    const directory = workspace();
    writeFileSync(join(directory, 'file.ts'), 'export const version = 1;\n');
    execFileSync('git', ['add', 'file.ts'], { cwd: directory });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: directory });
    writeFileSync(join(directory, 'file.ts'), 'export const version = 2;\n');
    execFileSync('git', ['commit', '--all', '--quiet', '-m', 'recorded change'], { cwd: directory });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const conversation = repository.createConversation('Recorded diff');
    repository.createSharedMessage('codex', `Implemented and promoted \`${commit.slice(0, 7)}\`.`, 'completed', conversation.id);

    await captureRecordedWorkspaceDiffSnapshots(repository, { conversationId: conversation.id }, directory, [conversation.id]);

    expect(repository.listWorkspaceDiffSnapshots({ conversationId: conversation.id })).toEqual([
      expect.objectContaining({ revision: `commit:${commit}`, diff: expect.objectContaining({ changedFiles: 1, files: [expect.objectContaining({ path: 'file.ts' })] }) }),
    ]);
    database.close();
  });
});
