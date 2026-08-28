import { memo } from 'react';
import { Check, Circle } from 'lucide-react';
import { confidenceProminence, confidenceTone, type DiffConfidenceAssessment } from '../diff-confidence.js';
import type { ReviewDecision, ReviewDecisionAssessments } from './logic.js';
import { reviewStateLabel } from './logic.js';

/** The model's score for this decision. Undefined is "still scoring", which is
 * shown rather than silently rendered as a zero. */
function QueueRiskScore({ assessment }: { assessment: DiffConfidenceAssessment | undefined }) {
  const risk = assessment ? assessment.risk : null;
  const tone = confidenceTone(risk);
  const { fontWeight } = confidenceProminence(risk);
  const label = !assessment ? 'AI risk assessment pending'
    : risk === null ? 'AI risk assessment unavailable'
      : `AI risk ${risk} out of 100`;
  return <span className="diff-review-queue-risk-score" style={{ color: tone, borderColor: tone, fontWeight }}
    aria-label={label} title={assessment && risk !== null ? `AI risk ${risk}/100 · ${assessment.reasoning}` : label}>
    {!assessment ? '…' : risk === null ? '--' : risk}
  </span>;
}

function StateIcon({ state }: { state: ReviewDecision['state'] }) {
  return state === null ? <Circle size={11} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />;
}

export const DiffReviewDecisionQueue = memo(function DiffReviewDecisionQueue({ decisions, assessments, selectedId, onSelect }: {
  decisions: ReviewDecision[];
  assessments: ReviewDecisionAssessments;
  selectedId: string;
  onSelect: (decisionId: string) => void;
}) {
  return <div className="diff-review-queue-region">
    <nav className="diff-review-decision-queue" aria-label="Review decision queue">
      <span>Decision queue · AI risk order</span>
      <ol>{decisions.map((decision, index) => <li key={decision.id}>
        <button type="button" className={decision.id === selectedId ? 'selected' : ''} aria-current={decision.id === selectedId ? 'step' : undefined} onClick={() => onSelect(decision.id)}>
          <span className={`diff-review-decision-state state-${decision.state ?? 'pending'}`}><StateIcon state={decision.state} /><span className="visually-hidden">{reviewStateLabel(decision.state)}</span></span>
          <span><b>Decision {index + 1}</b><small>{decision.behavior}</small></span>
          <em><QueueRiskScore assessment={assessments[decision.id]} />{decision.hunks.length === 1 ? decision.hunks[0].location : `${decision.hunks.length} hunks`}</em>
        </button>
      </li>)}</ol>
    </nav>
  </div>;
});
