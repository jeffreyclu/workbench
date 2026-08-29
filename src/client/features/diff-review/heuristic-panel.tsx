import { memo, useMemo, useState } from 'react';
import {
  buildCoverageEvidence, buildReferenceEvidence, changeTypeLabel, explainChangeType, parityTableApplies, riskSignalLabel,
} from './logic.js';
import type { ChangeTypeFacts, ChangeTypeRule, ReviewChangeType, ReviewDecision } from './logic.js';

/**
 * The review pipeline's deterministic layer, said in plain English.
 *
 * Two failures bound this. Rendering every measurement — line counts, buckets,
 * the whole rule trace, evidence hunks — is accurate and unreadable. Rendering
 * only the verdict is readable and says nothing: a one-line "Refactor, +14/−6"
 * is the label the reviewer already had. So the budget below is a target as
 * well as a cap: the summary keeps adding the next most useful sentence until
 * it is nearly full, and drops the lowest-priority sentences, never a warning.
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

/** The rule that actually decided the verdict, in the reviewer's language. The
 * trace stores its own `observed` string, but those are measurements —
 * "2 of 3 hunks", "Sørensen–Dice 74%" — so the reason is restated here from
 * the same facts rather than pasted from the trace. */
function whyItFired(rule: ChangeTypeRule, facts: ChangeTypeFacts): string | null {
  const similarity = facts.rewriteSimilarity === null ? null : `${Math.round(facts.rewriteSimilarity * 100)}%`;
  switch (rule.id) {
    case 'all_generated': return 'Every file here is generated or vendored, so the diff is an artefact of a build, not a decision.';
    case 'all_docs': return 'Every file here is documentation.';
    case 'comment_only': return 'Every changed line is a comment.';
    case 'all_config': return 'Every file here is config or a dependency manifest.';
    case 'all_tests': return 'Every file here is test code.';
    case 'no_production': return 'No production file is touched at all.';
    case 'move_rename': return 'The content arrived intact from somewhere else, so the question is whether anything changed in transit.';
    case 'deleted_files': return 'The files are deleted outright.';
    case 'removal_only': return 'It only takes lines away, adding none.';
    case 'readded_names': return 'A declaration was removed and added back under the same name, which is a swap rather than an edit.';
    case 'rewrite_similarity': return similarity === null ? null : `Removed and added lines share ${similarity} of their tokens, over the refactor threshold.`;
    case 'added_files': return 'It lands in a newly added file.';
    case 'new_declarations': return 'It declares something new, removes no declaration, and adds far more than it takes away.';
    case 'mostly_additive': return 'It removes no declaration and adds far more than it takes away.';
    case 'residual': return 'No narrower rule held, so it reads as an edit to behaviour that already existed.';
    default: return null;
  }
}

type Group = 'what' | 'changed' | 'check';
type Line = { id: string; group: Group; text: string; warn: boolean };

/** Two names read as a list; more than that reads as noise. */
function names(values: string[]): string {
  if (values.length <= 2) return values.join(' and ');
  return `${values.slice(0, 2).join(', ')} and ${values.length - 2} more`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** "all production code", or the mix when it is not. */
function bucketPhrase(files: ChangeTypeFacts['files']): string {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.bucket, (counts.get(file.bucket) ?? 0) + 1);
  if (counts.size === 1) return `all ${[...counts.keys()][0]} code`;
  return [...counts.entries()].map(([bucket, count]) => `${count} ${bucket}`).join(', ');
}

