import { memo, type ReactNode } from 'react';
import { DiffConfidenceBubble } from '../diff-confidence-bubble.js';
import type { DiffConfidenceAssessment } from '../diff-confidence.js';
import type { ReviewDecision } from './logic.js';
import { reviewStateLabel } from './logic.js';

export const DiffReviewDecisionDetailCard = memo(function DiffReviewDecisionDetailCard({ decision, assessment, children }: {
  decision: ReviewDecision;
  assessment: DiffConfidenceAssessment | undefined;
  children: ReactNode;
}) {
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
    <section className="diff-review-ai-risk" aria-labelledby="diff-review-ai-risk-title">
      <h4 id="diff-review-ai-risk-title">AI risk</h4>
      <div>
        <DiffConfidenceBubble assessment={assessment ?? null} />
        <p>{!assessment ? 'The model is scoring this decision.'
          : assessment.risk === null ? 'AI assessment unavailable for this decision.'
            : assessment.reasoning}</p>
      </div>
    </section>
    {children}
  </article>;
});
