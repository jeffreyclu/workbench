import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DiffHunkReview, DiffHunkReviewState } from '../../../shared/contracts.js';
import { buildChangeMap } from '../../../shared/change-map.js';
import { buildReviewDecisions } from '../../../shared/review-decisions.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { ReviewAssistTaskIntent } from '../diff-review/decision-detail-card.js';
import { DiffReviewDecisionDetailCard } from '../diff-review/decision-detail-card.js';
import { DecisionPopover, type DecisionPopoverAnchor } from '../diff-review/decision-popover.js';
import { useCachedReviewAssistAnswers } from '../diff-review/review-assist.js';
import { DiffReviewFileDiffPane } from '../diff-review/file-diff-pane.js';
import { DiffReviewActions } from '../diff-review/review-actions.js';
import { buildFileDiffHunks } from '../diff-review/logic.js';
import { readReviewStackReadingMode, writeReviewStackBlock, writeReviewStackReadingMode, type ReviewStackReadingMode } from '../../lib/preferences.js';
import { useUpsertDiffHunkReview, useWorkspaceFileSource } from '../workspace-diff/hooks.js';
import { blockClaim } from './review-claims.js';
import { reviewSourceKind } from './source.js';
import { fileSourceRevision } from './review-full-file.js';
import { ReviewFullFilePane } from './review-full-file-pane.js';
import { indexReviewBlocks, reviewBlockStorageKey, toBlockLevelFiles } from './review-blocks.js';
import { groupHunkVerdictsByState, newlyProjectedHunkVerdicts, projectHunkVerdicts } from './review-hunk-projection.js';
import { buildReviewQueue, nextUnsettledBlockId, reviewQueueProgress } from './review-queue.js';
import { ReviewBlockNote } from './review-block-note.js';
import { ReviewQueueList } from './review-queue-list.js';
import { REVIEW_TIER_LABELS } from './review-routing.js';
import { REVIEW_CANVAS_NODE_ATTRIBUTE, ReviewChangeCanvas } from './review-change-canvas.js';
import { selectReviewBlock, type ReviewSelection } from './review-selection.js';
import { useBlockAssistAnswers } from './use-block-assist.js';
import { useDiffBlockReviews, useUpsertDiffBlockReview } from './use-block-reviews.js';
import { useReviewSource } from './use-review-source.js';
import { adjacentDecisionId, adjacentFileDecisionId, useReviewKeyboardNavigation } from './use-review-keyboard-navigation.js';

/** One tooltip for the one key that cycles all three readings, so the button
 * never claims a two-way toggle Review no longer has. */
const READING_MODE_TITLE = 'Cycle the reading: final code, unified diff, whole file (d)';

const STOPPING_POINT_LOC = 400;

/**
 * The review stack: an alternative to the Changes view, not a replacement.
 *
 * Changes renders a diff and lets a reviewer walk it. This surface starts from
 * the opposite end — a queue of semantic blocks ordered by the attention each
 * one deserves — and only then shows the code. Everything it needs that Changes
 * also uses is either a read-only component or a data hook; its splitting, its
 * ranking, its selection, its preferences and its persisted verdicts are all
 * its own, so Changes behaves exactly as it did before this existed.
 *
 * b13bf425-4047-4b22-b7c3-85317d6819fe LEGACY-AFFECTING: Existing Review
 * stack sessions now accept document-level shortcuts and show a stopping cue
 * for large diffs. This stays here, instead of the shared Changes surface, so
 * it cannot change selection or review behavior for the older review flow.
 */
