import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndPushWorkspace, getWorkspaceBranchDiff, getWorkspaceCommitDiff, getWorkspaceDiff, getWorkspaceFileSource, getWorkspaceRefDiff, getWorkspaceWorktreeDiff, listWorkspaceRefs, parseWorkspacePatch, parseWorktreeList, resolveWorkspaceRepository, workspaceEditorUrl, workspaceStatuses } from './workspace-diff.js';

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
  it('recovers a repository root when persisted workspace state names a deleted subdirectory', () => {
    const workspace = temporaryGitWorkspace();
    const stalePath = join(workspace, 'src', 'client', 'features', 'diff', 'views');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    expect(resolveWorkspaceRepository(stalePath)).toBe(workspace);
  });

  it('creates editor deep links only for files in an available local checkout', () => {
    const workspace = temporaryGitWorkspace();
    writeFileSync(join(workspace, 'file with spaces.ts'), 'export {};\n');

    expect(workspaceEditorUrl(workspace, 'file with spaces.ts')).toBe(`vscode://file/${encodeURI(join(workspace, 'file with spaces.ts'))}`);
    expect(workspaceEditorUrl(workspace, 'missing.ts')).toBe(`vscode://file/${encodeURI(join(workspace, 'missing.ts'))}`);
    expect(workspaceEditorUrl(workspace, '../outside.ts')).toBeNull();
    expect(workspaceEditorUrl(workspace, 'file with spaces.ts', 'cursor://file/{path}')).toBe(`cursor://file/${encodeURI(join(workspace, 'file with spaces.ts'))}`);
    expect(workspaceEditorUrl(join(workspace, 'missing-checkout'), 'file.ts')).toBeNull();
  });

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

  it('ignores an untracked nested repository instead of trying to diff it as a file', async () => {
    const workspace = temporaryGitWorkspace();
    writeFileSync(join(workspace, 'tracked.ts'), 'export {};\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
    const nestedRepository = join(workspace, 'node_modules');
    mkdirSync(nestedRepository);
    execFileSync('git', ['init', '--quiet'], { cwd: nestedRepository });

    await expect(getWorkspaceDiff(workspace)).resolves.toEqual(expect.objectContaining({ changedFiles: 0 }));
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

describe('binary detection', () => {
  it('keeps the patch of a text file whose own contents name the binary markers', () => {
    const patch = [
      'diff --git a/src/server/workspace-diff.ts b/src/server/workspace-diff.ts',
      'index 111..222 100644',
      '--- a/src/server/workspace-diff.ts',
      '+++ b/src/server/workspace-diff.ts',
      '@@ -100,3 +100,4 @@',
      '     const isBinary = /Binary files .* differ|GIT binary patch/.test(body);',
      '+    const logicBlocks = patchLogicBoundaries(path, body);',
      '     const counts = changedLines(body);',
    ].join('\n');
    const [file] = parseWorkspacePatch(patch);
    expect(file.isBinary).toBe(false);
    expect(file.patch).not.toBeNull();
  });

  it('still reads a real binary patch as binary', () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'index 111..222 100644',
      'GIT binary patch',
      'literal 120',
    ].join('\n');
    const [file] = parseWorkspacePatch(patch);
    expect(file.isBinary).toBe(true);
    expect(file.patch).toBeNull();
  });

  it('still reads a non-binary-flag binary diff as binary', () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'index 111..222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    expect(parseWorkspacePatch(patch)[0].isBinary).toBe(true);
  });
});


