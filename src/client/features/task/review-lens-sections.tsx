import { memo } from 'react';
import { escapedAttacks, type ReviewLensLedgers } from '../../../shared/review-harness.js';

/** The two lenses of one review run, shown apart because they never share findings. */
export const ReviewLensSections = memo(function ReviewLensSections({ lenses }: { lenses: ReviewLensLedgers }) {
  const findings = lenses.correctness.ledger?.passes.flatMap((pass) => pass.findings.map((finding) => ({ pass: pass.pass, ...finding }))) ?? [];
  const { adversarial } = lenses;
  const escaped = escapedAttacks(adversarial.ledger);

  return <div className="run-review-lenses">
    <section className="run-review-lens" aria-label="Correctness lens">
      <span className="section-label">Correctness lens · {lenses.correctness.agent}</span>
      {lenses.correctness.ledger
        ? <p>{findings.length === 0 ? 'No findings across five passes.' : `${findings.length} finding${findings.length === 1 ? '' : 's'} across five passes.`}</p>
        : <p>No valid ledger was recorded.</p>}
      {findings.length > 0 && <ul>{findings.map((finding, index) => <li key={index}>Pass {finding.pass} · {finding.severity} · D{finding.decision}: {finding.finding}</li>)}</ul>}
    </section>
    <section className="run-review-lens" aria-label="Adversarial lens">
      <span className="section-label">Adversarial lens · {adversarial.agent}</span>
      {adversarial.ledger
        ? <p>{adversarial.ledger.attacks.length} attack{adversarial.ledger.attacks.length === 1 ? '' : 's'}, {escaped.length} escaped.</p>
        : <p>No ledger: {adversarial.error ?? 'the lens returned nothing.'}</p>}
      {adversarial.ledger && <ul>{adversarial.ledger.attacks.map((attack, index) => <li key={index} className={`attack-${attack.result}`}>
        <strong>{attack.result === 'escaped' ? 'Escaped' : 'Held'}</strong> · {attack.targetClaim}. Attack: {attack.method} Evidence: {attack.evidence}
      </li>)}</ul>}
    </section>
  </div>;
});
