import { memo, useMemo, useState } from 'react';
import {
  buildCoverageEvidence, buildReferenceEvidence, changeTypeLabel, explainChangeType, parityTableApplies, riskSignalLabel,
} from './logic.js';
import type { ChangeTypeFacts, ChangeTypeRule, ReviewChangeType, ReviewDecision } from './logic.js';

/**
 * The deterministic layer, answering the only question the panel is opened for:
 * how much time is this block worth?
 *
 * That question is the filter. A measurement belongs here only if knowing it
 * would change the answer, so size is stated once — in the headline — and never
 * restated as a file list, a bucket mix, a production/non-production split and a
 * hunk ratio. Those are one fact said four times, and not one of the four moves
 * the estimate. What survives is the attention call, the reason the classifier
 * reached it, and the findings that raise the cost of reading, each given the
 * words to be acted on instead of a clause apiece.
 */
const WORD_BUDGET = 130;

/** Three at most. A fourth concern does not change the verdict — every level is
 * already reached by one — and reading four is how a summary becomes a diff. */
const MAX_CONCERNS = 3;

type Attention = 'close' | 'read' | 'skim';

/** The answer, in the words a reviewer would use to give it to themselves. */
const ATTENTION: Record<Attention, string> = {
  close: 'Read closely',
  read: 'Read it',
  skim: 'Skim',
};

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

/** The rule that decided the verdict, said as what it implies for reading. The
 * trace stores its own `observed` string, but those are measurements — "2 of 3
 * hunks", "Sørensen–Dice 74%" — so the reason is restated here from the same
 * facts rather than pasted from the trace. */
function whyItFired(rule: ChangeTypeRule, facts: ChangeTypeFacts): string | null {
  const similarity = facts.rewriteSimilarity === null ? null : `${Math.round(facts.rewriteSimilarity * 100)}%`;
  switch (rule.id) {
    case 'all_generated': return 'Every file is generated or vendored, so this diff is an artefact of a build rather than a decision: whatever is worth reviewing lives in the input that produced it.';
    case 'all_docs': return 'Every file is documentation, so nothing here can change behaviour and the reading is for accuracy, not correctness.';
    case 'comment_only': return 'Every changed line is a comment, so the compiled result is identical to before.';
    case 'all_config': return 'Every file is config or a dependency manifest, where the cost sits in what the new values do at deploy time rather than in the lines themselves.';
    case 'all_tests': return 'Every file is test code, so the worst case is a bad test rather than a bad release.';
    case 'no_production': return 'No production file is touched at all.';
    case 'move_rename': return 'The content arrived intact from somewhere else, so the only question worth time is whether anything changed in transit.';
    case 'deleted_files': return 'The files are deleted outright, and what a deletion breaks is never visible in the deletion itself.';
    case 'removal_only': return 'It only takes lines away and adds none, so the risk is in what still expects them.';
    case 'readded_names': return 'A declaration was removed and added back under the same name, which is a swap rather than an edit — the new body has no history in common with the old one.';
    case 'rewrite_similarity': return similarity === null ? null : `Removed and added lines share ${similarity} of their tokens, which is over the refactor threshold: the shape is preserved and any change is in the details.`;
    case 'added_files': return 'It lands in a newly added file, so nothing existing can regress from it.';
    case 'new_declarations': return 'It declares something new, removes no declaration, and adds far more than it takes away.';
    case 'mostly_additive': return 'It removes no declaration and adds far more than it takes away, so existing callers keep working by construction.';
    case 'residual': return 'No narrower rule held, which is the case that earns the most attention: it reads as an edit to behaviour that already existed and already had callers.';
    default: return null;
  }
}

/** A finding that changes how long the block takes. `weight` is that cost: 2
 * puts the block in "read closely" on its own, 1 argues for more than a skim. */