describe('whole-file source', () => {
  it('reads the working-tree copy when no revision is named', async () => {
    const workspace = temporaryGitWorkspace();
    writeFileSync(join(workspace, 'file.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', 'file.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
    // The uncommitted after-state only exists on disk, which is why an
    // uncommitted diff has to read the working tree rather than a commit.
    writeFileSync(join(workspace, 'file.ts'), 'export const one = 2;\n');

    const source = await getWorkspaceFileSource(workspace, 'file.ts');
    expect(source).toMatchObject({ path: 'file.ts', revision: null, content: 'export const one = 2;\n', unavailable: null });
  });

  it('reads a named commit rather than the working tree', async () => {
    const workspace = temporaryGitWorkspace();
    writeFileSync(join(workspace, 'file.ts'), 'export const one = 1;\n');
    execFileSync('git', ['add', 'file.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
    writeFileSync(join(workspace, 'file.ts'), 'export const one = 2;\n');

    const source = await getWorkspaceFileSource(workspace, 'file.ts', commit);
    expect(source.content).toBe('export const one = 1;\n');
  });

  it('refuses a path that climbs out of the workspace', async () => {
    const workspace = temporaryGitWorkspace();
    const escaped = await getWorkspaceFileSource(workspace, '../../etc/passwd');
    expect(escaped).toMatchObject({ content: null, unavailable: 'That path cannot be read.' });
    const absolute = await getWorkspaceFileSource(workspace, '/etc/passwd');
    expect(absolute).toMatchObject({ content: null, unavailable: 'That path cannot be read.' });
  });

  it('reports an unreadable file as a reason rather than throwing', async () => {
    const workspace = temporaryGitWorkspace();
    const missing = await getWorkspaceFileSource(workspace, 'gone.ts');
    expect(missing).toMatchObject({ content: null, unavailable: 'This file is not in the working tree.' });

    writeFileSync(join(workspace, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const binary = await getWorkspaceFileSource(workspace, 'logo.png');
    expect(binary).toMatchObject({ content: null, unavailable: 'This file is binary.' });
  });
});

describe('branch and worktree review sources', () => {
  function repositoryWithBase() {
    const workspace = temporaryGitWorkspace();
    writeFileSync(join(workspace, 'file.ts'), 'const value = 1;\n');
    execFileSync('git', ['add', 'file.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
    // git init picks main or master depending on the host config; pin the base
    // so the test asserts against a known comparison branch either way.
    execFileSync('git', ['branch', '--move', 'main'], { cwd: workspace });
    return workspace;
  }

  it('reads a worktree list, naming the checkout it was asked about as current', () => {
    const worktrees = parseWorktreeList(
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def\ndetached\n',
      '/repo',
    );
    expect(worktrees).toEqual([
      { path: '/repo', branch: 'main', current: true },
      { path: '/repo-feature', branch: null, current: false },
    ]);
  });

  it('lists other branches with how far ahead of the base they are, and omits the base itself', async () => {
    const workspace = repositoryWithBase();
    execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: workspace });
    writeFileSync(join(workspace, 'file.ts'), 'const value = 2;\n');
    execFileSync('git', ['commit', '--all', '--quiet', '-m', 'branch work'], { cwd: workspace });
    execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: workspace });

    const refs = await listWorkspaceRefs(workspace);
    expect(refs.base).toBe('main');
    expect(refs.branches).toEqual([{ name: 'feature', current: false, ahead: 1 }]);
    expect(refs.worktrees).toEqual([{ path: expect.any(String), branch: 'main', current: true }]);
  });

  it('diffs a branch against its merge base rather than against the current checkout', async () => {
    const workspace = repositoryWithBase();
    execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: workspace });
    writeFileSync(join(workspace, 'file.ts'), 'const value = 2;\n');
    execFileSync('git', ['commit', '--all', '--quiet', '-m', 'branch work'], { cwd: workspace });
    execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: workspace });
    // Work landing on the base after the branch left must not show up as the
    // branch's own change.
    writeFileSync(join(workspace, 'other.ts'), 'const other = 1;\n');
    execFileSync('git', ['add', 'other.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '--quiet', '-m', 'base moved on'], { cwd: workspace });

    const diff = await getWorkspaceBranchDiff(workspace, 'feature');
    expect(diff.branch).toBe('feature');
    expect(diff.files.map((file) => file.path)).toEqual(['file.ts']);
    expect(diff.revision).toMatch(/^branch:feature:[0-9a-f]{40}\.\.[0-9a-f]{40}$/);
    expect(diff.publish.hasChanges).toBe(false);
  });

  it('reads a linked worktree\'s own uncommitted changes', async () => {
    const workspace = repositoryWithBase();
    const linked = `${workspace}-linked`;
    temporaryDirectories.push(linked);
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'linked', linked], { cwd: workspace });
    writeFileSync(join(linked, 'file.ts'), 'const value = 3;\n');

    const diff = await getWorkspaceWorktreeDiff(workspace, linked);
    expect(diff.branch).toBe('linked');
    expect(diff.files.map((file) => file.path)).toEqual(['file.ts']);
    // The primary checkout is untouched by reading a sibling.
    expect((await getWorkspaceDiff(workspace)).changedFiles).toBe(0);
  });

  it('refuses a path git never reported as a worktree', async () => {
    const workspace = repositoryWithBase();
    await expect(getWorkspaceRefDiff(workspace, 'worktree:/etc')).rejects.toThrow('not a worktree of this repository');
  });

  it('refuses a source id it does not recognise', async () => {
    const workspace = repositoryWithBase();
    await expect(getWorkspaceRefDiff(workspace, 'nonsense')).rejects.toThrow('Unrecognised review source');
  });
});
