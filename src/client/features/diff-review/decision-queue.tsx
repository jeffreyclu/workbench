import { memo } from 'react';
import { Check, Circle, FileDiff } from 'lucide-react';
import type { ReviewDecision, ReviewFileQueueItem } from './logic.js';
import { reviewStateLabel } from './logic.js';

function StateIcon({ state }: { state: ReviewDecision['state'] }) {
  return state === null ? <Circle size={11} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />;
}

export const DiffReviewDecisionQueue = memo(function DiffReviewDecisionQueue({ decisions, files, selectedId, onSelect }: {
  decisions: ReviewDecision[];
  files: ReviewFileQueueItem[];
  selectedId: string;
  onSelect: (decisionId: string) => void;
}) {
  const selectedFiles = decisions.find((decision) => decision.id === selectedId)?.filePaths ?? [];
  return <div className="diff-review-queue-region">
    <nav className="diff-review-file-rail" aria-label="Review files by queue priority">
      <span>Files by priority</span>
      <div>{files.map((file) => {
        const firstDecision = decisions.find((decision) => decision.filePaths.includes(file.path));
        return <button key={file.path} type="button" className={selectedFiles.includes(file.path) ? 'selected' : ''} onClick={() => firstDecision && onSelect(firstDecision.id)}>
          <FileDiff size={13} aria-hidden="true" />
          <span>{file.path}</span>
          <small className={`diff-review-file-state state-${file.state}`}>{file.state === 'approved' ? 'Approved' : `${file.completed}/${file.decisions}`}</small>
          {file.riskSignals.length > 0 && <b aria-label={`${file.riskSignals.length} risk signals`}>{file.riskSignals.length}</b>}
        </button>;
      })}</div>
    </nav>
    <nav className="diff-review-decision-queue" aria-label="Review decision queue">
      <span>Decision queue</span>
      <ol>{decisions.map((decision, index) => <li key={decision.id}>
        <button type="button" className={decision.id === selectedId ? 'selected' : ''} aria-current={decision.id === selectedId ? 'step' : undefined} onClick={() => onSelect(decision.id)}>
          <span className={`diff-review-decision-state state-${decision.state ?? 'pending'}`}><StateIcon state={decision.state} /><span className="visually-hidden">{reviewStateLabel(decision.state)}</span></span>
          <span><b>Decision {index + 1}</b><small>{decision.behavior}</small></span>
          <em>{decision.hunks.length === 1 ? decision.hunks[0].location : `${decision.hunks.length} hunks`}</em>
        </button>
      </li>)}</ol>
    </nav>
  </div>;
});
