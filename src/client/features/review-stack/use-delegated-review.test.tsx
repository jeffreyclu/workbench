// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_ASSIST_CONFIDENCE_PREFIX, REVIEW_ASSIST_MISSING_PREFIX, type WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildReviewDecisions, type ReviewDecision } from '../../../shared/review-decisions.js';
import { delegationOutcome, isDelegatedTier, type DelegationTarget } from './review-delegation.js';
import { useDelegatedReview } from './use-delegated-review.js';

const CONFIDENT = `It renames a local.\n${REVIEW_ASSIST_CONFIDENCE_PREFIX} high`;
const UNCONFIDENT = `It might touch callers.\n${REVIEW_ASSIST_CONFIDENCE_PREFIX} low\n${REVIEW_ASSIST_MISSING_PREFIX} the call sites outside this diff`;

function file(path: string, patch: string): WorkspaceDiffFile {
  return { path, status: 'modified', additions: 0, deletions: 0, previousPath: null, patch, isBinary: false, editorUrl: null };
}

function decisions(): ReviewDecision[] {
  return buildReviewDecisions([file('src/app.ts', [
    '@@ -1,2 +1,3 @@',
    ' const start = 1;',
    '+const limit = 2;',
    ' export const done = true;',
  ].join('\n'))], []);
}

/** Mounts the sweep the way both tabs do and reports what it spent. */
function Harness({ targets, onAutoReview }: { targets: DelegationTarget[]; onAutoReview: (target: DelegationTarget) => void }) {
  useDelegatedReview({ targets, siblings: [], taskIntent: null, revision: 'rev-1', enabled: true, onAutoReview });
  return null;
}

function stubAssist(answer: string) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ answer }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delegation policy', () => {
  it('delegates the tiers the reviewer does not open first, and only those', () => {
    expect(isDelegatedTier('T1')).toBe(true);
    expect(isDelegatedTier('T2')).toBe(true);
    // T0 is already settled by proof and T3 is what Jeffrey reads himself.
    expect(isDelegatedTier('T0')).toBe(false);
    expect(isDelegatedTier('T3')).toBe(false);
  });

  it('lets a confident T1 answer close its change and never lets T2 close one', () => {
    expect(delegationOutcome('T1', CONFIDENT).autoReview).toBe(true);
    expect(delegationOutcome('T2', CONFIDENT).autoReview).toBe(false);
  });

  it('keeps an unconfident answer owed and carries what it lacked', () => {
    const outcome = delegationOutcome('T1', UNCONFIDENT);
    expect(outcome.autoReview).toBe(false);
    expect(outcome.escalation).toContain('call sites outside this diff');
  });

  it('treats a failed turn as no evidence rather than a sign-off', () => {
    expect(delegationOutcome('T1', null).autoReview).toBe(false);
    expect(delegationOutcome('T1', '').autoReview).toBe(false);
  });
});

describe('useDelegatedReview', () => {
  it('buys one answer per change and records the verdict a confident one earned', async () => {
    const fetchMock = stubAssist(CONFIDENT);
    const [decision] = decisions();
    const targets: DelegationTarget[] = [{ decisionId: decision.id, decision, tier: 'T1' }];
    const autoReviewed: string[] = [];
    const view = render(<Harness targets={targets} onAutoReview={(target) => autoReviewed.push(target.decisionId)} />);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/review-assist');
    expect(autoReviewed).toEqual([decision.id]);

    // A re-render with an equivalent target list must not buy the same answer
    // again: the attempt is claimed before the request leaves.
    view.rerender(<Harness targets={[{ decisionId: decision.id, decision, tier: 'T1' }]} onAutoReview={(target) => autoReviewed.push(target.decisionId)} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(autoReviewed).toEqual([decision.id]);
  });

  it('spends the turn on a T2 change but leaves the verdict to the reviewer', async () => {
    stubAssist(CONFIDENT);
    const [decision] = decisions();
    const autoReviewed: string[] = [];
    render(<Harness targets={[{ decisionId: decision.id, decision, tier: 'T2' }]} onAutoReview={(target) => autoReviewed.push(target.decisionId)} />);
    await settle();
    expect(autoReviewed).toEqual([]);
  });

  it('leaves a change owed when the delegated answer is not confident', async () => {
    stubAssist(UNCONFIDENT);
    const [decision] = decisions();
    const autoReviewed: string[] = [];
    render(<Harness targets={[{ decisionId: decision.id, decision, tier: 'T1' }]} onAutoReview={(target) => autoReviewed.push(target.decisionId)} />);
    await settle();
    expect(autoReviewed).toEqual([]);
  });
});
