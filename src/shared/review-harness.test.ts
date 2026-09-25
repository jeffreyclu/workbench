import { describe, expect, it } from 'vitest';
import type { DiffHunkReview, WorkspaceDiffFile } from './contracts.js';
import { createReviewDirectorPlan } from './review-director.js';
import {
  AGENT_REVIEW_NOTE_PREFIX,
  buildReviewHarness,
  mergeAgentVerdict,
  parseReviewLedger,
  REVIEW_PASSES,
  reviewHarnessPrompt,
  reviewHarnessVerdicts,
  reviewHarnessViolations,
  stripReviewLedger,
  carryReviewLedger,
  type ReviewHarness,
} from './review-harness.js';

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

const FILES = [
  file('src/auth.ts', '@@ -1 +1 @@ authorize\n-return deny(request);\n+return authorize(request);'),
  file('src/auth.test.ts', '@@ -1 +1 @@ authorize\n-expect(result).toBe(false);\n+expect(result).toBe(true);'),
];

function harness(reviews: DiffHunkReview[] = []): ReviewHarness {
  return buildReviewHarness({ source: { kind: 'workspace', workspacePath: '/repo' }, revision: 'rev-1', files: FILES, reviews });
}

function review(passes: Array<{ clear: number[]; findings?: Array<{ decision: number; severity: 'blocking' | 'non-blocking'; finding: string }> }>): string {
  const sections = passes.map((pass, index) => {
    const findings = pass.findings ?? [];
    const body = findings.length
      ? findings.map((finding) => `- ${finding.severity === 'blocking' ? 'Blocking' : 'Non-blocking'}: ${finding.finding}`).join('\n')
      : 'No material issues.';
    return `### ${REVIEW_PASSES[index].heading}\n${body}`;
  });
  const ledger = { version: 1, passes: passes.map((pass, index) => ({ pass: index + 1, clear: pass.clear, findings: pass.findings ?? [] })) };
  return `Reject.\n\n${sections.join('\n\n')}\n\n<review-ledger>${JSON.stringify(ledger)}</review-ledger>`;
}

