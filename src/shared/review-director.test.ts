import { describe, expect, it } from 'vitest';
import type { WorkspaceDiffFile } from './contracts.js';
import { createReviewDirectorPlan, REVIEW_DIRECTOR_CRITICAL_ACTIONS } from './review-director.js';

function file(path: string, patch: string): WorkspaceDiffFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: patch.split('\n').filter((line) => line.startsWith('+')).length,
    deletions: patch.split('\n').filter((line) => line.startsWith('-')).length,
    isBinary: false,
    patch,
  };
}

describe('Review Director', () => {
  it('creates one prioritized plan and pushes test changes behind production code', () => {
    const plan = createReviewDirectorPlan([
      file('src/auth.ts', '@@ -1 +1 @@ authorize\n-return allow(request);\n+return authorize(request);'),
      file('src/auth.test.ts', '@@ -1 +1 @@ authorize\n-expect(result).toBe(false);\n+expect(result).toBe(true);'),
    ], []);

    expect(plan.orderedDecisions.map((decision) => decision.filePaths[0])).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    const test = plan.entries.find((entry) => entry.decision.changeType === 'test_only');
    expect(test).toMatchObject({ tier: 'T1', delegated: true, autoReview: true });
    expect(test?.routing.autoSettled).toBe(false);
  });

  it('marks the critical tier for complete background enrichment', () => {
    const plan = createReviewDirectorPlan([
      file('src/auth.ts', '@@ -1 +1 @@ authorize\n-return deny(request);\n+return authorize(request);'),
    ], []);

    const critical = plan.entries[0];
    expect(critical).toMatchObject({ tier: 'T3', critical: true, delegated: false, autoReview: false });
    expect(critical.enrichmentActions).toEqual(REVIEW_DIRECTOR_CRITICAL_ACTIONS);
    expect(plan.criticalDecisionIds.has(critical.decision.id)).toBe(true);
  });
});
