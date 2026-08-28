import { memo, useEffect, useRef } from 'react';
import { ExternalLink, FileDiff } from 'lucide-react';
import type { ReviewDecision, ReviewDiffHunk } from './logic.js';
import { reviewStateLabel } from './logic.js';

/** The whole diff of the selected file, with the active decision's block
 * highlighted and scrolled into view. A decision is judged in its surrounding
 * context, so the pane never shows a block in isolation. */
export const DiffReviewFileDiffPane = memo(function DiffReviewFileDiffPane({ filePath, editorUrl, hunks, decisions, activeDecisionId, onSelect }: {
  filePath: string;
  editorUrl: string | null;
  hunks: ReviewDiffHunk[];
  decisions: ReviewDecision[];
  activeDecisionId: string;
  onSelect: (decisionId: string) => void;
}) {
  const activeBlock = useRef<HTMLElement | null>(null);
  const stateByDecisionId = new Map(decisions.map((decision) => [decision.id, decision.state]));

  useEffect(() => {
    // jsdom and older browsers do not implement scrollIntoView; jumping is an
    // affordance, never a requirement for reading the diff.
    activeBlock.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [activeDecisionId, filePath]);

  return <article className="diff-review-file-diff" aria-label={`Full diff for ${filePath}`}>
    <header>
      <span><FileDiff size={13} aria-hidden="true" /><code>{filePath}</code></span>
      <small>{hunks.length} {hunks.length === 1 ? 'block' : 'blocks'} in this file</small>
      {editorUrl && <a href={editorUrl} aria-label={`Open ${filePath} in editor`} title="Open in editor"><ExternalLink size={13} aria-hidden="true" /></a>}
    </header>
    <div className="diff-review-file-diff-body">
      {hunks.map((hunk) => {
        const active = hunk.decisionId === activeDecisionId;
        const state = stateByDecisionId.get(hunk.decisionId) ?? null;
        return <section
          key={hunk.range}
          ref={active ? activeBlock : undefined}
          className={`diff-review-diff-block${active ? ' active' : ''}`}
          aria-current={active ? 'location' : undefined}
          aria-label={`${hunk.location} · ${reviewStateLabel(state)}${active ? ' · selected decision' : ''}`}
        >
          <button type="button" className="diff-review-diff-block-header" onClick={() => onSelect(hunk.decisionId)} aria-label={`Select the decision at ${hunk.location} in ${filePath}`}>
            <code>{hunk.range}</code>
            <small><b>+{hunk.additions}</b> <i>−{hunk.deletions}</i></small>
            <em className={`diff-review-decision-state state-${state ?? 'pending'}`}>{reviewStateLabel(state)}</em>
          </button>
          {hunk.lines.length === 0
            ? <p className="muted">No text patch is available for this file.</p>
            : hunk.lines.map((line) => <div key={line.key} className={`diff-line ${line.kind}`}>
              <span>{line.oldLine ?? ''}</span>
              <span>{line.newLine ?? ''}</span>
              <span className="diff-line-code">{line.text}</span>
            </div>)}
        </section>;
      })}
    </div>
  </article>;
});
