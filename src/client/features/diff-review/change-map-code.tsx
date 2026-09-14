import { memo } from 'react';
import { Code2, X } from 'lucide-react';
import type { ReviewDecision } from '../../../shared/review-decisions.js';
import { languageFromPath, SyntaxHighlight } from '../../components/markdown/syntax-highlight.js';
import { buildDiffLines } from './logic.js';

/** The code behind a disc, shown in the diagram's own frame.
 *
 * The map says how large a change is and how far it reaches, and the detail
 * card says what kind of change it is and what it risks — neither shows the
 * lines. A reviewer who clicks a node to ask "what is this?" had to leave the
 * diagram and find the change in the diff below to answer it; this column
 * answers it in place.
 *
 * It is a column inside the canvas, not a popover and not the diff pane: both
 * of those move the page out from under the diagram to answer a question
 * asked about the diagram.
 *
 * It is the patch, not the finished file: the same numbered, marked lines the
 * diff pane renders, so the two readings of one change cannot disagree. */

/** The column is a glance, not a reading surface. A refactor decision can span
 * hundreds of lines across several files, and rendering all of them turns the
 * panel into a second diff pane that is slower to open and no easier to read.
 * What is cut is said out loud rather than trimmed silently. */
const MAX_LINES = 240;

export const DiffReviewChangeMapCode = memo(function DiffReviewChangeMapCode({ decision, onClose, onOpenInDiff }: {
  decision: ReviewDecision;
  onClose?: () => void;
  /** Moves the review to this change, which scrolls the diff pane to it. It is
   * a button rather than something clicking a disc does, so reading the map
   * never moves the page. */
  onOpenInDiff?: () => void;
}) {
  let budget = MAX_LINES;
  let hidden = 0;
  const blocks = decision.hunks.map((hunk) => {
    const lines = buildDiffLines(hunk.hunkRange, hunk.lines);
    const shown = lines.slice(0, Math.max(0, budget));
    hidden += lines.length - shown.length;
    budget -= shown.length;
    return { hunk, lines: shown };
  }).filter((block) => block.lines.length > 0);

  return <section className="change-map-code" aria-label={`Code for change ${decision.ordinal}`}>
    <header>
      <Code2 size={13} aria-hidden="true" />
      <h4>Code in change {decision.ordinal}</h4>
      <small><span className="added">+{decision.additions}</span> <span className="removed">−{decision.deletions}</span></small>
      {onOpenInDiff && <button type="button" className="change-map-code-goto" onClick={onOpenInDiff}>Open in diff</button>}
      {onClose && <button type="button" className="change-map-code-close" aria-label="Close code" onClick={onClose}><X size={12} aria-hidden="true" /></button>}
    </header>
    <div className="change-map-code-body">
      {blocks.map(({ hunk, lines }) => <article key={hunk.id} className="change-map-code-hunk">
        <h5 title={hunk.filePath}>
          <span className="change-map-code-path">{hunk.filePath}</span>
          <span className="change-map-code-location">{hunk.location}</span>
        </h5>
        <div className="change-map-code-lines">
          {lines.map((line) => <div key={line.key} className={`diff-line ${line.kind}`}>
            <span>{line.oldLine ?? ''}</span>
            <span>{line.newLine ?? ''}</span>
            <span>
              <span className="diff-line-marker">{line.text.slice(0, 1) || ' '}</span>
              <SyntaxHighlight code={line.text.slice(1) || ' '} language={languageFromPath(hunk.filePath)} className="diff-line-code" />
            </span>
          </div>)}
        </div>
      </article>)}
    </div>
    {hidden > 0 && <p className="muted change-map-code-more">{hidden} more {hidden === 1 ? 'line is' : 'lines are'} not shown here; the diff below has all of them.</p>}
  </section>;
});
