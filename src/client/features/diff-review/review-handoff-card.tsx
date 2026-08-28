import { memo } from 'react';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';

export const AgentRunReviewHandoffCard = memo(function AgentRunReviewHandoffCard({ handoff }: { handoff: AgentRunReviewHandoff }) {
  const passed = handoff.verification.filter((entry) => entry.result === 'passed').length;

  return <section className="review-handoff-card" aria-label="Agent review handoff">
    <header>
      <strong>Handoff</strong>
      <span>{new Date(handoff.createdAt).toLocaleString()}</span>
    </header>
    <p className="review-handoff-summary">{handoff.summary}</p>
    {handoff.changes.length > 0 && <div className="review-handoff-section">
      <h3>Changed files</h3>
      <ul>{handoff.changes.map((change) => <li key={change.path}><code>{change.path}</code> — {change.summary}</li>)}</ul>
    </div>}
    <div className="review-handoff-section">
      <h3>Verification</h3>
      {handoff.verification.length === 0
        ? <p className="muted">No completed test, build, typecheck, or lint command was observed by the runner.</p>
        : <ul>{handoff.verification.map((entry, index) => <li key={`${entry.command}-${index}`} className={`review-handoff-verification-${entry.result}`}><code>{entry.command}</code> — {entry.result}{entry.exitCode !== null ? ` (exit ${entry.exitCode})` : ''}</li>)}</ul>}
      {handoff.verification.length > 0 && <span className="review-handoff-verification-tally">{passed}/{handoff.verification.length} passed</span>}
    </div>
    {handoff.uncertainties.length > 0 && <div className="review-handoff-section">
      <h3>Uncertainties</h3>
      <ul>{handoff.uncertainties.map((uncertainty, index) => <li key={index}>{uncertainty}</li>)}</ul>
    </div>}
  </section>;
});
