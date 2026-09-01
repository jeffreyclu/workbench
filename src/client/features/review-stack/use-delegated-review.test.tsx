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
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ answer }), { headers: { 'Content-Type': 'application/json' } }));
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

function decisionsAcross(count: number): ReviewDecision[] {
  return buildReviewDecisions(Array.from({ length: count }, (_, index) => file(`src/app-${index}.ts`, [
    '@@ -1,2 +1,3 @@',
    ' const start = 1;',
    `+const limit${index} = 2;`,
    ' export const done = true;',
  ].join('\n'))), []);
}

/** The same sweep, with the switch that a refetch flips underneath it. */
function GatedHarness({ targets, enabled, onAutoReview }: { targets: DelegationTarget[]; enabled: boolean; onAutoReview: (target: DelegationTarget) => void }) {
  useDelegatedReview({ targets, siblings: [], taskIntent: null, revision: 'rev-1', enabled, onAutoReview });
  return null;
}

/** The same sweep, reporting the changes it says are still owed an answer. */
function PendingHarness({ targets, onPending }: { targets: DelegationTarget[]; onPending: (pending: ReadonlySet<string>) => void }) {
  const progress = useDelegatedReview({ targets, siblings: [], taskIntent: null, revision: 'rev-1', enabled: true });
  onPending(progress.pending);
  return null;
}

describe('useDelegatedReview', () => {
  // A running count told a reviewer that some sweep was working; it never told
  // them whether the change they were looking at was the one still waiting.
  it('names the change whose delegated turn is in flight and stops naming it once answered', async () => {
    let deliver: (() => void) | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      await new Promise<void>((resolve) => { deliver = resolve; });
      return new Response(JSON.stringify({ answer: CONFIDENT }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const [decision] = decisions();
    const seen: ReadonlySet<string>[] = [];
    render(<PendingHarness targets={[{ decisionId: decision.id, decision, tier: 'T1' }]} onPending={(pending) => seen.push(pending)} />);
    await settle();

    expect(seen.at(-1)!.has(decision.id)).toBe(true);

    await act(async () => { deliver?.(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(seen.at(-1)!.has(decision.id)).toBe(false);
  });

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

  // The failure this exists for: the review stack reads its revision off a
  // query, so one render with the diff still in flight turns the sweep off and
  // straight back on. Claims are taken before the request leaves, so a sweep
  // that dies holding them leaves every change it had not reached marked
  // attempted and unasked — the first two answers land and the rest of the
  // revision is never delegated at all.
  it('gives back what an interrupted sweep never spent and finishes the revision', async () => {
    const gates: Array<() => void> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      return new Response(JSON.stringify({ answer: CONFIDENT }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const open = async () => {
      const waiting = gates.splice(0);
      for (const resolve of waiting) resolve();
      await settle();
    };

    const all = decisionsAcross(4);
    expect(all).toHaveLength(4);
    const targets: DelegationTarget[] = all.map((decision) => ({ decisionId: decision.id, decision, tier: 'T1' }));
    const autoReviewed: string[] = [];
    const record = (target: DelegationTarget) => { autoReviewed.push(target.decisionId); };

    const view = render(<GatedHarness targets={targets} enabled onAutoReview={record} />);
    await settle();
    // Two workers are in flight; the other two changes are claimed and queued.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.rerender(<GatedHarness targets={targets} enabled={false} onAutoReview={record} />);
    await settle();
    await open();

    view.rerender(<GatedHarness targets={targets} enabled onAutoReview={record} />);
    await settle();
    for (let round = 0; round < 6 && autoReviewed.length < 4; round += 1) await open();

    expect([...autoReviewed].sort()).toEqual(all.map((decision) => decision.id).sort());
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
