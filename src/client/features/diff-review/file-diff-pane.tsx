import { memo, useEffect, useRef } from 'react';
import { ExternalLink, FileDiff } from 'lucide-react';
import { languageFromPath, SyntaxHighlight } from '../../components/markdown/syntax-highlight.js';
import type { ReviewDecision, ReviewDiffHunk } from './logic.js';
import { reviewStateLabel } from './logic.js';

/**
 * IDE LEGACY-AFFECTING: Task detail mounts this existing review pane whenever
 * a task opens. Keeping its focus movement inside the diff scroller prevents
 * task selection from scrolling the page down to a review block.
 *
 * The whole diff of the selected file, with the active decision's block
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
  const diffBody = useRef<HTMLDivElement | null>(null);
  const language = languageFromPath(filePath);
  const decisionByHunkId = new Map(decisions.flatMap((decision) => decision.hunks.map((hunk) => [hunk.id, decision] as const)));

  useEffect(() => {
    // IDE LEGACY-AFFECTING: `scrollIntoView` scrolls every ancestor, including
    // the task detail. Scroll only this pane so opening a task stays at its top.
    const body = diffBody.current;
    const block = activeBlock.current;
    if (!body || !block) return;
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    body.scrollTo?.({ top: Math.max(0, block.offsetTop - body.clientHeight / 2), behavior });
  }, [activeDecisionId, filePath]);

  return <article className="diff-review-file-diff" aria-label={`Full diff for ${filePath}`}>
    <header>
      <span><FileDiff size={13} aria-hidden="true" /><code>{filePath}</code></span>
      <small>{hunks.length} {hunks.length === 1 ? 'block' : 'blocks'} in this file</small>
      {editorUrl && <a href={editorUrl} aria-label={`Open ${filePath} in editor`} title="Open in editor"><ExternalLink size={13} aria-hidden="true" /></a>}
    </header>
    <div className="diff-review-file-diff-body" ref={diffBody}>
      {hunks.map((hunk) => {
        const decision = decisionByHunkId.get(hunk.decisionId);
        const active = decision?.id === activeDecisionId;
        const state = decision?.state ?? null;
        return <section
          key={hunk.range}
          ref={active ? activeBlock : undefined}
          className={`diff-review-diff-block state-${state ?? 'pending'}${state === null ? '' : ' settled'}${active ? ' active' : ''}`}
          aria-current={active ? 'location' : undefined}
          aria-label={`${hunk.location} · ${reviewStateLabel(state)}${active ? ' · selected decision' : ''}`}
        >
          <button type="button" className="diff-review-diff-block-header" onClick={() => onSelect(decision?.id ?? hunk.decisionId)} aria-label={`Select the decision at ${hunk.location} in ${filePath}`}>
            <code>{hunk.range}</code>
            <small><b>+{hunk.additions}</b> <i>−{hunk.deletions}</i></small>
            <em className={`diff-review-decision-state state-${state ?? 'pending'}`}>{reviewStateLabel(state)}</em>
          </button>
          {hunk.lines.length === 0
            ? <p className="muted">No text patch is available for this file.</p>
            : hunk.lines.map((line) => <div key={line.key} className={`diff-line ${line.kind}`}>
              <span>{line.oldLine ?? ''}</span>
              <span>{line.newLine ?? ''}</span>
              <span><span className="diff-line-marker">{line.text.slice(0, 1) || ' '}</span><SyntaxHighlight code={line.text.slice(1) || ' '} language={language} className="diff-line-code" /></span>
            </div>)}
        </section>;
      })}
    </div>
  </article>;
});
