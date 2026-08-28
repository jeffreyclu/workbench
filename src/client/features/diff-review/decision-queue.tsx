import { memo, useEffect, useRef } from 'react';
import { Check, Circle, MessageSquare, TriangleAlert } from 'lucide-react';
import type { ReviewDecision } from './logic.js';
import { reviewStateLabel, reviewStateShortLabel, riskSignalLabel } from './logic.js';

function StateIcon({ state }: { state: ReviewDecision['state'] }) {
  if (state === 'reviewed') return <Check size={14} aria-hidden="true" />;
  if (state === 'needs_changes') return <TriangleAlert size={13} aria-hidden="true" />;
  if (state === 'commented') return <MessageSquare size={13} aria-hidden="true" />;
  return <Circle size={11} aria-hidden="true" />;
}

/** The queue reorders settled decisions to its tail, so a reviewer scrolling
 * back through it must be able to tell "I already handled this" without opening
 * the card. Every settled decision therefore carries three redundant cues — a
 * state-coloured rail, a distinct icon, and a written chip — because colour
 * alone is not readable for everyone and an icon alone was too quiet. */
export const DiffReviewDecisionQueue = memo(function DiffReviewDecisionQueue({ decisions, selectedId, onSelect }: {
  decisions: ReviewDecision[];
  selectedId: string;
  onSelect: (decisionId: string) => void;
}) {
  const settled = decisions.filter((decision) => decision.state !== null).length;
  const selectedButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // A decision can become selected from outside this queue (clicking a
    // highlighted hunk in the diff pane), so the queue must bring its own
    // selection into view rather than assuming the reviewer scrolled here first.
    selectedButton.current?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedId]);

  return <div className="diff-review-queue-region">
    <nav className="diff-review-decision-queue" aria-label="Review decision queue">
      <span>Decision queue<small>{settled} of {decisions.length} reviewed</small></span>
      <ol>{decisions.map((decision) => <li key={decision.id}>
        <button type="button" ref={decision.id === selectedId ? selectedButton : undefined} className={`state-${decision.state ?? 'pending'}${decision.state === null ? '' : ' settled'}${decision.id === selectedId ? ' selected' : ''}`} aria-current={decision.id === selectedId ? 'step' : undefined} onClick={() => onSelect(decision.id)}>
          <span className={`diff-review-decision-state state-${decision.state ?? 'pending'}`} aria-label={reviewStateLabel(decision.state)}><StateIcon state={decision.state} /><small>{reviewStateShortLabel(decision.state)}</small></span>
          <span><b>Decision {decision.ordinal}</b><small>{decision.behavior}</small></span>
          <em>{decision.hunks.length === 1 ? decision.hunks[0].location : `${decision.hunks.length} hunks`}{decision.riskSignals.length > 0 && <span className="diff-review-queue-risk-score" title={decision.riskSignals.map(riskSignalLabel).join(', ')}>{decision.riskSignals.length}</span>}</em>
        </button>
      </li>)}</ol>
    </nav>
  </div>;
});
