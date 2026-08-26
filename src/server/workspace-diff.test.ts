import { describe, expect, it } from 'vitest';
import { parseWorkspacePatch, workspaceStatuses } from './workspace-diff.js';

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
});
