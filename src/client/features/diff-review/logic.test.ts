import { describe, expect, it } from 'vitest';
import type { DiffHunkReview, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { aiRiskBand, buildFileDiffHunks, buildReviewDecisions, hunkFingerprint, nextPendingDecisionId, orderReviewDecisions } from './logic.js';

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

describe('review decisions across diff revisions', () => {
  // A revision is a hash of the whole patch, so an agent writing anywhere in
  // the repository produces a new one. A decision must follow its code.
  const movedAuthFile: WorkspaceDiffFile = {
    ...authFile,
    patch: authFile.patch!.replace('@@ -10 +10,3 @@', '@@ -42 +42,3 @@'),
  };

  const carriedReview = (filePath: string, lines: string[]): DiffHunkReview => ({
    id: 'review-carried', revision: 'rev-1', filePath, hunkRange: '@@ -10 +10,3 @@ function authorizeRequest()',
    fingerprint: hunkFingerprint(filePath, lines), state: 'reviewed', note: 'Checked once.',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });

  it('carries a review onto the same code after the hunk moves to a new revision', () => {
    const original = buildReviewDecisions([authFile], [])[0];
    const [decision] = buildReviewDecisions([movedAuthFile], [carriedReview(authFile.path, original.hunks[0].lines)]);

    expect(decision.hunks[0].hunkRange).toBe('@@ -42 +42,3 @@ function authorizeRequest()');
    expect(decision).toMatchObject({ state: 'reviewed', note: 'Checked once.' });
  });

  it('leaves a decision pending once its own lines change', () => {
    const rewritten: WorkspaceDiffFile = { ...movedAuthFile, patch: movedAuthFile.patch!.replace('denied', 'forbidden') };
    const original = buildReviewDecisions([authFile], [])[0];
    const [decision] = buildReviewDecisions([rewritten], [carriedReview(authFile.path, original.hunks[0].lines)]);

    expect(decision.state).toBeNull();
  });

  it('refuses to carry a review when two hunks in the diff are byte-identical', () => {
    const duplicated: WorkspaceDiffFile = {
      path: 'src/duplicate.ts', status: 'modified', additions: 2, deletions: 0, previousPath: null,
      patch: '@@ -2 +2 @@ first\n+const flag = true;\n@@ -20 +20 @@ second\n+const flag = true;', isBinary: false,
    };
    const [first] = buildReviewDecisions([duplicated], []);
    const review: DiffHunkReview = {
      id: 'review-ambiguous', revision: 'rev-1', filePath: duplicated.path, hunkRange: '@@ -99 +99 @@ elsewhere',
      fingerprint: hunkFingerprint(duplicated.path, first.hunks[0].lines), state: 'reviewed', note: null,
      updatedAt: '2026-08-27T00:00:00.000Z',
    };

    expect(buildReviewDecisions([duplicated], [review]).every((decision) => decision.state === null)).toBe(true);
  });

  it('does not mark a hunk reviewed when an older review only shares its coordinates', () => {
    // The reviewer approved these lines at rev-1. The agent then rewrote them
    // in place, leaving the hunk range identical. Matching on coordinates alone
    // would show the rewritten code as already reviewed.
    const original = buildReviewDecisions([authFile], [])[0];
    const rewritten: WorkspaceDiffFile = { ...authFile, patch: authFile.patch!.replace('denied', 'forbidden') };
    const [decision] = buildReviewDecisions([rewritten], [carriedReview(authFile.path, original.hunks[0].lines)]);

    expect(decision.state).toBeNull();
  });

  it('carries a review to the hunk holding its code even when its old range was reused', () => {
    const original = buildReviewDecisions([authFile], [])[0];
    // rev-2 rewrote the lines at @@ -10 and the reviewed code now sits at @@ -42.
    const reshuffled: WorkspaceDiffFile = {
      ...authFile,
      patch: `${authFile.patch!.replace('denied', 'forbidden')}\n${authFile.patch!.replace('@@ -10 +10,3 @@', '@@ -42 +42,3 @@')}`,
    };
    const decisions = buildReviewDecisions([reshuffled], [carriedReview(authFile.path, original.hunks[0].lines)]);
    const moved = decisions.flatMap((decision) => decision.hunks).find((hunk) => hunk.hunkRange.startsWith('@@ -42'));
    const rewritten = decisions.flatMap((decision) => decision.hunks).find((hunk) => hunk.hunkRange.startsWith('@@ -10'));

    expect(moved?.state).toBe('reviewed');
    expect(rewritten?.state).toBeNull();
  });

  it('ignores a fingerprint recorded against a hunk that is still present at its own coordinates', () => {
    const original = buildReviewDecisions([authFile], [])[0];
    const review = carriedReview(authFile.path, original.hunks[0].lines);
    const [decision] = buildReviewDecisions([authFile], [{ ...review, state: 'needs_changes' }]);

    expect(decision.state).toBe('needs_changes');
  });
});

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
      hunkRange: '@@ -10 +10,3 @@ function authorizeRequest()', fingerprint: null, state: 'reviewed', note: null,
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

  it('pairs a new import block with the code that started using it, and leaves an unrelated import alone', () => {
    const consumerFile: WorkspaceDiffFile = {
      path: 'src/server/notify.ts', status: 'modified', additions: 4, deletions: 0, previousPath: null,
      patch: [
        "@@ -1,2 +1,3 @@",
        " import { existing } from './existing.js'",
        "+import { publishAlert } from './alerts.js'",
        " ",
        "@@ -40,2 +41,4 @@ function notifyOwner()",
        " function notifyOwner() {",
        "+  publishAlert('owner')",
        "@@ -80,1 +83,2 @@ unrelatedHelper",
        "+import { neverUsedHere } from './orphan.js'",
      ].join('\n'),
      isBinary: false,
    };

    const decisions = buildReviewDecisions([consumerFile], []);

    const paired = decisions.find((decision) => decision.hunks.some((hunk) => hunk.lines.some((line) => line.includes('publishAlert('))));
    expect(paired?.hunks.map((hunk) => hunk.hunkRange)).toEqual([
      '@@ -1,2 +1,3 @@',
      '@@ -40,2 +41,4 @@ function notifyOwner()',
    ]);
    // The behavior sentence describes the code, not the import block it carries.
    expect(paired?.subject).toBe('notifyOwner');
    // An import nothing in this diff consumes stays its own decision rather
    // than being attached to an unrelated change.
    expect(decisions.some((decision) => decision.hunks.length === 1 && decision.hunks[0].hunkRange === '@@ -80,1 +83,2 @@ unrelatedHelper')).toBe(true);
  });

  it('orders decisions deterministically by source order, ignoring static risk signals', () => {
    const decisions = buildReviewDecisions([localFile, authFile], []);
    const authDecision = decisions.find((decision) => decision.filePaths[0] === authFile.path)!;

    // The static signals all point at the auth file, but ordering never reads them.
    expect(authDecision.riskSignals).toContain('auth');
    const ordered = orderReviewDecisions(decisions);
    expect(ordered.map((decision) => decision.filePaths[0])).toEqual([localFile.path, authFile.path]);
  });

  it('sorts reviewed decisions below every unreviewed decision, then by source order', () => {
    const decisions = buildReviewDecisions([localFile, authFile], []);
    const authDecision = decisions.find((decision) => decision.filePaths[0] === authFile.path)!;
    const authReview: DiffHunkReview = {
      id: 'review-3', revision: 'rev-1', filePath: authFile.path,
      hunkRange: authDecision.hunks[0].hunkRange, fingerprint: null, state: 'reviewed', note: null,
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const reviewed = buildReviewDecisions([localFile, authFile], [authReview]);
    const ordered = orderReviewDecisions(reviewed);
    expect(ordered.map((decision) => decision.filePaths[0])).toEqual([localFile.path, authFile.path]);
    expect(ordered[ordered.length - 1].state).toBe('reviewed');
  });

  it('keeps each decision number attached to its own decision when review reorders the queue', () => {
    const decisions = buildReviewDecisions([localFile, authFile], []);
    const ordinalById = new Map(decisions.map((decision) => [decision.id, decision.ordinal]));
    expect([...ordinalById.values()]).toEqual([1, 2]);

    // Reviewing the first decision sinks it in the queue; its number goes with it.
    const authReview: DiffHunkReview = {
      id: 'review-2', revision: 'rev-1', filePath: authFile.path,
      hunkRange: '@@ -10 +10,3 @@ function authorizeRequest()', fingerprint: null, state: 'reviewed', note: null,
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const reviewed = buildReviewDecisions([localFile, authFile], [authReview]);
    const ordered = orderReviewDecisions(reviewed);

    expect(ordered[ordered.length - 1].state).toBe('reviewed');
    for (const decision of ordered) expect(decision.ordinal).toBe(ordinalById.get(decision.id));
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

describe('aiRiskBand', () => {
  it('bands a score so the number reads as severity, not arithmetic', () => {
    expect([0, 33].map(aiRiskBand)).toEqual(['low', 'low']);
    expect([34, 66].map(aiRiskBand)).toEqual(['elevated', 'elevated']);
    expect([67, 100].map(aiRiskBand)).toEqual(['high', 'high']);
  });
});
