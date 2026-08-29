import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, ExternalLink, FileDiff, MessageSquare, TriangleAlert } from 'lucide-react';
import { languageFromPath, SyntaxHighlight } from '../../components/markdown/syntax-highlight.js';
import { CHANGE_RELATION_LABELS, type ChangeMap } from '../../../shared/change-map.js';
import { buildChangeLinkIndex, plainRelationText, type ChangeLink, type ChangeLinkSummary } from './change-map-logic.js';
import type { ReviewDecision, ReviewDiffHunk } from './logic.js';
import { reviewStateLabel } from './logic.js';

/** Breathing room left above a scrolled-to block, so the reader sees that the
 * change has a context above it rather than reading from the pane's edge. */
const SCROLL_LEAD = 28;

/** How many frames a selection keeps re-measuring its landing. Roughly a third
 * of a second at 60fps — long enough for a block that mounts on a later commit
 * and for the layout above it to settle, short enough that it can never argue
 * with a reviewer who scrolls away straight after clicking. */
const SCROLL_SETTLE_FRAMES = 20;

/** Consecutive frames with an unmoved landing that end the loop early, so the
 * ordinary selection stops looking after a few frames instead of all twenty. */
const SCROLL_SETTLED_FRAMES = 3;

/** The pane is not the page: the shell keeps `body` unscrollable and scrolls an
 * inner container, so on a stacked layout the diff can sit entirely below the
 * fold. Finding that container lets a selection reveal the pane without
 * `scrollIntoView` walking — and disturbing — every ancestor. */
