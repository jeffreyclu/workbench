import { describe, expect, it } from 'vitest';
import { buildReviewDecisions } from './logic.js';
import { buildDiffSearchIndex, DIFF_SEARCH_LIMIT, searchDiffIndex, stepMatchIndex } from './diff-search.js';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';

const file = (path: string, patch: string): WorkspaceDiffFile => ({ path, previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch });
const files = [
  file('src/alpha.ts', '@@ -1,3 +1,3 @@ alphaBehavior\n context Needle one\n-removed needle\n+added value'),
  file('src/beta.ts', '@@ -5,2 +5,2 @@ betaBehavior\n-old\n+fresh NEEDLE here'),
];
const index = buildDiffSearchIndex(files, buildReviewDecisions(files, []));

describe('find in diff', () => {
  it('finds matching lines across file boundaries, case-insensitively, in file then line order', () => {
    const { matches, truncated } = searchDiffIndex(index, 'needle');
    expect(truncated).toBe(false);
    expect(matches.map((match) => [match.filePath, match.kind, match.lineNumber, match.text])).toEqual([
      ['src/alpha.ts', 'context', 1, ' context Needle one'.slice(1)],
      ['src/alpha.ts', 'deletion', 2, 'removed needle'],
      ['src/beta.ts', 'addition', 5, 'fresh NEEDLE here'],
    ]);
    expect(matches[2]?.start).toBe(6);
    expect(new Set(matches.map((match) => match.id)).size).toBe(3);
  });

  it('ties every match to the decision that owns its hunk', () => {
    const decisions = buildReviewDecisions(files, []);
    const { matches } = searchDiffIndex(index, 'fresh');
    expect(decisions.find((decision) => decision.id === matches[0]?.decisionId)?.filePaths).toEqual(['src/beta.ts']);
  });

  it('matches nothing for a blank query and ignores the diff markers', () => {
    expect(searchDiffIndex(index, '   ').matches).toEqual([]);
    expect(searchDiffIndex(index, '+added').matches).toEqual([]);
  });

  it('stops at the limit and says it was cut short', () => {
    const many = file('src/many.ts', `@@ -1,1 +1,${DIFF_SEARCH_LIMIT + 5} @@ many\n${Array.from({ length: DIFF_SEARCH_LIMIT + 5 }, () => '+needle').join('\n')}`);
    const result = searchDiffIndex(buildDiffSearchIndex([many], buildReviewDecisions([many], [])), 'needle');
    expect(result.matches).toHaveLength(DIFF_SEARCH_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it('wraps stepping and starts from either end before anything was visited', () => {
    expect(stepMatchIndex(-1, 3, 1)).toBe(0);
    expect(stepMatchIndex(-1, 3, -1)).toBe(2);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(0, 0, 1)).toBe(0);
  });
});
