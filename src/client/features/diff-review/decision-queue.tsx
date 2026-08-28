import { memo } from 'react';
import { Check, Circle } from 'lucide-react';
import type { ReviewDecision } from './logic.js';
import { reviewStateLabel } from './logic.js';

function StateIcon({ state }: { state: ReviewDecision['state'] }) {
  return state === null ? <Circle size={11} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />;
}

export const DiffReviewDecisionQueue = memo(function DiffReviewDecisionQueue({ decisions, selectedId, onSelect }: {
  decisions: ReviewDecision[];
  selectedId: string;
  onSelect: (decisionId: string) => void;
}) {
  return <div className="diff-review-queue-region">
    <nav className="diff-review-decision-queue" aria-label="Review decision queue">
      <span>Decision queue</span>
      <ol>{decisions.map((decision) => <li key={decision.id}>
        <button type="button" className={decision.id === selectedId ? 'selected' : ''} aria-current={decision.id === selectedId ? 'step' : undefined} onClick={() => onSelect(decision.id)}>
          <span className={`diff-review-decision-state state-${decision.state ?? 'pending'}`}><StateIcon state={decision.state} /><span className="visually-hidden">{reviewStateLabel(decision.state)}</span></span>
          <span><b>Decision {decision.ordinal}</b><small>{decision.behavior}</small></span>
          <em>{decision.hunks.length === 1 ? decision.hunks[0].location : `${decision.hunks.length} hunks`}</em>
        </button>
      </li>)}</ol>
    </nav>
  </div>;
});
