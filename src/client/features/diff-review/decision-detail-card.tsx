import { memo, type ReactNode } from 'react';
import type { ReviewDecision } from './logic.js';
import { reviewStateLabel, riskSignalLabel } from './logic.js';

export const DiffReviewDecisionDetailCard = memo(function DiffReviewDecisionDetailCard({ decision, children }: { decision: ReviewDecision; children: ReactNode }) {
  return <article className="diff-review-decision-card" aria-labelledby="diff-review-decision-title">
    <header>
      <div>
        <span className="diff-review-decision-eyebrow">Behavior decision</span>
        <h3 id="diff-review-decision-title">{decision.behavior}</h3>
      </div>
      <span className={`diff-review-completion-state state-${decision.state ?? 'pending'}`}>{reviewStateLabel(decision.state)}</span>
    </header>
    <section className="diff-review-exact-change" aria-labelledby="diff-review-exact-change-title">
      <h4 id="diff-review-exact-change-title">Exact change</h4>
      <div>
        <small>Highlighted in the diff · {decision.hunks.length === 1 ? decision.hunks[0].location : `${decision.hunks.length} hunks`} · <b>+{decision.additions}</b> <i>−{decision.deletions}</i></small>
      </div>
    </section>
    <section className="diff-review-risks" aria-labelledby="diff-review-risks-title">
      <h4 id="diff-review-risks-title">Risk signals</h4>
      {decision.riskSignals.length > 0
        ? <ul>{decision.riskSignals.map((signal) => <li key={signal}>{riskSignalLabel(signal)}</li>)}</ul>
        : <p>No static risk signals detected.</p>}
    </section>
    {decision.note && <section className="diff-review-saved-note"><h4>Review note</h4><p>{decision.note}</p></section>}
    {children}
  </article>;
});
