import { memo, useMemo, useState } from 'react';
import {
  buildCoverageEvidence, buildReferenceEvidence, changeTypeLabel, explainChangeType, parityTableApplies,
} from './logic.js';
import type { ReviewChangeType, ReviewDecision } from './logic.js';

/**
 * The review pipeline's deterministic layer, said in plain English.
 *
 * This deliberately shows less than the classifier knows. An earlier version
 * rendered every measurement — line counts, buckets, the whole rule trace,
 * evidence hunks — and was accurate and unreadable: a reviewer scanning a
 * decision could not tell in one pass what the change was or what to distrust
 * about it. A summary nobody reads carries no information at all, so the
 * budget below is a hard cap, not a target. When there is more to say than
 * fits, the lowest-priority sentences are dropped, never the warnings.
 */
const WORD_BUDGET = 100;

/** What each verdict means to a person, in place of the label alone. */
const PLAIN: Record<ReviewChangeType, string> = {
  generated: 'Generated output, not hand-written',
  docs_comment: 'Documentation and comments only',
  config_dep: 'Configuration or dependencies',
  test_only: 'Tests only, no production code',
  move_rename: 'Moved or renamed, same content',
  deletion: 'Removes code',
  replacement: 'Swaps one implementation for another',
  refactor_pure: 'Rewrites code that should behave the same',
  new_code: 'Adds new code',
  extension: 'Adds to existing code',
  behavior_edit: 'Changes how existing code behaves',
};

type Line = { id: string; text: string; warn: boolean };

/** Two names read as a list; more than that reads as noise. */
function names(values: string[]): string {
  if (values.length <= 2) return values.join(' and ');
  return `${values.slice(0, 2).join(', ')} and ${values.length - 2} more`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export const DiffReviewHeuristicPanel = memo(function DiffReviewHeuristicPanel({ decision, decisions = [] }: {
  decision: ReviewDecision;
  /** The whole review. Evidence packs are cross-decision by nature — a new
   * function and its test always land in different files, so different
   * decisions — and read as empty without them. */
  decisions?: ReviewDecision[];
}) {
  const [open, setOpen] = useState(false);

  const { primary, lines } = useMemo(() => {
    const explanation = explainChangeType(decision.hunks.map((hunk) => ({
      filePath: hunk.filePath, fileStatus: hunk.fileStatus, lines: hunk.lines,
    })));
    const own = decision.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines }));
    const siblings = decisions
      .filter((other) => other.id !== decision.id)
      .flatMap((other) => other.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines })));
    const coverage = buildCoverageEvidence(own, siblings);
    const reference = buildReferenceEvidence(own, siblings);
    const { facts } = explanation;
    const fileCount = facts.files.length;

    // Ordered by what a reviewer loses most by not seeing. Everything after
    // the first line is droppable; the warnings sit high enough that the
    // budget can never silence one.
    const candidates: Array<Line | null> = [
      {
        id: 'verdict', warn: false,
        text: `${PLAIN[explanation.primary]} — +${facts.addedLines}/−${facts.removedLines} lines in ${fileCount} file${fileCount === 1 ? '' : 's'}.`,
      },
      // The classifier just ran on the same hunks the server did, so
      // disagreement means the stored verdict is stale.
      explanation.primary !== decision.changeType
        ? { id: 'stale', warn: true, text: `Saved as ${changeTypeLabel(decision.changeType)}, which no longer matches.` }
        : null,
      facts.droppedDeclarations.length > 0
        ? { id: 'dropped', warn: true, text: `Drops ${names(facts.droppedDeclarations)} with nothing put back.` }
        : null,
      reference.residualSymbols.length > 0
        ? { id: 'dangling', warn: true, text: `${names(reference.residualSymbols)} is still referenced elsewhere.` }
        : null,
      coverage.uncitedSymbols.length > 0
        ? { id: 'untested', warn: true, text: `No test in this review touches ${names(coverage.uncitedSymbols)}.` }
        : null,
      parityTableApplies(explanation.primary)
        ? { id: 'parity', warn: false, text: 'It claims behaviour is unchanged, so that is the thing to check.' }
        : null,
      facts.reintroducedDeclarations.length > 0 && facts.rewriteSimilarity !== null
        ? {
          id: 'rewritten', warn: false,
          text: `${names(facts.reintroducedDeclarations)} rewritten in place, ${Math.round(facts.rewriteSimilarity * 100)}% the same as before.`,
        }
        : null,
      coverage.hunks.length > 0
        ? { id: 'covered', warn: false, text: `Covered by ${names(coverage.hunks.map((entry) => entry.filePath))}.` }
        : null,
    ];

    // Hard cap. A line is taken whole or not at all, so nothing is truncated
    // mid-sentence into something that reads as a different claim.
    const kept: Line[] = [];
    let used = 0;
    for (const line of candidates) {
      if (line === null) continue;
      const cost = countWords(line.text);
      if (used + cost > WORD_BUDGET) continue;
      kept.push(line);
      used += cost;
    }
    return { primary: explanation.primary, lines: kept };
  }, [decision, decisions]);

  return (
    <section className="diff-review-heuristic">
      <button type="button" className="diff-review-heuristic-toggle" aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>
        <span>Heuristic · {changeTypeLabel(primary)}</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <ul className="diff-review-heuristic-summary">
          {lines.map((line) => (
            <li key={line.id} className={line.warn ? 'diff-review-heuristic-warn' : undefined}>{line.text}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
});
