import { describe, expect, it } from 'vitest';
import type { DiffHunkReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildReviewDecisions, buildReviewFileQueue, nextPendingDecisionId, orderReviewDecisions } from './logic.js';

const files: WorkspaceDiffFile[] = [
  {
    path: 'src/local.ts', status: 'modified', additions: 1, deletions: 1, previousPath: null, patch: '@@ -2 +2 @@ localValue\n-before\n+after', isBinary: false,
  },
  {
    path: 'src/server/auth/routes.ts', status: 'modified', additions: 3, deletions: 1, previousPath: null,
    patch: '@@ -10 +10,3 @@ authorizeRequest\n-export function authorizeRequest() {}\n+export async function authorizeRequest() {\n+  await repository.update(session)\n+  throw new Error("denied")\n', isBinary: false,
  },
];

describe('diff review queue logic', () => {
  it('builds one stable decision per exact hunk with behavior, location, and static risk signals', () => {
    const decisions = buildReviewDecisions(files, []);

    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      id: 'src/local.ts::@@ -2 +2 @@ localValue',
      hunkRange: '@@ -2 +2 @@ localValue',
      location: 'Line 2',
      behavior: 'Changes localValue in src/local.ts.',
      additions: 1,
      deletions: 1,
      state: null,
    });
    expect(decisions[1].riskSignals).toEqual(['public_api', 'persistence', 'auth', 'cross_file', 'error_path']);
  });

  it('orders pending high-risk decisions before raw file order and moves completed outcomes behind pending work', () => {
    const decisions = buildReviewDecisions(files, []);
    expect(orderReviewDecisions(decisions).map((decision) => decision.filePath)).toEqual([
      'src/server/auth/routes.ts',
      'src/local.ts',
    ]);

    const reviewed: DiffHunkReview = {
      id: 'review-1', revision: 'rev-1', filePath: 'src/server/auth/routes.ts', hunkRange: '@@ -10 +10,3 @@ authorizeRequest', state: 'needs_changes', note: 'Guard the failure.', updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const withReview = buildReviewDecisions(files, [reviewed]);
    expect(orderReviewDecisions(withReview).map((decision) => decision.filePath)).toEqual([
      'src/local.ts',
      'src/server/auth/routes.ts',
    ]);
    expect(buildReviewFileQueue(withReview).map((file) => [file.path, file.state])).toEqual([
      ['src/local.ts', 'pending'],
      ['src/server/auth/routes.ts', 'needs_changes'],
    ]);
  });

  it('advances to the next pending decision before cycling through completed decisions', () => {
    const decisions = buildReviewDecisions(files, []);
    const ordered = orderReviewDecisions(decisions);
    expect(nextPendingDecisionId(ordered, ordered[0].id)).toBe(ordered[1].id);
  });
});