type Concern = { id: string; weight: number; warn: boolean; text: string; short: string };

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

  const { attention, headline, why, concerns, overflow, clean } = useMemo(() => {
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
    const firedWhy = fired ? whyItFired(fired, facts) : null;
    const rewritten = facts.reintroducedDeclarations.length > 0 && facts.rewriteSimilarity !== null;

    // Ordered by how much time the finding adds. Everything a reviewer can
    // already see in the diff header — which files, how they bucket, how the
    // lines split — is deliberately absent: it is true, and it does not change
    // the answer to "how long does this take".
    const candidates: Array<Concern | null> = [
      reference.residualSymbols.length > 0
        ? {
          id: 'dangling', weight: 2, warn: true, short: `${names(reference.residualSymbols)} still referenced after removal`,
          text: `${names(reference.residualSymbols)} is removed here and still referenced on a surviving line elsewhere in this review. That is a concrete break rather than a question of taste, so it is worth settling before any time goes into the rest of the block.`,
        }
        : null,
      facts.droppedDeclarations.length > 0
        ? {
          id: 'dropped', weight: 2, warn: true, short: `${names(facts.droppedDeclarations)} dropped with no replacement`,
          text: `${names(facts.droppedDeclarations)} is removed with nothing put back under the same name. A diff shows the deleted lines but never the callers that depended on them, so the time this block needs goes on finding those callers, not on reading what is on screen.`,
        }
        : null,
      decision.riskSignals.length > 0
        ? {
          id: 'risk', weight: 2, warn: true, short: `flagged for ${names(decision.riskSignals.map(riskSignalLabel))}`,
          text: `Flagged for ${names(decision.riskSignals.map(riskSignalLabel))}. A risk signal sets the floor on time regardless of size — three lines through an auth or data path earn longer than a hundred lines that touch nothing sensitive.`,
        }
        : null,
      // The classifier just ran on the same hunks the server did, so
      // disagreement means the label the queue was triaged by is stale.
      explanation.primary !== decision.changeType
        ? {
          id: 'stale', weight: 2, warn: true, short: `saved under the wrong change type`,
          text: `This is saved as ${changeTypeLabel(decision.changeType)}, but classifying these exact hunks now gives ${changeTypeLabel(explanation.primary)}. Whatever priority it was given in the queue was assigned against the wrong category, so budget it from what is written here instead.`,
        }
        : null,
      coverage.uncitedSymbols.length > 0
        ? {
          id: 'untested', weight: 1, warn: true, short: `no test names ${names(coverage.uncitedSymbols)}`,
          text: `No test in this review touches ${names(coverage.uncitedSymbols)}. The whole diff was searched for the name, so this is not missing evidence — nothing but your own reading is going to establish that the new code is right.`,
        }
        : null,
      rewritten
        ? {
          id: 'rewritten', weight: 1, warn: false, short: `${names(facts.reintroducedDeclarations)} rewritten in place`,
          text: `${names(facts.reintroducedDeclarations)} was rewritten in place and still shares ${Math.round((facts.rewriteSimilarity ?? 0) * 100)}% of its tokens with the version it replaced. Text that similar hides behaviour changes in the gaps, so read for signature, error handling, ordering and cost rather than for lines that look different.`,
        }
        : null,
      !rewritten && parityTableApplies(explanation.primary)
        ? {
          id: 'parity', weight: 1, warn: false, short: 'behaviour claimed unchanged',
          text: 'It claims behaviour is unchanged, which is the one claim a diff cannot settle by itself. The time goes into comparing signature, error handling, ordering and cost against what it replaced; if those four match, the block is finished.',
        }
        : null,
    ];

    const ordered = candidates.filter((entry): entry is Concern => entry !== null);
    const weight = ordered.reduce((total, entry) => total + entry.weight, 0);
    const level: Attention = weight >= 2 ? 'close' : weight >= 1 ? 'read' : 'skim';
    const text = `${ATTENTION[level]}. ${PLAIN[explanation.primary]} — +${facts.addedLines}/−${facts.removedLines} lines in ${fileCount} file${fileCount === 1 ? '' : 's'}.`;

    // Cap on the whole summary, not on each part. A concern is taken whole or
    // not at all, so nothing is truncated mid-sentence into a different claim,
    // and the list is already in cost order — what falls off the end is what
    // was least likely to change the answer.
    const kept: Concern[] = [];
    let used = countWords(text) + (firedWhy ? countWords(firedWhy) : 0);
    for (const entry of ordered) {
      if (kept.length >= MAX_CONCERNS) break;
      const cost = countWords(entry.text);
      if (used + cost > WORD_BUDGET) continue;
      kept.push(entry);
      used += cost;
    }
    // A warning that does not fit is still the reason to read the block, so it
    // keeps its name even when it loses its explanation. Silence here would be
    // the one failure mode this panel cannot have.
    const overflow = ordered.filter((entry) => entry.warn && !kept.includes(entry));

    return {
      attention: level,
      headline: text,
      why: firedWhy,
      concerns: kept,
      overflow: overflow.length > 0 ? `Also outstanding, with no room to explain here: ${overflow.map((entry) => entry.short).join('; ')}.` : null,
      // "Cheap to review" is itself a critical answer, and it is only worth
      // trusting if it names what was checked to reach it.
      clean: kept.length === 0
        ? 'Everything that would argue for more time came back clean: no declaration is dropped without a replacement, no removed name is still referenced in this review, every new declaration is named by a test, and no risk signal is set.'
        : null,
    };
  }, [decision, decisions]);

  return (
    <section className="diff-review-heuristic">
      <button type="button" className="diff-review-heuristic-toggle" aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>
        <span>Heuristic · {ATTENTION[attention]}</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div className="diff-review-heuristic-summary">
          <p>{headline}{why ? ` ${why}` : ''}</p>
          {concerns.map((entry) => (
            <p key={entry.id}>
              <span className={entry.warn ? 'diff-review-heuristic-warn' : undefined}>{entry.text}</span>
            </p>
          ))}
          {overflow ? <p><span className="diff-review-heuristic-warn">{overflow}</span></p> : null}
          {clean ? <p>{clean}</p> : null}
        </div>
      ) : null}
    </section>
  );
});