export const ReviewStackView = memo(function ReviewStackView({ scope, taskIntent = null, pullRequestUrlCandidates }: {
  scope: WorkspaceDiffScope;
  taskIntent?: ReviewAssistTaskIntent;
  pullRequestUrlCandidates?: string[];
}) {
  // Review defaults to reading the finished code rather than the unified
  // diff: its unit is a whole parsed construct, so the after-state is legal
  // code on its own, and an interleaved two-sided reading is the harder way to
  // judge a block that was rewritten wholesale.
  // The default is 'final', but the reviewer's own last choice outranks it and
  // survives remounting, switching conversations and reloading.
  const [readingMode, setReadingMode] = useState<ReviewStackReadingMode>(() => readReviewStackReadingMode() ?? 'final');
  // Three readings of the same block, widening each time: the finished
  // construct, the two-sided diff, then the whole file the construct sits in.
  // One key cycles them because they answer the same question at different
  // magnifications, not three separate questions.
  const toggleReadingMode = useCallback(() => {
    const order: ReviewStackReadingMode[] = ['final', 'diff', 'file'];
    const next = order[(order.indexOf(readingMode) + 1) % order.length];
    setReadingMode(next);
    writeReviewStackReadingMode(next);
  }, [readingMode]);
  const source = useReviewSource(scope, pullRequestUrlCandidates);
  const files = useMemo(() => source.source?.files ?? [], [source.source]);
  // Blocks are cut once, and both the diff the reviewer reads and the identity
  // the verdict is stored against come from that same split.
  const blockFiles = useMemo(() => toBlockLevelFiles(files), [files]);
  const blocks = useMemo(() => indexReviewBlocks(files), [files]);

  const revision = files.length > 0 ? source.source?.revision : undefined;
  const blockReviews = useDiffBlockReviews(scope, revision);
  const upsertBlockReview = useUpsertDiffBlockReview(scope, revision);
  // The Changes-owned writer, reused rather than reimplemented: reconciling a
  // hunk has to land in the same table and invalidate the same cache Changes
  // reads, or the two surfaces would disagree until a reload.
  const upsertHunkReviews = useUpsertDiffHunkReview(scope, revision);

  // Only verdicts whose block still hashes the same are applied: a block whose
  // lines were rewritten under an unchanged range asks its question again
  // rather than inheriting an answer given about other code.
  const currentReviews = useMemo((): DiffHunkReview[] => (blockReviews.data?.reviews ?? []).flatMap((review) => {
    const identity = blocks.get(`${review.filePath}::${review.blockRange}`);
    if (!identity || identity.contentHash !== review.contentHash) return [];
    return [{ id: review.id, revision: review.revision, filePath: review.filePath, hunkRange: review.blockRange, state: review.state, note: review.note, updatedAt: review.updatedAt }];
  }), [blockReviews.data, blocks]);

  // Notes are keyed the way verdicts are, by block. They are read back
  // separately from the verdicts because a note outlives the state it was
  // saved with: a block commented on and later marked reviewed still holds
  // what the reviewer said about it.
  const savedNotes = useMemo(() => {
    const map = new Map<string, string>();
    for (const review of blockReviews.data?.reviews ?? []) {
      if (review.note) map.set(reviewBlockStorageKey(review.filePath, review.blockRange, review.contentHash), review.note);
    }
    return map;
  }, [blockReviews.data]);

  const decisions = useMemo(() => buildReviewDecisions(blockFiles, currentReviews), [blockFiles, currentReviews]);
  const changeMap = useMemo(() => buildChangeMap(decisions), [decisions]);
  // Escalation input, declared before the queue that consumes it and filled
  // by the lookup below once a block is open.
  const assist = useBlockAssistAnswers(revision);
  const queue = useMemo(() => buildReviewQueue(decisions, changeMap, blocks, assist.answers), [decisions, changeMap, blocks, assist.answers]);
  const progress = useMemo(() => reviewQueueProgress(queue), [queue]);

  // One selection, with one writer per field: the queue writes the block, the
  // map writes only what is highlighted inside itself.
  const [selection, setSelection] = useState<ReviewSelection | null>(null);
  const [selectionTick, setSelectionTick] = useState(0);
  // An open card is the code and the canvas, and nothing else. Everything a
  // reviewer decides with — the claim, what is still owed, the verdict buttons,
  // the comment — is one click away in the popover, anchored to whichever
  // handle opened it: a gutter marker or a canvas node.
  const [detailAnchor, setDetailAnchor] = useState<{ decisionId: string; anchor: DecisionPopoverAnchor; anchorAttribute: string } | null>(null);
  const selectedId = selection?.blockId ?? null;
  useEffect(() => {
    // Open on the top of the queue, and recover when the diff changes under a
    // selection that no longer exists.
    if (queue.length === 0) return;
    if (selectedId && queue.some((entry) => entry.decision.id === selectedId)) return;
    setSelection(selectReviewBlock(queue.find((entry) => !entry.routing.autoSettled)?.decision.id ?? queue[0].decision.id));
  }, [queue, selectedId]);

  const selectBlock = useCallback((decisionId: string) => {
    setSelection(selectReviewBlock(decisionId));
    setSelectionTick((tick) => tick + 1);
    // Moving to another change closes a panel about the one being left, but a
    // handle selects its own change before it opens the panel, so an unchanged
    // id keeps the anchor — otherwise the handle would clear and immediately
    // reopen and never toggle shut.
    setDetailAnchor((current) => (current && current.decisionId === decisionId ? current : null));
    if (revision) writeReviewStackBlock(source.preferenceScope, revision, decisionId);
  }, [revision, source.preferenceScope]);

  /** The one opener both handles share, so a gutter marker and a canvas node
   * put up the same panel and each keeps re-anchoring to its own surface. */
  const openDecisionDetail = useCallback((decisionId: string, anchor: DecisionPopoverAnchor, anchorAttribute = 'data-decision-marker') => {
    setDetailAnchor((current) => (current?.decisionId === decisionId ? null : { decisionId, anchor, anchorAttribute }));
  }, []);

  const active = queue.find((entry) => entry.decision.id === selectedId) ?? null;
  const activeFilePath = active?.decision.hunks[0]?.filePath ?? null;
  const activeFile = blockFiles.find((file) => file.path === activeFilePath) ?? null;
  const fileHunks = useMemo(() => activeFile ? buildFileDiffHunks(activeFile) : [], [activeFile]);
  // Whole-file reading needs the file itself, and only a source this checkout
  // can produce has one: a pull request's after-state lives on a head revision
  // this checkout may never have fetched, and a sibling worktree's after-state
  // is uncommitted text on another path entirely. Asking for either would read
  // the local copy of the same path and mark the changes on the wrong text.
  const wholeFileReadable = source.sourceId
    ? ['workspace', 'history', 'branch'].includes(reviewSourceKind(source.sourceId))
    : false;
  const fileSourceQuery = useWorkspaceFileSource(
    scope,
    activeFile?.path ?? null,
    fileSourceRevision(source.source?.revision),
    readingMode === 'file' && wholeFileReadable,
  );

  // Cache-only, and keyed to the tier routing first priced the block at rather
  // than the tier it currently shows: an escalated block still reads back the
  // cheaper answer that escalated it, so the escalation holds instead of
  // flickering off the moment it takes effect. No model turn is spawned here —
  // this reads only answers the reviewer already asked for.
  const cachedAssist = useCachedReviewAssistAnswers(active?.decision ?? null, taskIntent, decisions, active?.assistTier ?? null);
  const activeId = active?.decision.id ?? null;
  const cachedAnswers = useMemo(() => Object.values(cachedAssist.data ?? {}), [cachedAssist.data]);
  const rememberAssist = assist.remember;
  useEffect(() => {
    if (activeId) rememberAssist(activeId, cachedAnswers);
  }, [activeId, cachedAnswers, rememberAssist]);

  const saveVerdict = useCallback((state: DiffHunkReviewState, note?: string) => {
    if (!active || !revision) return;
    // One thought can span several blocks; the verdict is recorded against
    // every block it covers so none of them comes back as unanswered.
    for (const identity of active.identities) {
      // The row's note column is overwritten on every upsert, so a verdict
      // saved without one carries the block's existing note forward. Marking a
      // block reviewed after commenting on it must not erase the comment.
      const carried = note ?? savedNotes.get(identity.storageKey);
      upsertBlockReview.mutate({ filePath: identity.filePath, blockRange: identity.range, contentHash: identity.contentHash, state, ...(carried ? { note: carried } : {}) });
    }
    // Reconcile with Changes. A block verdict is Review's unit, but Changes
    // addresses hunks, so a hunk is only claimed once every block inside it has
    // an answer. The projection is computed from the rows plus the verdict just
    // written, so it does not wait for the block-review query to come back.
    const blockVerdicts = new Map<string, DiffHunkReviewState>();
    for (const review of blockReviews.data?.reviews ?? []) blockVerdicts.set(reviewBlockStorageKey(review.filePath, review.blockRange, review.contentHash), review.state);
    const before = projectHunkVerdicts(files, blockVerdicts);
    for (const identity of active.identities) blockVerdicts.set(identity.storageKey, state);
    for (const group of groupHunkVerdictsByState(newlyProjectedHunkVerdicts(before, projectHunkVerdicts(files, blockVerdicts)))) upsertHunkReviews.mutate(group);

    const next = nextUnsettledBlockId(queue, active.decision.id);
    if (next) selectBlock(next);
  }, [active, blockReviews.data, files, queue, revision, savedNotes, selectBlock, upsertBlockReview, upsertHunkReviews]);

  // An entry is one thought spread over blocks, so the first note found on any
  // of them is the note about that thought.
  const activeNote = useMemo(() => {
    for (const identity of active?.identities ?? []) {
      const found = savedNotes.get(identity.storageKey);
      if (found) return found;
    }
    return null;
  }, [active, savedNotes]);
  const claim = useMemo(() => active ? blockClaim(active.decision) : null, [active]);
  const changedLoc = useMemo(() => files.reduce((total, file) => total + file.additions + file.deletions, 0), [files]);
  const selectNextDecision = useCallback(() => {
    const next = adjacentDecisionId(queue, activeId, 1);
    if (next) selectBlock(next);
  }, [activeId, queue, selectBlock]);
  const selectPreviousDecision = useCallback(() => {
    const previous = adjacentDecisionId(queue, activeId, -1);
    if (previous) selectBlock(previous);
  }, [activeId, queue, selectBlock]);
  const selectNextFile = useCallback(() => {
    const next = adjacentFileDecisionId(queue, activeFilePath, 1);
    if (next) selectBlock(next);
  }, [activeFilePath, queue, selectBlock]);
  const selectPreviousFile = useCallback(() => {
    const previous = adjacentFileDecisionId(queue, activeFilePath, -1);
    if (previous) selectBlock(previous);
  }, [activeFilePath, queue, selectBlock]);
  const markReviewed = useCallback(() => saveVerdict('reviewed'), [saveVerdict]);
  // The stack and the canvas are one surface, so a card click has to open
  // something. Where both fit they sit side by side; on one column the canvas
  // takes the space and the back control gives the stack back. Keyboard
  // navigation deliberately does not force it open — it moves a selection the
  // reader already has in front of them.
  const [canvasOpen, setCanvasOpen] = useState(false);
  const backToStackRef = useRef<HTMLButtonElement>(null);
  const openCanvas = useCallback((decisionId: string) => {
    selectBlock(decisionId);
    setCanvasOpen(true);
  }, [selectBlock]);
  useEffect(() => {
    if (!canvasOpen) return;
    // Only where the canvas actually replaced the stack: there the card that
    // was just clicked is now hidden, so focus would be dropped on the document
    // body. Asking whether the control is on screen keeps the breakpoint in the
    // stylesheet, which is the only place that decides this.
    if (!backToStackRef.current?.offsetParent) return;
    backToStackRef.current.focus();
  }, [canvasOpen]);
  // b13bf425-4047-4b22-b7c3-85317d6819fe LEGACY-AFFECTING: Keyboard input
  // follows the existing queue selection and verdict writer, preserving the
  // same persistence and next-unsettled behavior as the visible Review button.
  useReviewKeyboardNavigation({
    queue, activeId, activeFilePath, canMarkReviewed: Boolean(active && revision && !upsertBlockReview.isPending), onSelect: selectBlock, onMarkReviewed: markReviewed, onToggleReadingMode: toggleReadingMode,
  });

  if (source.isLoading) return <section className="review-stack" aria-label="Review stack loading" aria-busy="true"><p>Preparing the review queue…</p></section>;
  if (source.error) return <section className="review-stack" aria-label="Review stack"><p role="alert">Could not load a diff to review. <button type="button" className="button secondary compact" onClick={source.refresh}>Retry</button></p></section>;

  return <section className="review-stack" aria-label="Review stack">
    <header>
      <div className="review-stack-source">
        <label htmlFor="review-stack-source-select">Reviewing</label>
        <select id="review-stack-source-select" value={source.sourceId ?? ''} onChange={(event) => source.selectSource(event.target.value)}>
          {source.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <button type="button" className="icon-button" onClick={source.refresh} aria-label="Refresh"><RefreshCw size={13} /></button>
      </div>
      <p className="review-stack-progress" role="status">
        {progress.remaining} to judge · {progress.settled} settled automatically · {progress.judged} of {progress.total} answered
      </p>
    </header>

    {changedLoc > STOPPING_POINT_LOC && <aside className="review-stopping-point" role="note" aria-label="Suggested stopping point">
      <strong>{changedLoc} changed lines.</strong> This is a good stopping point: save your decisions and continue with a fresh pass.
    </aside>}

    {queue.length === 0
      ? <p className="review-stack-empty">Nothing to review in this source.</p>
      : <div className={`review-stack-layout${canvasOpen ? ' is-canvas-open' : ''}`}>
        <ReviewQueueList queue={queue} activeId={selectedId} onSelect={openCanvas} />
        {active && <div className="review-stack-detail">
          <button type="button" ref={backToStackRef} className="review-stack-back" onClick={() => setCanvasOpen(false)}>Back to stack</button>

          {/* An open card is two panes and nothing else: the code on the left,
              the canvas on the right, each scrolling on its own. They are two
              readings of one thing, so they share a selection rather than
              tracking one each — selecting a hunk moves the canvas, selecting a
              node moves the code, and either handle opens the same decision. */}
          <div className="review-stack-panes">
            <div className="review-stack-code">
              {activeFile && (readingMode === 'file'
                ? <div className="review-full-file-shell">
                    <button
                      type="button"
                      className="diff-review-reading-mode mode-file"
                      title={READING_MODE_TITLE}
                      onClick={toggleReadingMode}
                    >Whole file</button>
                    {wholeFileReadable
                      ? <ReviewFullFilePane
                          filePath={activeFile.path}
                          file={fileSourceQuery.data?.file ?? null}
                          isLoading={fileSourceQuery.isLoading}
                          error={fileSourceQuery.error ? 'This file could not be read.' : null}
                          hunks={fileHunks}
                          activeDecisionId={active.decision.id}
                          onSelect={selectBlock}
                        />
                      : <p className="review-full-file-note">A pull request has no local copy of this file, so it cannot be read whole here.</p>}
                  </div>
                : <DiffReviewFileDiffPane
                    filePath={activeFile.path}
                    editorUrl={activeFile.editorUrl ?? null}
                    hunks={fileHunks}
                    decisions={decisions}
                    activeDecisionId={active.decision.id}
                    selectionTick={selectionTick}
                    changeMap={changeMap}
                    readingMode={readingMode}
                    modeTitle={READING_MODE_TITLE}
                    openDetailFor={detailAnchor?.decisionId ?? null}
                    onSelect={selectBlock}
                    onOpenDetail={openDecisionDetail}
                    onToggleReadingMode={toggleReadingMode}
                  />)}
            </div>
            <ReviewChangeCanvas
              map={changeMap}
              selectedId={selectedId}
              openDetailFor={detailAnchor?.decisionId ?? null}
              selectionTick={selectionTick}
              onSelect={selectBlock}
              onOpenDetail={(decisionId, anchor) => openDecisionDetail(decisionId, anchor, REVIEW_CANVAS_NODE_ATTRIBUTE)}
            />
          </div>

          {/* Only ever the open block: both handles select before they open, so
              a panel about some other change would be a panel whose verdict
              buttons wrote somewhere the reviewer is not looking. */}
          {detailAnchor && detailAnchor.decisionId === active.decision.id && <DecisionPopover
            anchor={detailAnchor.anchor}
            anchorId={detailAnchor.decisionId}
            anchorAttribute={detailAnchor.anchorAttribute}
            labelledBy="review-stack-decision-title"
            onClose={() => setDetailAnchor(null)}
          >
            {/* The claim leads. The obligations below it are the ways it can be
                false, and the code behind the panel is where a reviewer goes to
                try. */}
            {claim && <section className="review-block-claim" aria-label="What this block claims">
              <h4>This change claims</h4>
              <p>{claim.primary}</p>
              {claim.also.length > 0 && <ul>{claim.also.map((line) => <li key={line}>{line}</li>)}</ul>}
            </section>}
            <DiffReviewDecisionDetailCard decision={active.decision} titleId="review-stack-decision-title" taskIntent={taskIntent} decisions={decisions} tier={active.routing.tier}>
              <div className="review-stack-obligations">
                <h4>{REVIEW_TIER_LABELS[active.routing.tier]} — {active.routing.reason}</h4>
                <ul>
                  {/* The badge shows the answer once there is one, and who owes
                      it while there is not — an unanswered question and a proven
                      one should never read the same. */}
                  {active.obligations.map((obligation) => <li key={obligation.id} className={`settled-by-${obligation.settledBy} outcome-${obligation.outcome}`}>
                    <span>{obligation.outcome === 'unresolved' ? obligation.settledBy : obligation.outcome}</span>
                    <div>{obligation.question}{obligation.evidence ? <em>{obligation.evidence}</em> : null}</div>
                  </li>)}
                </ul>
              </div>
              <DiffReviewActions saving={upsertBlockReview.isPending} error={upsertBlockReview.error instanceof Error ? upsertBlockReview.error.message : null} onSave={saveVerdict} />
              <ReviewBlockNote
                blockId={active.decision.id}
                note={activeNote}
                saving={upsertBlockReview.isPending}
                error={upsertBlockReview.error instanceof Error ? upsertBlockReview.error.message : null}
                onSave={saveVerdict}
              />
            </DiffReviewDecisionDetailCard>
          </DecisionPopover>}
        </div>}
      </div>}
  </section>;
});
