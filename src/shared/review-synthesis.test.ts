import { describe, expect, it } from 'vitest';
import type { ReviewLedger } from './review-harness.js';
import { renderReviewSynthesis, stripFolds } from './review-synthesis.js';

const blocking = (decision: number, file = `src/f${decision}.ts`) => ({
  decision, severity: 'blocking' as const, finding: `D${decision} breaks`, location: `${file}:${decision}`, consequence: `D${decision} loses data`, fix: `guard D${decision}`,
});

function ledger(pass1: ReviewLedger['passes'][number]['findings'], pass2: ReviewLedger['passes'][number]['findings'] = []): ReviewLedger {
  return { version: 1, passes: [1, 2, 3, 4, 5].map((pass) => ({ pass, clear: [], findings: pass === 1 ? pass1 : pass === 2 ? pass2 : [] })) };
}

describe('renderReviewSynthesis', () => {
  const agreed = [1, 2, 3, 4, 5, 6, 7].map((decision) => blocking(decision));
  const rendered = renderReviewSynthesis({
    reviewers: ['codex', 'claude'],
    ledgers: [
      ledger(agreed, [blocking(9, 'src/only-codex.ts')]),
      ledger([...agreed, { decision: 8, severity: 'non-blocking', finding: 'rename it', location: 'src/f8.ts:8' }]),
    ],
    adversarial: { version: 1, attacks: [
      { targetClaim: 'claim', method: 'replay', result: 'escaped', evidence: 'src/a.ts:1' },
      { targetClaim: 'claim 2', method: 'race', result: 'held', evidence: 'src/b.ts:2' },
    ] },
  });

  it('puts the disagreement first, then five blocking lines, then folds', () => {
    expect(rendered.indexOf('Reviewers disagree (1)')).toBe(0);
    expect(rendered).toContain('src/only-codex.ts:9 (Pass 2): codex says blocking');
    expect(rendered.indexOf('Blocking (7)')).toBeGreaterThan(rendered.indexOf('Reviewers disagree'));
    const visible = stripFolds(rendered);
    expect(visible.match(/^- src\/f\d\.ts:\d — D\d loses data\. Fix: guard D\d\.$/gm)).toHaveLength(5);
    expect(rendered).toContain(':::fold 2 further blocking findings');
    expect(rendered).toContain(':::fold 1 non-blocking');
    expect(rendered).toContain(':::fold Adversarial: 2 attacks, 1 escaped');
    expect(rendered).toContain(':::fold Pass coverage');
  });

  it('keeps the folded findings and the five pass headings', () => {
    expect(rendered).toContain('- src/f6.ts:6 — D6 loses data. Fix: guard D6.');
    expect(stripFolds(rendered)).not.toContain('src/f6.ts');
    for (const pass of [1, 2, 3, 4, 5]) expect(rendered).toContain(`### Pass ${pass} —`);
    expect(rendered).toContain('No material issues.');
  });

  it('demotes a blocking finding with no stateable consequence', () => {
    const vague = renderReviewSynthesis({
      reviewers: ['codex', 'claude'],
      ledgers: [ledger([{ decision: 1, severity: 'blocking', finding: 'feels wrong' }]), ledger([{ decision: 1, severity: 'blocking', finding: 'feels wrong' }])],
    });
    expect(vague).toContain('Blocking: none.');
    expect(vague).toContain(':::fold 2 non-blocking');
    expect(vague).toContain('Blocking: feels wrong');
  });
});
