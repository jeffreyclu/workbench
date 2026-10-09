import { describe, expect, it } from 'vitest';
import { buildFileDiffHunks } from './logic.js';
import { isWhitespaceOnlyHunk } from './whitespace.js';

describe('isWhitespaceOnlyHunk', () => {
  it('matches added and removed lines after whitespace is ignored', () => {
    const [hunk] = buildFileDiffHunks({ path: 'src/example.ts', isBinary: false, patch: ['@@ -1 +1 @@', '-  const value = call();', '+const    value=call();'].join('\n') });
    expect(isWhitespaceOnlyHunk(hunk)).toBe(true);
  });

  it('keeps a hunk that changes non-whitespace text', () => {
    const [hunk] = buildFileDiffHunks({ path: 'src/example.ts', isBinary: false, patch: ['@@ -1 +1 @@', '-const value = before;', '+const value = after;'].join('\n') });
    expect(isWhitespaceOnlyHunk(hunk)).toBe(false);
  });
});