describe('review harness', () => {
  it('builds the Review Director queue deterministically, in its priority order', () => {
    const first = harness();
    const second = harness();
    const plan = createReviewDirectorPlan(FILES, []);

    expect(first.required.map((decision) => decision.decisionId)).toEqual(plan.orderedDecisions.map((decision) => decision.id));
    expect(second.required).toEqual(first.required);
    expect(reviewHarnessPrompt(second)).toBe(reviewHarnessPrompt(first));
    expect(first.required[0]).toMatchObject({ tier: 'T3' });
    expect(first.required[0].obligations.length).toBeGreaterThan(0);
  });

  it('keeps proof-settled decisions out of the required coverage', () => {
    const settled = buildReviewHarness({
      source: { kind: 'workspace', workspacePath: '/repo' },
      revision: 'rev-1',
      files: [...FILES, file('docs/guide.md', '@@ -1 +1 @@\n-Old wording.\n+New wording.')],
      reviews: [],
    });
    const plan = createReviewDirectorPlan(settled.files, []);
    const proofSettled = plan.entries.filter((entry) => entry.routing.autoSettled).map((entry) => entry.decision.ordinal);

    expect(proofSettled.length).toBeGreaterThan(0);
    expect(settled.settled.map((entry) => entry.ordinal)).toEqual(proofSettled);
    expect(settled.required.some((decision) => proofSettled.includes(decision.ordinal))).toBe(false);
  });

  it('renders all five passes and every required decision into the prompt', () => {
    const prompt = reviewHarnessPrompt(harness());
    for (const pass of REVIEW_PASSES) expect(prompt).toContain(pass.heading);
    for (const decision of harness().required) expect(prompt).toContain(`D${decision.ordinal} · ${decision.tier}`);
    expect(prompt).toContain('<review-ledger>');
  });

  it('accepts a review that checks every decision in every pass', () => {
    const ordinals = harness().required.map((decision) => decision.ordinal);
    const output = review(REVIEW_PASSES.map(() => ({ clear: ordinals })));
    expect(reviewHarnessViolations(harness(), output)).toEqual([]);
  });

  it('rejects a missing ledger, a skipped pass, and a skipped decision', () => {
    const ordinals = harness().required.map((decision) => decision.ordinal);
    expect(reviewHarnessViolations(harness(), '### Pass 1\nNo material issues.')).toEqual(['The review has no <review-ledger> block.']);

    const fourPasses = review(REVIEW_PASSES.slice(0, 4).map(() => ({ clear: ordinals })));
    expect(reviewHarnessViolations(harness(), fourPasses)[0]).toMatch(/passes 1, 2, 3, 4, 5 once each/);

    const skipped = review(REVIEW_PASSES.map((pass) => ({ clear: pass.number === 3 ? ordinals.slice(1) : ordinals })));
    expect(reviewHarnessViolations(harness(), skipped)).toEqual([`Pass 3 skipped D${ordinals[0]}.`]);
  });

  it('rejects prose that disagrees with the ledger and decisions the harness never listed', () => {
    const ordinals = harness().required.map((decision) => decision.ordinal);
    const output = review(REVIEW_PASSES.map(() => ({ clear: ordinals })))
      .replace('"pass":2,"clear":[', `"pass":2,"clear":[99,`)
      .replace(/### Pass 5 — Is it safe\?\nNo material issues\./, '### Pass 5 — Is it safe?\n- Blocking: token leaks.');
    expect(reviewHarnessViolations(harness(), output)).toEqual([
      'Pass 2 names decisions that are not in the harness: D99.',
      'Pass 5 lists findings in prose but none in its ledger.',
    ]);
  });

  it('turns findings into queue verdicts and leaves clear decisions for Jeffrey', () => {
    const [first, second] = harness().required.map((decision) => decision.ordinal);
    const output = review(REVIEW_PASSES.map((pass) => pass.number === 1
      ? { clear: [], findings: [{ decision: first, severity: 'blocking', finding: 'Allows every request (src/auth.ts:1).' }, { decision: second, severity: 'non-blocking', finding: 'Rename the test (src/auth.test.ts:1).' }] }
      : { clear: [first, second] }));
    const ledger = parseReviewLedger(output).ledger!;
    const verdicts = reviewHarnessVerdicts(harness(), ledger, 'codex, run abc', '2026-09-25T17:09:15.000Z');

    expect(verdicts.map((verdict) => [verdict.ordinal, verdict.state])).toEqual([[first, 'needs_changes'], [second, 'commented']]);
    expect(verdicts[0].note).toBe(`${AGENT_REVIEW_NOTE_PREFIX} (codex, run abc, 2026-09-25T17:09:15.000Z):\nPass 1 Blocking: Allows every request (src/auth.ts:1).`);

    const clean = parseReviewLedger(review(REVIEW_PASSES.map(() => ({ clear: [first, second] })))).ledger!;
    expect(reviewHarnessVerdicts(harness(), clean, 'codex', '2026-09-25T17:09:15.000Z')).toEqual([]);
  });

  it('keeps each agent verdict\'s own time when a later verdict merges into the same decision', () => {
    const [first] = harness().required.map((decision) => decision.ordinal);
    const ledger = parseReviewLedger(review(REVIEW_PASSES.map((pass) => pass.number === 1
      ? { clear: harness().required.slice(1).map((decision) => decision.ordinal), findings: [{ decision: first, severity: 'blocking', finding: 'Allows every request (src/auth.ts:1).' }] }
      : { clear: harness().required.map((decision) => decision.ordinal) }))).ledger!;
    const [claude] = reviewHarnessVerdicts(harness(), ledger, 'claude, run 02261360', '2026-09-25T17:07:24.490Z');
    const [codex] = reviewHarnessVerdicts(harness(), ledger, 'codex, run 2a85412d', '2026-09-25T17:09:15.697Z');
    const merged = mergeAgentVerdict({ state: claude.state, note: claude.note }, codex);
    expect(merged?.note).toContain(`${AGENT_REVIEW_NOTE_PREFIX} (claude, run 02261360, 2026-09-25T17:07:24.490Z):`);
    expect(merged?.note).toContain(`${AGENT_REVIEW_NOTE_PREFIX} (codex, run 2a85412d, 2026-09-25T17:09:15.697Z):`);
  });

  it('never overwrites a human verdict and merges agent verdicts strictly', () => {
    const verdict = { state: 'commented' as const, note: `${AGENT_REVIEW_NOTE_PREFIX} (claude): Pass 2 Non-blocking: cache it.` };
    expect(mergeAgentVerdict({ state: 'reviewed', note: null }, verdict)).toBeNull();
    expect(mergeAgentVerdict({ state: 'needs_changes', note: 'Jeffrey: redo this.' }, verdict)).toBeNull();
    expect(mergeAgentVerdict({ state: null, note: null }, verdict)).toEqual(verdict);
    const merged = mergeAgentVerdict({ state: 'needs_changes', note: `${AGENT_REVIEW_NOTE_PREFIX} (codex): Pass 1 Blocking: broken.` }, verdict);
    expect(merged?.state).toBe('needs_changes');
    expect(merged?.note).toContain('Pass 1 Blocking: broken.');
    expect(merged?.note).toContain('Pass 2 Non-blocking: cache it.');
    expect(mergeAgentVerdict({ state: 'commented', note: verdict.note }, verdict)).toBeNull();
  });

  it('carries a validated ledger through a brevity rewrite that dropped it', () => {
    const ordinals = harness().required.map((decision) => decision.ordinal);
    const original = review(REVIEW_PASSES.map(() => ({ clear: ordinals })));
    const rewritten = carryReviewLedger(original, stripReviewLedger(original));
    expect(reviewHarnessViolations(harness(), rewritten)).toEqual([]);
    expect(carryReviewLedger(original, original)).toBe(original);
  });

  it('strips the ledger from what Jeffrey reads', () => {
    const ordinals = harness().required.map((decision) => decision.ordinal);
    const stripped = stripReviewLedger(review(REVIEW_PASSES.map(() => ({ clear: ordinals }))));
    expect(stripped).not.toContain('review-ledger');
    expect(stripped).toContain('### Pass 5 — Is it safe?');
  });

  it('still requires five passes over the whole change when the diff is unavailable', () => {
    const unavailable = buildReviewHarness({ source: { kind: 'unavailable', reason: 'No brokered diff.' }, revision: null, files: [], reviews: [] });
    expect(reviewHarnessPrompt(unavailable)).toContain('Unavailable: No brokered diff.');
    expect(reviewHarnessViolations(unavailable, review(REVIEW_PASSES.map(() => ({ clear: [] }))))).toEqual([]);
    expect(reviewHarnessViolations(unavailable, review(REVIEW_PASSES.slice(0, 2).map(() => ({ clear: [] }))))[0]).toMatch(/once each, in order/);
  });
});