export const DiffReviewHeuristicPanel = memo(function DiffReviewHeuristicPanel({ decision, decisions = [] }: {
  decision: ReviewDecision;
  /** The whole review. Evidence packs are cross-decision by nature — a new
   * function and its test always land in different files, so different
   * decisions — and read as empty without them. */
  decisions?: ReviewDecision[];
}) {
  const [open, setOpen] = useState(false);

  const { primary, groups } = useMemo(() => {
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
    const fired = [...explanation.fileRules, ...explanation.productionRules].find((rule) => rule.outcome === 'fired');
    const why = fired ? whyItFired(fired, facts) : null;
    const nonProduction = facts.addedLines - facts.productionAddedLines + (facts.removedLines - facts.productionRemovedLines) > 0;
    const secondary = explanation.secondaryReasons[0] ?? null;

    // Ordered by what a reviewer loses most by not seeing, which is not the
    // order they are read in: the budget spends itself down this list, and the
    // groups below put what survives back into reading order.
    const candidates: Array<Line | null> = [
      {
        id: 'verdict', group: 'what', warn: false,
        text: `${PLAIN[explanation.primary]} — +${facts.addedLines}/−${facts.removedLines} lines in ${fileCount} file${fileCount === 1 ? '' : 's'}.`,
      },
      // The classifier just ran on the same hunks the server did, so
      // disagreement means the stored verdict is stale.
      explanation.primary !== decision.changeType
        ? { id: 'stale', group: 'check', warn: true, text: `Saved as ${changeTypeLabel(decision.changeType)}, which no longer matches.` }
        : null,
      facts.droppedDeclarations.length > 0
        ? { id: 'dropped', group: 'changed', warn: true, text: `Drops ${names(facts.droppedDeclarations)} with nothing put back.` }
        : null,
      reference.residualSymbols.length > 0
        ? { id: 'dangling', group: 'check', warn: true, text: `${names(reference.residualSymbols)} is still referenced elsewhere.` }
        : null,
      coverage.uncitedSymbols.length > 0
        ? { id: 'untested', group: 'check', warn: true, text: `No test in this review touches ${names(coverage.uncitedSymbols)}.` }
        : null,
      decision.riskSignals.length > 0
        ? { id: 'risk', group: 'check', warn: true, text: `Flagged for ${names(decision.riskSignals.map(riskSignalLabel))}.` }
        : null,
      why ? { id: 'why', group: 'what', warn: false, text: why } : null,
      facts.reintroducedDeclarations.length > 0 && facts.rewriteSimilarity !== null
        ? {
          id: 'rewritten', group: 'changed', warn: false,
          text: `${names(facts.reintroducedDeclarations)} rewritten in place, ${Math.round(facts.rewriteSimilarity * 100)}% the same as before.`,
        }
        : null,
      facts.introducedDeclarations.length > 0
        ? { id: 'introduced', group: 'changed', warn: false, text: `New here: ${names(facts.introducedDeclarations)}.` }
        : null,
      parityTableApplies(explanation.primary)
        ? {
          id: 'parity', group: 'check', warn: false,
          text: 'It claims behaviour is unchanged, so check the signature, error handling, ordering and cost against what it replaced.',
        }
        : null,
      fileCount > 0
        ? { id: 'where', group: 'what', warn: false, text: `It sits in ${names(facts.files.map((file) => file.path))}, ${bucketPhrase(facts.files)}.` }
        : null,
      nonProduction
        ? {
          id: 'split', group: 'what', warn: false,
          text: `Only +${facts.productionAddedLines}/−${facts.productionRemovedLines} of that is production code.`,
        }
        : null,
      secondary ? { id: 'secondary', group: 'what', warn: false, text: secondary.reason } : null,
      coverage.hunks.length > 0
        ? { id: 'covered', group: 'check', warn: false, text: `Covered by ${names(coverage.hunks.map((entry) => entry.filePath))}.` }
        : null,
      reference.clearedSymbols.length > 0
        ? {
          id: 'cleared', group: 'changed', warn: false,
          text: `Nothing else in this review still calls ${names(reference.clearedSymbols)}, though the review is not the whole repo.`,
        }
        : null,
      facts.commentOnly ? { id: 'comment', group: 'changed', warn: false, text: 'Nothing outside the comments moved.' } : null,
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
    const order: Group[] = ['what', 'changed', 'check'];
    return {
      primary: explanation.primary,
      groups: order
        .map((group) => ({ group, lines: kept.filter((line) => line.group === group) }))
        .filter((entry) => entry.lines.length > 0),
    };
  }, [decision, decisions]);

  return (
    <section className="diff-review-heuristic">
      <button type="button" className="diff-review-heuristic-toggle" aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>
        <span>Heuristic · {changeTypeLabel(primary)}</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div className="diff-review-heuristic-summary">
          {groups.map((entry) => (
            <p key={entry.group}>
              {entry.lines.map((line, index) => (
                <span key={line.id} className={line.warn ? 'diff-review-heuristic-warn' : undefined}>
                  {index > 0 ? ' ' : ''}{line.text}
                </span>
              ))}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
});
