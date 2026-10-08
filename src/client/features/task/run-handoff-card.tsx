import { memo } from 'react';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';

const VISIBLE_WORDS = 60;

function clip(text: string): string {
  const words = text.split(/\s+/);
  return words.length > VISIBLE_WORDS ? `${words.slice(0, VISIBLE_WORDS).join(' ')}…` : text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Compact end-of-run handoff: the short version is visible, the rest is folded. */
export const RunHandoffCard = memo(function RunHandoffCard({ handoff }: { handoff: AgentRunReviewHandoff }) {
  const failed = handoff.verification.filter((entry) => entry.result === 'failed').length;
  const checks = handoff.verification.length === 0
    ? 'No checks observed'
    : `${handoff.verification.length - failed}/${handoff.verification.length} checks passed`;
  const facts = [`${handoff.changes.length} ${handoff.changes.length === 1 ? 'file' : 'files'} changed`, checks, plural(handoff.blockers.length, 'blocker'), plural(handoff.learnings.filter((entry) => !entry.startsWith('Capture gate:')).length, 'lesson saved')];

  return <section className="run-handoff-card" aria-label="Handoff">
    <span className="section-label">Handoff</span>
    <p className="run-handoff-summary">{clip(handoff.summary)}</p>
    <small className="run-handoff-facts">{facts.join(' · ')}</small>
    {handoff.blockers.length > 0 && <details><summary>Blockers ({handoff.blockers.length})</summary><ul>{handoff.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></details>}
    {handoff.verification.length > 0 && <details><summary>Checks that ran</summary><ul>{handoff.verification.map((entry, index) => <li key={`${entry.command}-${index}`}><code>{entry.command}</code> — {entry.result}{entry.exitCode !== null ? ` (exit ${entry.exitCode})` : ''}</li>)}</ul></details>}
    {handoff.changes.length > 0 && <details><summary>Files changed</summary><ul>{handoff.changes.map((change) => <li key={change.path}><code>{change.path}</code></li>)}</ul></details>}
    {handoff.learnings.length > 0 && <details><summary>Lessons saved</summary><ul>{handoff.learnings.map((id) => <li key={id}>{id.startsWith('Capture gate:') ? id : <code>{id}</code>}</li>)}</ul></details>}
    {handoff.priorArt.length > 0 && <details><summary>Earlier notes used</summary><ul>{handoff.priorArt.map((id) => <li key={id}><code>{id}</code></li>)}</ul></details>}
    {handoff.uncertainties.length > 0 && <details><summary>Open questions</summary><ul>{handoff.uncertainties.map((entry) => <li key={entry}>{entry}</li>)}</ul></details>}
    {handoff.tradeoffs.length > 0 && <details><summary>Choices made</summary><ul>{handoff.tradeoffs.map((entry) => <li key={entry.decision}>{entry.decision}</li>)}</ul></details>}
  </section>;
});
