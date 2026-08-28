import { describe, expect, it } from 'vitest';
import type { DiffHunkReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildFileDiffHunks, buildReviewDecisions, nextPendingDecisionId, orderReviewDecisions } from './logic.js';

const localFile: WorkspaceDiffFile = {
  path: 'src/local.ts', status: 'modified', additions: 1, deletions: 1, previousPath: null,
  patch: '@@ -2 +2 @@ localValue\n-before\n+after', isBinary: false,
};

const authFile: WorkspaceDiffFile = {
  path: 'src/server/auth/routes.ts', status: 'modified', additions: 3, deletions: 1, previousPath: null,
  patch: '@@ -10 +10,3 @@ function authorizeRequest()\n-export function authorizeRequest() {}\n+export async function authorizeRequest() {\n+  await repository.update(session)\n+  throw new Error("denied")', isBinary: false,
};

const authTestFile: WorkspaceDiffFile = {
  path: 'src/server/auth/routes.test.ts', status: 'modified', additions: 1, deletions: 1, previousPath: null,
  patch: '@@ -30 +30 @@ describe("authorizeRequest")\n-expect(authorizeRequest()).toBe(false)\n+await expect(authorizeRequest()).rejects.toThrow()', isBinary: false,
};

describe('diff review queue logic', () => {
  it('derives plain-English behavior and retains exact reviewable hunk content', () => {
    const [decision] = buildReviewDecisions([authFile], []);

    expect(decision).toMatchObject({
      id: 'src/server/auth/routes.ts::@@ -10 +10,3 @@ function authorizeRequest()',
      subject: 'authorizeRequest',
      behavior: 'Changes authorize request access checks.',
      filePaths: ['src/server/auth/routes.ts'],
      additions: 3,
      deletions: 1,
      state: null,
    });
    expect(decision.hunks[0]).toMatchObject({
      hunkRange: '@@ -10 +10,3 @@ function authorizeRequest()',
      location: 'Lines 10–12',
      lines: expect.arrayContaining(['+  throw new Error("denied")']),
    });
    expect(decision.riskSignals).toEqual(['public_api', 'persistence', 'auth', 'error_path']);
  });

  it('groups the same concrete symbol across files and keeps partial legacy state pending', () => {
    const review: DiffHunkReview = {
      id: 'review-1', revision: 'rev-1', filePath: authFile.path,
      hunkRange: '@@ -10 +10,3 @@ function authorizeRequest()', state: 'reviewed', note: null,
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const decisions = buildReviewDecisions([authFile, authTestFile], [review]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      behavior: 'Changes authorize request access checks across 2 files.',
      filePaths: ['src/server/auth/routes.ts', 'src/server/auth/routes.test.ts'],
      state: null,
    });
    expect(decisions[0].hunks).toHaveLength(2);
    expect(decisions[0].riskSignals).toContain('cross_file');
  });

  it('orders pending high-risk decisions first', () => {
    const decisions = buildReviewDecisions([localFile, authFile], []);
    expect(orderReviewDecisions(decisions).map((decision) => decision.filePaths[0])).toEqual([
      'src/server/auth/routes.ts',
      'src/local.ts',
    ]);
  });

  it('advances to the next pending decision before cycling through completed decisions', () => {
    const ordered = orderReviewDecisions(buildReviewDecisions([localFile, authFile], []));
    expect(nextPendingDecisionId(ordered, ordered[0].id)).toBe(ordered[1].id);
  });
});

describe('whole-file diff blocks', () => {
  it('keeps every patch line with real line numbers and links each block to its decision', () => {
    const file: WorkspaceDiffFile = {
      path: 'src/local.ts', status: 'modified', additions: 2, deletions: 1, previousPath: null, isBinary: false,
      patch: '@@ -4,3 +4,4 @@ localValue\n const kept = 1\n-const removed = 2\n+const added = 2\n+const alsoAdded = 3\n@@ -20,2 +21,2 @@ other\n context\n+tail',
    };

    const [first, second] = buildFileDiffHunks(file);

    expect(first.decisionId).toBe(buildReviewDecisions([file], [])[0].id);
    expect(first.location).toBe('Lines 4\u20137');
    expect(first).toMatchObject({ additions: 2, deletions: 1 });
    expect(first.lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ['context', 4, 4, ' const kept = 1'],
      ['deletion', 5, null, '-const removed = 2'],
      ['addition', null, 5, '+const added = 2'],
      ['addition', null, 6, '+const alsoAdded = 3'],
    ]);
    expect(second.lines.map((line) => line.newLine)).toEqual([21, 22]);
  });

  it('reports a single readable block when the patch is unavailable', () => {
    const binary = buildFileDiffHunks({ path: 'logo.png', patch: null, isBinary: true });

    expect(binary).toHaveLength(1);
    expect(binary[0]).toMatchObject({ range: 'Binary file', decisionId: 'logo.png::Binary file', lines: [] });
  });
});
