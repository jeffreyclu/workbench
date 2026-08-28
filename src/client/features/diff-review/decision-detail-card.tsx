import { memo, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { sourceClient } from '../../data/source-client.js';
import type { ReviewDecision } from './logic.js';
import { reviewStateLabel } from './logic.js';

export type ReviewAssistAction = 'explain' | 'what_could_break' | 'compare_task_intent';
export type ReviewAssistTaskIntent = { title: string; description: string } | null;

const ACTION_LABELS: Record<ReviewAssistAction, string> = {
  explain: 'Explain this decision',
  what_could_break: 'What could break?',
  compare_task_intent: 'Compare against task intent',
};

/** Assistance is on demand only: nothing here fires until the reviewer clicks
 * one of these buttons, and a failed turn stays visible with its own retry
 * rather than folding into a neutral placeholder. */
export const DiffReviewDecisionDetailCard = memo(function DiffReviewDecisionDetailCard({ decision, taskIntent, children }: {
  decision: ReviewDecision;
  taskIntent: ReviewAssistTaskIntent;
  children: ReactNode;
}) {
  const assist = useMutation({
    mutationFn: (action: ReviewAssistAction) => sourceClient.requestReviewAssist({
      action,
      decision: {
        behavior: decision.behavior,
        state: reviewStateLabel(decision.state),
        hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines })),
      },
      taskIntent,
    }).then((response) => response.answer),
  });

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
    <section className="diff-review-ai-assist" aria-labelledby="diff-review-ai-assist-title">
      <h4 id="diff-review-ai-assist-title">AI assist</h4>
      <div className="diff-review-ai-assist-actions">
        {(Object.keys(ACTION_LABELS) as ReviewAssistAction[]).map((action) => <button
          key={action}
          type="button"
          disabled={assist.isPending || (action === 'compare_task_intent' && !taskIntent)}
          title={action === 'compare_task_intent' && !taskIntent ? 'No task is linked to this review.' : undefined}
          onClick={() => assist.mutate(action)}
        >{ACTION_LABELS[action]}</button>)}
      </div>
      {assist.isPending && <p role="status">Asking the model…</p>}
      {assist.isError && <div className="diff-review-ai-assist-error" role="alert">
        <p>{assist.error instanceof Error ? assist.error.message : 'AI assist failed.'}</p>
        <button type="button" onClick={() => assist.variables && assist.mutate(assist.variables)}>Retry</button>
      </div>}
      {assist.isSuccess && <p className="diff-review-ai-assist-answer">{assist.data}</p>}
    </section>
    {children}
  </article>;
});
