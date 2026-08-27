import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndPushWorkspace, getWorkspaceCommitDiff, getWorkspaceDiff, parseWorkspacePatch, workspaceStatuses } from './workspace-diff.js';

const temporaryDirectories: string[] = [];

function temporaryGitWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-workspace-diff-'));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'workbench@example.com'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Workbench'], { cwd: directory });
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('workspace diff parsing', () => {
  it('returns reviewable file patches with line totals and status', () => {
    const patch = 'diff --git a/src/example.ts b/src/example.ts\nindex 111..222 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n';
    expect(parseWorkspacePatch(patch, new Map([['src/example.ts', 'modified']]))).toEqual([expect.objectContaining({ path: 'src/example.ts', status: 'modified', additions: 1, deletions: 1, isBinary: false })]);
  });

  it('does not render binary payloads as text', () => {
    const patch = 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n';
    expect(parseWorkspacePatch(patch)).toEqual([expect.objectContaining({ path: 'image.png', isBinary: true, patch: null })]);
  });

  it('matches rename metadata to the added and removed files emitted without rename detection', () => {
    const statuses = workspaceStatuses('R  renamed.ts\0original.ts\0');
    const patch = 'diff --git a/original.ts b/original.ts\ndeleted file mode 100644\n--- a/original.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git a/renamed.ts b/renamed.ts\nnew file mode 100644\n--- /dev/null\n+++ b/renamed.ts\n@@ -0,0 +1 @@\n+new\n';

    expect(parseWorkspacePatch(patch, statuses)).toEqual([
      expect.objectContaining({ path: 'original.ts', status: 'removed' }),
      expect.objectContaining({ path: 'renamed.ts', status: 'added' }),
    ]);
  });

  it('handles a copy porcelain record without treating its original path as a status record', () => {
    expect([...workspaceStatuses('C  copy.ts\0source.ts\0')]).toEqual([['copy.ts', 'added']]);
  });

  it('reads a patch larger than the previous 8 MiB output limit', async () => {
    const workspace = temporaryGitWorkspace();
    const file = join(workspace, 'large.ts');
    writeFileSync(file, 'export const payload = \'before\';\n');
    execFileSync('git', ['add', 'large.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });

    // One added line is concise enough for the parsed diff, but still makes
    // git emit more than the legacy 8 MiB process buffer.
    writeFileSync(file, `export const payload = '${'a'.repeat(8 * 1024 * 1024)}';\n`);

    const diff = await getWorkspaceDiff(workspace);

    expect(diff.changedFiles).toBe(1);
    expect(diff.files[0]).toEqual(expect.objectContaining({ path: 'large.ts', status: 'modified' }));
    expect(diff.files[0].patch?.length).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('rebuilds a reviewable snapshot from a recorded commit after the workspace is clean', async () => {
    const workspace = temporaryGitWorkspace();
    writeFileSync(join(workspace, 'file.ts'), 'export const version = 1;\n');
    execFileSync('git', ['add', 'file.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
    writeFileSync(join(workspace, 'file.ts'), 'export const version = 2;\n');
    execFileSync('git', ['commit', '--all', '--quiet', '-m', 'recorded change'], { cwd: workspace });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const diff = await getWorkspaceCommitDiff(workspace, commit.slice(0, 7));

    expect(diff).toEqual(expect.objectContaining({ revision: `commit:${commit}`, changedFiles: 1, additions: 1, deletions: 1 }));
    expect(diff.files).toEqual([expect.objectContaining({ path: 'file.ts', status: 'modified', patch: expect.stringContaining('+export const version = 2;') })]);
  });

  it('stages, commits, and pushes the current branch when the workspace has an origin', async () => {
    const workspace = temporaryGitWorkspace();
    const remote = mkdtempSync(join(tmpdir(), 'workbench-workspace-remote-'));
    temporaryDirectories.push(remote);
    execFileSync('git', ['init', '--bare', '--quiet'], { cwd: remote });
    writeFileSync(join(workspace, 'file.ts'), 'export const version = 1;\n');
    execFileSync('git', ['add', 'file.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: workspace });
    execFileSync('git', ['push', '--quiet', '--set-upstream', 'origin', 'HEAD'], { cwd: workspace });
    writeFileSync(join(workspace, 'file.ts'), 'export const version = 2;\n');

    const revision = (await getWorkspaceDiff(workspace)).revision;
    await expect(commitAndPushWorkspace(workspace, 'chore: publish workspace', revision)).resolves.toEqual({ committed: true, pushed: true, commit: expect.any(String) });
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()).toBe('0');
  });
});