function nearestScroller(from: HTMLElement): HTMLElement | null {
  for (let node = from.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflow = window.getComputedStyle?.(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

/** Mirrors the queue's chips so the same decision reads the same way in both
 * places — the reviewer should recognise "already handled" from the gutter
 * without re-reading a word. */
function StateGlyph({ state }: { state: ReviewDecision['state'] }) {
  if (state === 'reviewed') return <Check size={11} aria-hidden="true" />;
  if (state === 'needs_changes') return <TriangleAlert size={10} aria-hidden="true" />;
  if (state === 'commented') return <MessageSquare size={10} aria-hidden="true" />;
  return null;
}

function fileTail(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length <= 2 ? filePath : `…/${parts.slice(-2).join('/')}`;
}

/** One relationship as a jump target. Reading a hunk, the useful question is
 * "what else moved for this?", so the row leads with the relationship and the
 * change number the reviewer can select next. */
function ChangeLinkItem({ link, onSelect }: { link: ChangeLink; onSelect: (decisionId: string) => void }) {
  return <li className={`relation-${link.relation}`}>
    <button type="button" onClick={() => onSelect(link.decisionId)} aria-label={`Go to change ${link.ordinal}: ${CHANGE_RELATION_LABELS[link.relation]} — ${plainRelationText(link.explanation)}`}>
      <span className="diff-review-change-link-relation">{CHANGE_RELATION_LABELS[link.relation]}</span>
      <span className="diff-review-change-link-target">{link.ordinal}. {link.label}</span>
      <small>{fileTail(link.filePath)}</small>
      <em>{plainRelationText(link.explanation)}</em>
    </button>
  </li>;
}

/**
 * IDE LEGACY-AFFECTING: Task detail mounts this existing review pane whenever
 * a task opens. Keeping its focus movement inside the diff scroller prevents
 * task selection from scrolling the page down to a review block.
 *
 * The whole diff of the selected file, with the active decision's block
 * highlighted and scrolled into view. A decision is judged in its surrounding
 * context, so the pane never shows a block in isolation.
 *
 * Relationships live here rather than in a side panel: they are a property of
 * the code being read, so each linked block carries its own one-line lens and
 * opens its related changes in place. The peek panel expands in flow rather
 * than floating, because this body is a scroll container and anything drawn
 * inside it would be clipped at the pane edge. The decision popover the gutter
 * marker opens escapes that by portalling out of this subtree entirely. */
export const DiffReviewFileDiffPane = memo(function DiffReviewFileDiffPane({ filePath, editorUrl, hunks, decisions, activeDecisionId, selectionTick, changeMap, riskBands, openDetailFor, onSelect, onOpenDetail }: {
  filePath: string;
  editorUrl: string | null;
  hunks: ReviewDiffHunk[];
  decisions: ReviewDecision[];
  activeDecisionId: string;
  /** Bumped by every selection, including re-selecting the decision already
   * shown. React bails out of an identical state update, so without this the
   * pane would never scroll back to a block the reviewer had scrolled away
   * from. */
  selectionTick?: number;
  changeMap?: ChangeMap;
  /** Scored risk band per decision, so the gutter dot carries the same
   * severity the detail panel shows without opening it. */
  riskBands?: Map<string, string>;
  openDetailFor?: string | null;
  onSelect: (decisionId: string) => void;
  onOpenDetail?: (decisionId: string, anchor: HTMLElement) => void;
}) {
  const activeBlock = useRef<HTMLElement | null>(null);
  const lastSelection = useRef<string | null>(null);
  const diffBody = useRef<HTMLDivElement | null>(null);
  const [peekDecisionId, setPeekDecisionId] = useState<string | null>(null);
  const language = languageFromPath(filePath);
  const decisionByHunkId = new Map(decisions.flatMap((decision) => decision.hunks.map((hunk) => [hunk.id, decision] as const)));
  // Only spotlight when the selected decision actually lives in this file:
  // dimming a file that has nothing selected would just make it unreadable.
  const spotlight = hunks.some((hunk) => (decisionByHunkId.get(hunk.decisionId)?.id ?? null) === activeDecisionId);

  const linkIndex = useMemo<Map<string, ChangeLinkSummary>>(() => changeMap ? buildChangeLinkIndex(changeMap) : new Map(), [changeMap]);
  const activeSummary = linkIndex.get(activeDecisionId) ?? null;
  const activeOrdinal = changeMap?.nodes.find((node) => node.id === activeDecisionId)?.ordinal ?? null;
  // Markers keep the selected change's relationships visible while scrolling,
  // so a linked block is recognisable without opening anything.
  const markers = useMemo(() => new Map((activeSummary
    ? [...activeSummary.upstream.map((link) => [link, 'upstream'] as const), ...activeSummary.downstream.map((link) => [link, 'downstream'] as const)]
    : []).map(([link, direction]) => [link.decisionId, { relation: link.relation, direction }])), [activeSummary]);

  useEffect(() => {
    // IDE LEGACY-AFFECTING: `scrollIntoView` scrolls every ancestor, including
    // the task detail. Scroll only this pane so opening a task stays at its top.
    const body = diffBody.current;
    if (!body) return;
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    // Measure the block against the pane itself rather than through
    // `offsetTop`: offsetTop is relative to whichever ancestor happens to be
    // positioned, which is not this pane, so it lands at an arbitrary place in
    // a long file. Rect deltas are correct whatever the layout does, and stay
    // correct when re-measured mid-scroll: the rect moves with `scrollTop`.
    const landing = (block: HTMLElement) => {
      const blockBox = block.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      const blockTop = blockBox.top - bodyBox.top + body.scrollTop;
      // A block that fits reads best centred; one taller than the pane reads
      // from its first line, so the change itself is what comes into view.
      const lead = blockBox.height + SCROLL_LEAD * 2 <= body.clientHeight
        ? (body.clientHeight - blockBox.height) / 2
        : SCROLL_LEAD;
      const furthest = Math.max(0, body.scrollHeight - body.clientHeight);
      return Math.min(furthest, Math.max(0, blockTop - lead));
    };

    // Only a deliberate selection may move the surrounding page. On the first
    // render the reviewer has just opened the task and belongs at its top —
    // that is the legacy behaviour the comment above protects. Every later run
    // is a click, including re-picking the decision already shown, so the pane
    // must be revealed then too. Read before the frame loop starts, so a late
    // block does not turn a click into a first render.
    const reselected = lastSelection.current !== null;
    lastSelection.current = activeDecisionId;

    const reveal = () => {
      const scroller = nearestScroller(body);
      if (!scroller) return;
      const paneBox = body.getBoundingClientRect();
      const viewBox = scroller.getBoundingClientRect();
      // Reveal the pane only when it genuinely is not readable: a pane already
      // in view must not jump because the reviewer picked the next decision.
      const above = viewBox.top + SCROLL_LEAD - paneBox.top;
      const below = paneBox.top + Math.min(paneBox.height, viewBox.height) - viewBox.bottom;
      const delta = above > 0 ? -above : below > 0 ? below : 0;
      if (delta !== 0) scroller.scrollTo?.({ top: Math.max(0, scroller.scrollTop + delta), behavior });
    };

    // The landing is not final at the commit that triggered this effect. The
    // block can attach a commit later (switching files renders new hunks), and
    // once attached it can still move: a peek panel collapsing above it, the
    // pane being revealed in the outer scroller, a late monospace font. So keep
    // re-measuring for a few frames and re-issue only when the landing actually
    // moved — re-issuing an unchanged target would restart the smooth animation
    // every frame and never arrive. Giving up after one look is what left the
    // reader parked next to the wrong change.
    let frame: number | undefined;
    let issued: number | null = null;
    let settledFor = 0;
    let framesLeft = SCROLL_SETTLE_FRAMES;
    const step = () => {
      frame = undefined;
      const block = activeBlock.current;
      if (block) {
        const target = landing(block);
        if (issued === null || Math.abs(target - issued) > 1) {
          // A correction mid-flight snaps rather than animating again: it is a
          // small distance, and a second animation would fight the first.
          body.scrollTo?.({ top: target, behavior: issued === null ? behavior : 'auto' });
          settledFor = 0;
          if (issued === null) {
            // Moves keyboard/screen-reader focus onto the selected block, not
            // just the visual scroll — selecting from the queue should land here.
            block.focus?.({ preventScroll: true });
            if (reselected) reveal();
          }
          issued = target;
        } else settledFor += 1;
      }
      framesLeft -= 1;
      if (framesLeft > 0 && settledFor < SCROLL_SETTLED_FRAMES) frame = window.requestAnimationFrame?.(step);
    };
    // The first pass runs now, so the common case scrolls in this commit rather
    // than waiting a frame; the loop only covers what moves afterwards.
    step();
    return () => { if (frame !== undefined) window.cancelAnimationFrame?.(frame); };
  }, [activeDecisionId, filePath, selectionTick]);

  useEffect(() => setPeekDecisionId(null), [filePath]);

  const selectRelated = (decisionId: string) => {
    setPeekDecisionId(null);
    onSelect(decisionId);
  };

  // A decision can own several blocks in one file; its lens belongs on the
  // first of them rather than repeated down the file. The scroll target is the
  // first block too — every active block sharing one ref would leave it on the
  // last one, scrolling past the start of the change.
  const lensShown = new Set<string>();
  let scrollTargetTaken = false;

  return <article className="diff-review-file-diff" aria-label={`Full diff for ${filePath}`}>
    <header>
      <span><FileDiff size={13} aria-hidden="true" /><code>{filePath}</code></span>
      <small>{hunks.length} {hunks.length === 1 ? 'block' : 'blocks'} in this file</small>
      {editorUrl && <a href={editorUrl} aria-label={`Open ${filePath} in editor`} title="Open in editor"><ExternalLink size={13} aria-hidden="true" /></a>}
    </header>
    <div className={`diff-review-file-diff-body${spotlight ? ' spotlight' : ''}`} ref={diffBody}>
      {hunks.map((hunk) => {
        const decision = decisionByHunkId.get(hunk.decisionId);
        const decisionId = decision?.id ?? hunk.decisionId;
        const active = decisionId === activeDecisionId;
        const state = decision?.state ?? null;
        const summary = linkIndex.get(decisionId) ?? null;
        const showLens = Boolean(summary) && !lensShown.has(decisionId);
        if (showLens) lensShown.add(decisionId);
        const peeking = peekDecisionId === decisionId;
        const marker = active ? null : markers.get(decisionId) ?? null;
        const ordinal = decision?.ordinal ?? null;
        const scrollTarget = active && !scrollTargetTaken;
        if (scrollTarget) scrollTargetTaken = true;
        // A scored band outranks the raw signal count: once the model has read
        // the change, its severity is the more useful thing to show.
        const band = riskBands?.get(decisionId) ?? ((decision?.riskSignals.length ?? 0) > 0 ? 'signals' : null);
        return <section
          key={hunk.range}
          ref={scrollTarget ? activeBlock : undefined}
          tabIndex={-1}
          className={`diff-review-diff-block state-${state ?? 'pending'}${state === null ? '' : ' settled'}${active ? ' active' : ''}${marker ? ` linked relation-${marker.relation}` : ''}`}
          aria-current={active ? 'location' : undefined}
          aria-label={`${hunk.location} · ${reviewStateLabel(state)}${active ? ' · selected decision' : ''}${marker ? ` · ${CHANGE_RELATION_LABELS[marker.relation]} relationship with change ${activeOrdinal ?? ''}` : ''}`}
        >
          <div className="diff-review-block-gutter">
            {/* The standing facts about this decision — which one it is, whether
              * it is settled, how risky it scored — annotate the block chrome
              * instead of occupying a permanent column beside the diff. The
              * marker is also the handle that opens the detail popover. */}
            <button
              type="button"
              className={`diff-review-block-marker state-${state ?? 'pending'}`}
              // A stable handle on the marker, so the open popover can re-find
              // it after a re-render. Selecting a multi-file decision switches
              // the pane to its first file, which unmounts the very button that
              // was clicked; without this the panel would be left anchored to a
              // detached node and land in the viewport corner.
              data-decision-marker={decisionId}
              // Only advertise a popover when one is actually wired: a marker
              // that announces a dialog and opens nothing is a dead click.
              aria-haspopup={onOpenDetail ? 'dialog' : undefined}
              aria-expanded={onOpenDetail ? openDetailFor === decisionId : undefined}
              aria-label={`Decision ${ordinal ?? ''} · ${reviewStateLabel(state)}${band ? ` · ${band} risk` : ''} — open decision details`}
              onClick={(event) => {
                const anchor = event.currentTarget;
                onSelect(decisionId);
                onOpenDetail?.(decisionId, anchor);
              }}
            >
              <b>{ordinal ?? '·'}</b>
              <StateGlyph state={state} />
              {band && <i className={`diff-review-block-risk-dot band-${band}`} aria-hidden="true" />}
            </button>
            {marker && <span className="diff-review-diff-block-link-marker" aria-hidden="true">{marker.direction === 'upstream' ? <ArrowDownRight size={10} /> : <ArrowUpRight size={10} />}{activeOrdinal}</span>}
          </div>
          <div className="diff-review-diff-block-main">
          <button type="button" className="diff-review-diff-block-header" onClick={() => onSelect(decisionId)} aria-label={`Select the decision at ${hunk.location} in ${filePath}`}>
            <code>{hunk.range}</code>
            <small><b>+{hunk.additions}</b> <i>−{hunk.deletions}</i></small>
          </button>
          {showLens && summary && <>
            <button
              type="button"
              className="diff-review-change-links-lens"
              aria-expanded={peeking}
              onClick={() => setPeekDecisionId(peeking ? null : decisionId)}
            >
              <ArrowUpRight size={11} aria-hidden="true" />
              <span>{summary.total} related {summary.total === 1 ? 'change' : 'changes'}</span>
              {summary.byRelation.map(({ relation, count }) => <em key={relation} className={`relation-${relation}`}>{CHANGE_RELATION_LABELS[relation]} → {count}</em>)}
            </button>
            {peeking && <div className="diff-review-change-links-peek" aria-label={`Changes related to ${hunk.location}`}>
              {summary.upstream.length > 0 && <section>
                <h4>Upstream — this change exists because of</h4>
                <ul>{summary.upstream.map((link) => <ChangeLinkItem key={`up-${link.decisionId}-${link.relation}`} link={link} onSelect={selectRelated} />)}</ul>
              </section>}
              {summary.downstream.length > 0 && <section>
                <h4>Downstream — moved because of this change</h4>
                <ul>{summary.downstream.map((link) => <ChangeLinkItem key={`down-${link.decisionId}-${link.relation}`} link={link} onSelect={selectRelated} />)}</ul>
              </section>}
            </div>}
          </>}
          {hunk.lines.length === 0
            ? <p className="muted">No text patch is available for this file.</p>
            : hunk.lines.map((line) => <div key={line.key} className={`diff-line ${line.kind}`}>
              <span>{line.oldLine ?? ''}</span>
              <span>{line.newLine ?? ''}</span>
              <span><span className="diff-line-marker">{line.text.slice(0, 1) || ' '}</span><SyntaxHighlight code={line.text.slice(1) || ' '} language={language} className="diff-line-code" /></span>
            </div>)}
          </div>
        </section>;
      })}
    </div>
  </article>;
});
