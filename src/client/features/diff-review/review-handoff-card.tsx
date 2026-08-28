import { memo } from 'react';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';

export const AgentRunReviewHandoffCard = memo(function AgentRunReviewHandoffCard({ handoff }: { handoff: AgentRunReviewHandoff }) {
  const passed = handoff.verification.filter((entry) => entry.result === 'passed').length;
  const evidenceGap = 'No completed test, build, typecheck, or lint command was observed by the runner.';

  return <section className="review-handoff-card" aria-label="Agent review handoff">
    <header><div><strong>Agent handoff</strong><small>Captured {new Date(handoff.createdAt).toLocaleString()}</small></div><span>Run evidence</span></header>
    <div className="review-handoff-section"><h3>Completion summary</h3><p>{handoff.summary}</p><small>Agent-reported context only. It is not verification evidence.</small></div>
    {handoff.changes.length > 0 && <div className="review-handoff-section"><h3>Observed changes</h3><ul>{handoff.changes.map((change) => <li key={change.path}><code>{change.path}</code> — {change.summary}</li>)}</ul></div>}
    {handoff.acceptanceCriteria.length > 0 && <div className="review-handoff-section"><h3>Requested outcome</h3><ul>{handoff.acceptanceCriteria.map((criterion) => <li key={criterion.criterion}>{criterion.criterion}</li>)}</ul></div>}
    <div className="review-handoff-section"><h3>Verification</h3>
      {handoff.verification.length === 0
        ? <p className="muted">{evidenceGap}</p>
        : <><ul>{handoff.verification.map((entry, index) => <li key={`${entry.command}-${index}`} className={`review-handoff-verification-${entry.result}`}><code>{entry.command}</code> — {entry.result}{entry.exitCode !== null ? ` (exit ${entry.exitCode})` : ''}</li>)}</ul><small>{passed}/{handoff.verification.length} passed</small></>}
    </div>
    {handoff.contractChanges.length > 0 && <div className="review-handoff-section"><h3>Contract changes</h3><ul>{handoff.contractChanges.map((change) => <li key={`${change.kind}-${change.summary}`}>{change.kind}: {change.summary}</li>)}</ul></div>}
    {handoff.uncertainties.filter((uncertainty) => uncertainty !== evidenceGap).length > 0 && <div className="review-handoff-section"><h3>Uncertainties</h3><ul>{handoff.uncertainties.filter((uncertainty) => uncertainty !== evidenceGap).map((uncertainty) => <li key={uncertainty}>{uncertainty}</li>)}</ul></div>}
    {handoff.tradeoffs.length > 0 && <div className="review-handoff-section"><h3>Recorded decisions</h3><ul>{handoff.tradeoffs.map((tradeoff) => <li key={tradeoff.decision}>{tradeoff.decision}</li>)}</ul></div>}
  </section>;
});
