import { describe, expect, it } from 'vitest';
import type { WorkspaceDiffFile } from './contracts.js';
import { createReviewDirectorPlan, deferDelegatedReviewDecisions, nextReviewDirectorDecisionId, REVIEW_DIRECTOR_CRITICAL_ACTIONS } from './review-director.js';

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

  it('delegates a human-owned decision once its AI risk score is 20 or lower', () => {
    const initial = createReviewDirectorPlan([
      file('src/auth.ts', '@@ -1 +1 @@ authorize\n-return deny(request);\n+return authorize(request);'),
    ], []);
    const decision = initial.decisions[0];
    const rescored = createReviewDirectorPlan([
      file('src/auth.ts', '@@ -1 +1 @@ authorize\n-return deny(request);\n+return authorize(request);'),
    ], [], new Map([[decision.id, 2]]));

    expect(initial.entries[0]).toMatchObject({ tier: 'T3', delegated: false });
    expect(rescored.entries[0]).toMatchObject({ tier: 'T1', delegated: true, autoReview: true, critical: false });
    expect(rescored.entries[0].routing.reason).toContain('2/100');
  });

  it('keeps proof-settled work behind unfinished work and never navigates back into it', () => {
    const plan = createReviewDirectorPlan([
      file('src/live.ts', '@@ -1 +1 @@ live\n-before\n+after'),
      file('src/format.ts', '@@ -1 +1 @@ format\n-const value = 1;\n+const value=1;'),
    ], []);
    const active = plan.entries.find((entry) => !entry.routing.autoSettled)!;
    const automatic = plan.entries.find((entry) => entry.routing.autoSettled)!;

    expect(plan.orderedDecisions.map((decision) => decision.id)).toEqual([active.decision.id, automatic.decision.id]);
    expect(nextReviewDirectorDecisionId(plan, active.decision.id)).toBeNull();
  });

  it('puts every decision claimed by delegation behind human-owned work without disturbing either priority order', () => {
    const plan = createReviewDirectorPlan([
      file('src/first.ts', '@@ -1 +1 @@ first\n-before\n+after'),
      file('src/second.ts', '@@ -1 +1 @@ second\n-before\n+after'),
      file('src/third.ts', '@@ -1 +1 @@ third\n-before\n+after'),
      file('src/fourth.ts', '@@ -1 +1 @@ fourth\n-before\n+after'),
    ], []);
    const [first, second, third, fourth] = plan.orderedDecisions;
    const claimed = new Set([first.id, third.id]);

    expect(deferDelegatedReviewDecisions(plan.orderedDecisions, claimed).map((decision) => decision.id))
      .toEqual([second.id, fourth.id, first.id, third.id]);
  });

  it('auto-advances through human-owned decisions before work claimed by delegation', () => {
    const plan = createReviewDirectorPlan([
      file('src/first.ts', '@@ -1 +1 @@ first\n-before\n+after'),
      file('src/second.ts', '@@ -1 +1 @@ second\n-before\n+after'),
      file('src/third.ts', '@@ -1 +1 @@ third\n-before\n+after'),
    ], []);
    const [first, second, third] = plan.orderedDecisions;

    expect(nextReviewDirectorDecisionId(plan, second.id, new Set([first.id]))).toBe(third.id);
  });

  it('makes a many-hunk lockfile one last-place delegated decision', () => {
    const plan = createReviewDirectorPlan([
      file('pnpm-lock.yaml', '@@ -10 +10 @@ importers:\n-old-a\n+new-a\n@@ -100 +100 @@ packages:\n-old-b\n+new-b'),
      file('src/feature.ts', '@@ -1 +1 @@ feature\n-before\n+after'),
    ], []);
    const lockfile = plan.entries.find((entry) => entry.decision.filePaths[0] === 'pnpm-lock.yaml');

    expect(lockfile).toMatchObject({ tier: 'T1', delegated: true, autoReview: true });
    expect(lockfile?.decision.hunks).toHaveLength(2);
    expect(plan.orderedDecisions.at(-1)?.id).toBe(lockfile?.decision.id);
  });
});
