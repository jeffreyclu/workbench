// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewLensLedgers } from '../../../shared/review-harness.js';
import { ReviewLensSections } from './review-lens-sections.js';

const lenses: ReviewLensLedgers = {
  tier: 'standard',
  correctness: { agent: 'claude', ledger: { version: 1, passes: [{ pass: 1, clear: [], findings: [{ decision: 1, severity: 'blocking', finding: 'Off by one in a.ts:3.' }] }] } },
  adversarial: {
    agent: 'codex', baseSha: 'abc', summary: '', error: null,
    ledger: { version: 1, attacks: [{ targetClaim: 'No double charge', method: 'Replay the request', result: 'escaped', evidence: 'b.ts:9 has no idempotency key.' }] },
  },
};

describe('ReviewLensSections', () => {
  afterEach(cleanup);

  it('shows the correctness and adversarial lenses as separate sections', () => {
    render(<ReviewLensSections lenses={lenses} />);
    expect(screen.getByLabelText('Correctness lens').textContent).toContain('Off by one in a.ts:3.');
    expect(screen.getByLabelText('Correctness lens').textContent).not.toContain('idempotency');
    expect(screen.getByLabelText('Adversarial lens').textContent).toContain('1 attack, 1 escaped.');
    expect(screen.getByLabelText('Adversarial lens').textContent).not.toContain('Off by one');
  });

  it('names why the adversarial lens has no ledger', () => {
    render(<ReviewLensSections lenses={{ ...lenses, adversarial: { ...lenses.adversarial, ledger: null, error: 'There was no diff to attack.' } }} />);
    expect(screen.getByLabelText('Adversarial lens').textContent).toContain('There was no diff to attack.');
  });
});
