import { memo } from 'react';
import { HIGH_RISK_THRESHOLD } from '../diff-review-logic.js';
import type { ReviewDecision, ReviewDecisionAssessments } from './logic.js';

export const DiffReviewSummaryView = memo(function DiffReviewSummaryView({ decisions, assessments }: {
  decisions: ReviewDecision[];
  assessments: ReviewDecisionAssessments;
}) {
  const fileCount = new Set(decisions.flatMap((decision) => decision.filePaths)).size;
  const completed = decisions.filter((decision) => decision.state !== null).length;
  const flagged = decisions.filter((decision) => (assessments[decision.id]?.risk ?? -1) >= HIGH_RISK_THRESHOLD).length;
  const scoring = decisions.filter((decision) => !assessments[decision.id]).length;
  const decisionLabel = `${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;

  return <section className="diff-review-summary" aria-label={`${decisionLabel}, ${completed} completed`}>
    <div>
      <strong>{decisionLabel}</strong>
      <span>{completed} completed · {decisions.length - completed} pending{flagged > 0 ? ` · ${flagged} AI high-risk` : ''}{scoring > 0 ? ` · scoring ${scoring}` : ''}</span>
    </div>
    <progress value={completed} max={Math.max(decisions.length, 1)} aria-label={`${completed} of ${decisions.length} decisions completed`} />
  </section>;
});
