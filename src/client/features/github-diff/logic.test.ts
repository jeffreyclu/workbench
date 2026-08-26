import { describe, expect, it } from 'vitest';
import { fileLabel, parsePatch, pullRequestUrl } from './logic.js';

describe('GitHub diff presentation logic', () => {
  it('selects only GitHub pull-request URLs from linked task sources', () => {
    expect(pullRequestUrl(['https://linear.app/writer/issue/ENG-1', 'https://github.com/writer/workbench/pull/42/files'])).toBe('https://github.com/writer/workbench/pull/42/files');
    expect(pullRequestUrl(['https://github.com/writer/workbench/issues/42'])).toBeNull();
  });

  it('numbers unified patch additions and deletions on their respective sides', () => {
    expect(parsePatch('@@ -3,2 +3,3 @@\n one\n-old\n+new\n+last')).toEqual([
      expect.objectContaining({ kind: 'header', oldLine: null, newLine: null }),
      expect.objectContaining({ kind: 'context', oldLine: 3, newLine: 3, text: ' one' }),
      expect.objectContaining({ kind: 'deletion', oldLine: 4, newLine: null, text: '-old' }),
      expect.objectContaining({ kind: 'addition', oldLine: null, newLine: 4, text: '+new' }),
      expect.objectContaining({ kind: 'addition', oldLine: null, newLine: 5, text: '+last' }),
    ]);
  });

  it('shows both paths for renamed files', () => {
    expect(fileLabel({ path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed' })).toBe('src/old.ts → src/new.ts');
  });

  it('does not number GitHub’s no-final-newline patch annotation', () => {
    expect(parsePatch('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new')).toEqual([
      expect.objectContaining({ kind: 'header' }),
      expect.objectContaining({ kind: 'deletion', oldLine: 1, newLine: null }),
      expect.objectContaining({ kind: 'context', oldLine: null, newLine: null, text: '\\ No newline at end of file' }),
      expect.objectContaining({ kind: 'addition', oldLine: null, newLine: 1 }),
    ]);
  });
});
