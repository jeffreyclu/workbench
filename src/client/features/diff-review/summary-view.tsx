import { memo } from 'react';
import type { ReviewDecision } from './logic.js';

export const DiffReviewSummaryView = memo(function DiffReviewSummaryView({ decisions }: { decisions: ReviewDecision[] }) {
  const fileCount = new Set(decisions.flatMap((decision) => decision.filePaths)).size;
  const completed = decisions.filter((decision) => decision.state !== null).length;
  const decisionLabel = `${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;

  return <section className="diff-review-summary" aria-label={`${decisionLabel}, ${completed} completed`}>
    <div>
      <strong>{decisionLabel}</strong>
      <span>{completed} completed · {decisions.length - completed} pending</span>
    </div>
    <progress value={completed} max={Math.max(decisions.length, 1)} aria-label={`${completed} of ${decisions.length} decisions completed`} />
  </section>;
});
