import { memo, useEffect, useRef } from 'react';
import { Check, MessageSquare, TriangleAlert } from 'lucide-react';
import type { ReviewDecision } from './logic.js';
import { reviewStateLabel, riskSignalLabel } from './logic.js';

function StateIcon({ state }: { state: ReviewDecision['state'] }) {
  if (state === 'reviewed') return <Check size={11} aria-hidden="true" />;
  if (state === 'needs_changes') return <TriangleAlert size={10} aria-hidden="true" />;
  if (state === 'commented') return <MessageSquare size={10} aria-hidden="true" />;
  return null;
}

/**
 * A ribbon of numbered chips, not a list of cards. Every decision is already
 * described where it lives — on its gutter marker in the diff and in the
 * popover — so repeating the title, behavior and location for all of them made
 * the queue tall without telling a reviewer anything new. Only the selected
 * chip expands to its behavior sentence.
 *
 * The queue reorders settled decisions to its tail, so a reviewer scrolling
 * back through it must still be able to tell "I already handled this" without
 * opening anything. Each settled chip therefore keeps redundant cues — a
 * state-coloured fill, a distinct icon, and the written state in its accessible
 * name — because colour alone is not readable for everyone.
 */
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
    // Clicking a highlighted hunk must land keyboard/screen-reader focus on its
    // matching decision here too, not just scroll it into view.
    selectedButton.current?.focus?.({ preventScroll: true });
  }, [selectedId]);

  return <div className="diff-review-queue-region">
    <nav className="diff-review-decision-queue" aria-label="Review decision queue">
      <span>Decision queue<small>{settled} of {decisions.length} reviewed</small></span>
      <ol>{decisions.map((decision) => {
        const selected = decision.id === selectedId;
        const risks = decision.riskSignals.map(riskSignalLabel);
        return <li key={decision.id}>
          <button
            type="button"
            ref={selected ? selectedButton : undefined}
            className={`state-${decision.state ?? 'pending'}${decision.state === null ? '' : ' settled'}${selected ? ' selected' : ''}`}
            aria-current={selected ? 'step' : undefined}
            aria-label={`Decision ${decision.ordinal}: ${decision.behavior} — ${reviewStateLabel(decision.state)}${risks.length > 0 ? ` · ${risks.length} risk signals` : ''}`}
            onClick={() => onSelect(decision.id)}
          >
            <b>{decision.ordinal}</b>
            <StateIcon state={decision.state} />
            {risks.length > 0 && <span className="diff-review-queue-risk-dot" title={risks.join(', ')} aria-hidden="true" />}
            {selected && <small>{decision.behavior}</small>}
          </button>
        </li>;
      })}</ol>
    </nav>
  </div>;
});
