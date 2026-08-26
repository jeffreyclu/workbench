import { describe, expect, it } from 'vitest';
import { parseWorkspacePatch } from './workspace-diff.js';

describe('workspace diff parsing', () => {
  it('returns reviewable file patches with line totals and status', () => {
    const patch = 'diff --git a/src/example.ts b/src/example.ts\nindex 111..222 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n';
    expect(parseWorkspacePatch(patch, new Map([['src/example.ts', 'modified']]))).toEqual([expect.objectContaining({ path: 'src/example.ts', status: 'modified', additions: 1, deletions: 1, isBinary: false })]);
  });

  it('does not render binary payloads as text', () => {
    const patch = 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n';
    expect(parseWorkspacePatch(patch)).toEqual([expect.objectContaining({ path: 'image.png', isBinary: true, patch: null })]);
  });
});
