import { memo, useMemo, useState } from 'react';
import {
  PARITY_AXES, buildCoverageEvidence, buildReferenceEvidence, changeTypeLabel, explainChangeType, parityTableApplies,
} from './logic.js';
import type { ChangeTypeRule, ReviewDecision } from './logic.js';

/**
 * The review pipeline's deterministic layer, shown rather than described.
 *
 * Everything here is recomputed in the browser from the decision's own hunks
 * using the same shared modules the server runs, so what a reviewer reads is
 * the actual verdict and the actual rule that produced it — not a summary of
 * the code written alongside it, which is free to drift.
 *
 * This exists because a heuristic that only ever reaches a reviewer as better
 * prompt text is unauditable: when the classifier is wrong, nothing on screen
 * says so, and the wrongness arrives as a confidently phrased review comment.
 */
export const DiffReviewHeuristicPanel = memo(function DiffReviewHeuristicPanel({ decision, decisions = [] }: {
  decision: ReviewDecision;
  /** The whole review. Evidence packs are cross-decision by nature — a new
   * function and its test always land in different files, so different
   * decisions — and read as empty without them. */
  decisions?: ReviewDecision[];
}) {
  const [open, setOpen] = useState(false);

  const heuristic = useMemo(() => {
    const explanation = explainChangeType(decision.hunks.map((hunk) => ({
      filePath: hunk.filePath, fileStatus: hunk.fileStatus, lines: hunk.lines,
    })));
    const own = decision.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines }));
    const siblings = decisions
      .filter((other) => other.id !== decision.id)
      .flatMap((other) => other.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines })));
    return { explanation, coverage: buildCoverageEvidence(own, siblings), reference: buildReferenceEvidence(own, siblings) };
  }, [decision, decisions]);

  const { explanation, coverage, reference } = heuristic;
  const { facts } = explanation;
  // The classifier ran on the same hunks the server did, so disagreement means
  // the stored verdict is stale. Saying so is more useful than silently
  // preferring one of the two.
  const stale = explanation.primary !== decision.changeType;

  return (
    <section className="diff-review-heuristic">
      <button type="button" className="diff-review-heuristic-toggle" aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>
        <span>Heuristic · {changeTypeLabel(explanation.primary)}</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div className="diff-review-heuristic-body">
          {stale ? <p className="diff-review-heuristic-warn">Stored verdict is {changeTypeLabel(decision.changeType)}; recomputing here gives {changeTypeLabel(explanation.primary)}.</p> : null}

          <h5>What the diff measured</h5>
          <dl className="diff-review-heuristic-facts">
            <div><dt>Lines</dt><dd>+{facts.addedLines} / −{facts.removedLines} ({facts.productionAddedLines}/{facts.productionRemovedLines} in production code)</dd></div>
            <div><dt>Declares</dt><dd>{facts.declarationsAdded.length > 0 ? facts.declarationsAdded.join(', ') : 'nothing'}</dd></div>
            <div><dt>Removes</dt><dd>{facts.declarationsRemoved.length > 0 ? facts.declarationsRemoved.join(', ') : 'nothing'}</dd></div>
            {facts.droppedDeclarations.length > 0 ? <div><dt>Dropped</dt><dd className="diff-review-heuristic-flag">{facts.droppedDeclarations.join(', ')}</dd></div> : null}
            {facts.reintroducedDeclarations.length > 0 ? <div><dt>Rewritten</dt><dd>{facts.reintroducedDeclarations.join(', ')}</dd></div> : null}
            <div><dt>Rewrite similarity</dt><dd>{facts.rewriteSimilarity === null ? 'n/a — nothing removed' : `${Math.round(facts.rewriteSimilarity * 100)}%`}</dd></div>
          </dl>
          <ul className="diff-review-heuristic-files">
            {facts.files.map((file) => (
              <li key={file.path}><span className={`diff-review-heuristic-bucket bucket-${file.bucket}`}>{file.bucket}</span><code>{file.path}</code><span className="diff-review-heuristic-status">{file.status}</span></li>
            ))}
          </ul>

          <h5>Rules, in the order they ran</h5>
          <RuleList rules={explanation.fileRules} />
          {explanation.productionRules.length > 0 ? (
            <>
              <p className="diff-review-heuristic-note">No path bucket claimed the whole change, so the production hunks were classified on their own:</p>
              <RuleList rules={explanation.productionRules} />
            </>
          ) : null}

          <h5>Also applies</h5>
          {explanation.secondaryReasons.length > 0 ? (
            <ul className="diff-review-heuristic-reasons">
              {explanation.secondaryReasons.map((entry) => (
                <li key={entry.type}><strong>{changeTypeLabel(entry.type)}</strong> — {entry.reason}</li>
              ))}
            </ul>
          ) : <p className="diff-review-heuristic-note">Nothing secondary — this is only a {changeTypeLabel(explanation.primary).toLowerCase()}.</p>}

          <h5>Parity table</h5>
          {parityTableApplies(explanation.primary) ? (
            <>
              <p className="diff-review-heuristic-note">This is a {changeTypeLabel(explanation.primary).toLowerCase()}, so it asserts equivalence. The review answer is required to open with one line per axis, verdict SAME / CHANGED / UNCLEAR, and a <code>[path:line]</code> citation on every CHANGED. An answer that skips an axis, or claims CHANGED with no citation, is rejected before you see it.</p>
              <ul className="diff-review-heuristic-axes">{PARITY_AXES.map((axis) => <li key={axis}>{axis}</li>)}</ul>
            </>
          ) : <p className="diff-review-heuristic-note">Not required. Only refactors and replacements claim the behaviour is unchanged; demanding a parity verdict on a {changeTypeLabel(explanation.primary).toLowerCase()} would report every intended change as a difference.</p>}

          <h5>Coverage evidence</h5>
          {coverage.symbols.length === 0 ? (
            <p className="diff-review-heuristic-note">Declares nothing new, so there is no coverage claim to make.</p>
          ) : (
            <>
              <p className="diff-review-heuristic-note">Searched every other decision in this review for test hunks naming {coverage.symbols.join(', ')}.</p>
              {coverage.uncitedSymbols.length > 0 ? <p className="diff-review-heuristic-warn">No test hunk anywhere in this diff mentions {coverage.uncitedSymbols.join(', ')}.</p> : null}
              <EvidenceHunks hunks={coverage.hunks} empty="No test hunk in this review names any of them." />
            </>
          )}

          <h5>Reference evidence</h5>
          {reference.symbols.length === 0 ? (
            <p className="diff-review-heuristic-note">Removes no declaration, so nothing can be left dangling.</p>
          ) : (
            <>
              {reference.residualSymbols.length > 0 ? <p className="diff-review-heuristic-warn">Still referenced on a surviving line: {reference.residualSymbols.join(', ')}.</p> : null}
              {reference.clearedSymbols.length > 0 ? <p className="diff-review-heuristic-note">Nothing else <em>in this review</em> references {reference.clearedSymbols.join(', ')} — which is not the same as safe to delete, since the review is not the repo.</p> : null}
              <EvidenceHunks hunks={reference.hunks} empty="No surviving line in this review mentions them." />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
});

function RuleList({ rules }: { rules: ChangeTypeRule[] }) {
  return (
    <ol className="diff-review-heuristic-rules">
      {rules.map((rule) => (
        <li key={rule.id} className={`outcome-${rule.outcome}`}>
          <span className="diff-review-heuristic-outcome">{rule.outcome === 'fired' ? '→' : rule.outcome === 'passed' ? 'no' : '·'}</span>
          <span>
            <span className="diff-review-heuristic-question">{rule.question}</span>
            <span className="diff-review-heuristic-observed">
              {rule.outcome === 'not_reached' ? 'Not reached — an earlier rule already decided.' : rule.observed}
            </span>
            {rule.outcome === 'fired' ? <span className="diff-review-heuristic-verdict">⇒ {changeTypeLabel(rule.verdict)}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function EvidenceHunks({ hunks, empty }: { hunks: Array<{ filePath: string; location: string; symbols: string[] }>; empty: string }) {
  if (hunks.length === 0) return <p className="diff-review-heuristic-note">{empty}</p>;
  return (
    <ul className="diff-review-heuristic-evidence">
      {hunks.map((hunk) => (
        <li key={`${hunk.filePath}:${hunk.location}`}><code>{hunk.filePath}:{hunk.location}</code> — names {hunk.symbols.join(', ')}</li>
      ))}
    </ul>
  );
}
