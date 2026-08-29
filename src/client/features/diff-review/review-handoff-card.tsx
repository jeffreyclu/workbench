import { memo } from 'react';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';

export const AgentRunReviewHandoffCard = memo(function AgentRunReviewHandoffCard({ handoff }: { handoff: AgentRunReviewHandoff }) {
  const passed = handoff.verification.filter((entry) => entry.result === 'passed').length;
  const evidenceGap = 'No completed test, build, typecheck, or lint command was observed by the runner.';

  return <section className="review-handoff-card" aria-label="Agent review handoff">
    <header><div><strong>Agent handoff</strong><small>Captured {new Date(handoff.createdAt).toLocaleString()}</small></div><span>Run evidence</span></header>
    <details className="review-handoff-section"><summary>Completion summary</summary><p>{handoff.summary}</p><small>Agent-reported context only. It is not verification evidence.</small></details>
    {handoff.changes.length > 0 && <details className="review-handoff-section"><summary>Observed changes</summary><ul>{handoff.changes.map((change) => <li key={change.path}><code>{change.path}</code> — {change.summary}</li>)}</ul></details>}
    {handoff.acceptanceCriteria.length > 0 && <details className="review-handoff-section"><summary>Requested outcome</summary><ul>{handoff.acceptanceCriteria.map((criterion) => <li key={criterion.criterion}>{criterion.criterion}</li>)}</ul></details>}
    <details className="review-handoff-section"><summary>Verification</summary>
      {handoff.verification.length === 0
        ? <p className="muted">{evidenceGap}</p>
        : <><ul>{handoff.verification.map((entry, index) => <li key={`${entry.command}-${index}`} className={`review-handoff-verification-${entry.result}`}><code>{entry.command}</code> — {entry.result}{entry.exitCode !== null ? ` (exit ${entry.exitCode})` : ''}</li>)}</ul><small>{passed}/{handoff.verification.length} passed</small></>}
    </details>
    {handoff.contractChanges.length > 0 && <details className="review-handoff-section"><summary>Contract changes</summary><ul>{handoff.contractChanges.map((change) => <li key={`${change.kind}-${change.summary}`}>{change.kind}: {change.summary}</li>)}</ul></details>}
    {handoff.uncertainties.filter((uncertainty) => uncertainty !== evidenceGap).length > 0 && <details className="review-handoff-section"><summary>Uncertainties</summary><ul>{handoff.uncertainties.filter((uncertainty) => uncertainty !== evidenceGap).map((uncertainty) => <li key={uncertainty}>{uncertainty}</li>)}</ul></details>}
    {handoff.tradeoffs.length > 0 && <details className="review-handoff-section"><summary>Recorded decisions</summary><ul>{handoff.tradeoffs.map((tradeoff) => <li key={tradeoff.decision}>{tradeoff.decision}</li>)}</ul></details>}
  </section>;
});
