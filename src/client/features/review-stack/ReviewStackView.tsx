import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DiffHunkReview, DiffHunkReviewState } from '../../../shared/contracts.js';
import { buildChangeMap } from '../../../shared/change-map.js';
import { buildReviewDecisions, reviewStateLabel } from '../../../shared/review-decisions.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { ReviewAssistTaskIntent } from '../diff-review/decision-detail-card.js';
import { useCachedReviewAssistAnswers } from '../diff-review/review-assist.js';
import { DiffReviewFileDiffPane } from '../diff-review/file-diff-pane.js';
import { buildFileDiffHunks } from '../diff-review/logic.js';
import { readReviewStackReadingMode, writeReviewStackBlock, writeReviewStackReadingMode, type ReviewStackReadingMode } from '../../lib/preferences.js';
import { useDiffHunkReviews, useUpsertDiffHunkReview, useWorkspaceFileSource } from '../workspace-diff/hooks.js';
import { reviewSourceKind } from './source.js';
import { fileSourceRevision } from './review-full-file.js';
import { ReviewFullFilePane } from './review-full-file-pane.js';
import { indexReviewBlocks, resolveCarriedBlockReviews, toBlockLevelFiles } from './review-blocks.js';
import { groupHunkVerdictsByState, newlyProjectedHunkVerdicts, projectHunkVerdicts } from './review-hunk-projection.js';
import { buildReviewQueue, nextUnsettledBlockId, reviewQueueProgress } from './review-queue.js';
import { REVIEW_TIER_LABELS } from './review-routing.js';
import { ReviewChangeBrief } from './review-change-brief.js';
import { ReviewChangeCanvas } from './review-change-canvas.js';
import { selectReviewBlock, type ReviewSelection } from './review-selection.js';
import { useBlockAssistAnswers } from './use-block-assist.js';
import { useDiffBlockReviews, useUpsertDiffBlockReview } from './use-block-reviews.js';
import { useReviewSource } from './use-review-source.js';
import { useReviewKeyboardNavigation } from './use-review-keyboard-navigation.js';

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
  // What Changes has already been told about this revision. Read, not assumed:
  // the reconcile below has to know which hunks are genuinely still owed, or it
  // would rewrite every hunk in the diff on each load.
  const hunkReviews = useDiffHunkReviews(scope, revision);

  // Every stored verdict this scope holds, resolved onto the blocks on screen
  // now. Only verdicts whose block still hashes the same are applied: a block
  // whose lines were rewritten asks its question again rather than inheriting
  // an answer given about other code. A block that merely moved keeps its
  // answer, which is the whole point — a review already given is not owed
  // twice.
  const carried = useMemo(() => resolveCarriedBlockReviews(blocks, blockReviews.data?.reviews ?? []), [blockReviews.data, blocks]);

  // Addressed by the block's *current* range, not the one the verdict was
  // recorded at: downstream decisions are built from today's diff, and a
  // verdict filed under last revision's line numbers would match nothing.
  const currentReviews = useMemo((): DiffHunkReview[] => {
    const seen = new Set<string>();
    return carried.flatMap(({ identity, review }) => {
      if (seen.has(identity.decisionId)) return [];
      seen.add(identity.decisionId);
      return [{ id: review.id, revision: review.revision, filePath: identity.filePath, hunkRange: identity.range, state: review.state, note: review.note, updatedAt: review.updatedAt }];
    });
  }, [carried]);

  // Notes are keyed the way verdicts are, by block. They are read back
  // separately from the verdicts because a note outlives the state it was
  // saved with: a block commented on and later marked reviewed still holds
  // what the reviewer said about it.
  const savedNotes = useMemo(() => {
    const map = new Map<string, string>();
    for (const { identity, review } of carried) {
      if (review.note && !map.has(identity.storageKey)) map.set(identity.storageKey, review.note);
    }
    return map;
  }, [carried]);

  // The block verdicts this scope holds about the code on screen, keyed the way
  // the projection reads them. Built once so the reconcile that runs on load and
  // the one that runs on save can never disagree about what is already answered.
  const carriedVerdicts = useMemo(() => {
    const verdicts = new Map<string, DiffHunkReviewState>();
    for (const { identity, review } of carried) if (!verdicts.has(identity.storageKey)) verdicts.set(identity.storageKey, review.state);
    return verdicts;
  }, [carried]);

  const decisions = useMemo(() => buildReviewDecisions(blockFiles, currentReviews), [blockFiles, currentReviews]);
  const changeMap = useMemo(() => buildChangeMap(decisions), [decisions]);
  // Escalation input, declared before the queue that consumes it and filled
  // by the lookup below once a block is open.
  const assist = useBlockAssistAnswers(revision);
  const queue = useMemo(() => buildReviewQueue(decisions, changeMap, blocks, assist.answers), [decisions, changeMap, blocks, assist.answers]);
  const progress = useMemo(() => reviewQueueProgress(queue), [queue]);
  // Changes the reviewer is done with, and the one word that says why. Two ways
  // a change gets here: a verdict was recorded against it, or routing priced it
  // below Jeffrey's reading time — T0 settles by proof and T1 hands the read to
  // a model. Both surfaces read this one map, so the canvas and the code can
  // never disagree about which changes are still owed.
  const handled = useMemo(() => new Map(queue.flatMap((entry) => {
    if (entry.decision.state !== null) return [[entry.decision.id, reviewStateLabel(entry.decision.state)] as const];
    if (entry.routing.tier === 'T0' || entry.routing.tier === 'T1') {
      return [[entry.decision.id, REVIEW_TIER_LABELS[entry.routing.tier]] as const];
    }
    return [];
  })), [queue]);

  // One selection, with one writer per field: the queue writes the block, the
  // map writes only what is highlighted inside itself.
  const [selection, setSelection] = useState<ReviewSelection | null>(null);
  const [selectionTick, setSelectionTick] = useState(0);
  // Which change is open. Pressing a handle — the gutter marker or a canvas
  // node — is what opens one: both name the same change, so both put its brief
  // in the code pane under the block it belongs to. Pressing the open one
  // again closes it.
  const [openChangeId, setOpenChangeId] = useState<string | null>(null);
  // An open card is the code and the canvas, and nothing else: no decision
  // panel, in front of the panes or behind a handle. A verdict is recorded with
  // the keyboard, against the block the card is already on.
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
    // Moving the selection by any other means — the keyboard, a relationship
    // link, saving a verdict — closes what a handle opened, so a brief never
    // stays behind on a change the reader has left.
    setOpenChangeId(null);
    if (revision) writeReviewStackBlock(source.preferenceScope, revision, decisionId);
  }, [revision, source.preferenceScope]);

  /** What both handles do: move the selection to that change and open it. */
  const openChange = useCallback((decisionId: string) => {
    const closing = openChangeId === decisionId;
    selectBlock(decisionId);
    setOpenChangeId(closing ? null : decisionId);
  }, [openChangeId, selectBlock]);

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

  // Carry the reconciliation forward, not just the verdict. `diff_hunk_reviews`
  // is keyed on the revision, so answers given before the branch moved leave
  // Changes showing those hunks unanswered even though Review now holds a
  // verdict for every block inside them — the same code, asked about twice.
  // Projecting on load closes that: the answers reach Changes at whatever
  // revision is open, instead of waiting for the next verdict that happens to be
  // saved. It settles after one pass, because the write invalidates the read it
  // is diffed against and the delta is then empty.
  //
  // Asked at most once per hunk, verdict and revision. The write invalidates the
  // read it is diffed against, which normally empties the delta by itself, but a
  // write that fails or a read that lags must not turn one reconcile into a loop
  // that rewrites Changes on every render.
  const reconcileHunkVerdicts = upsertHunkReviews.mutate;
  const recordedHunks = hunkReviews.data?.reviews;
  const reconciled = useRef(new Set<string>());
  useEffect(() => {
    if (!revision || !recordedHunks || files.length === 0 || carriedVerdicts.size === 0) return;
    const asked = (verdict: { filePath: string; hunkRange: string; state: DiffHunkReviewState }) => [revision, verdict.filePath, verdict.hunkRange, verdict.state].join('\u0000');
    const owed = newlyProjectedHunkVerdicts(recordedHunks, projectHunkVerdicts(files, carriedVerdicts))
      .filter((verdict) => !reconciled.current.has(asked(verdict)));
    if (owed.length === 0) return;
    for (const verdict of owed) reconciled.current.add(asked(verdict));
    for (const group of groupHunkVerdictsByState(owed)) reconcileHunkVerdicts(group);
  }, [carriedVerdicts, files, recordedHunks, reconcileHunkVerdicts, revision]);

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
    const blockVerdicts = new Map(carriedVerdicts);
    const before = projectHunkVerdicts(files, blockVerdicts);
    for (const identity of active.identities) blockVerdicts.set(identity.storageKey, state);
    for (const group of groupHunkVerdictsByState(newlyProjectedHunkVerdicts(before, projectHunkVerdicts(files, blockVerdicts)))) upsertHunkReviews.mutate(group);

    const next = nextUnsettledBlockId(queue, active.decision.id);
    if (next) selectBlock(next);
  }, [active, carriedVerdicts, files, queue, revision, savedNotes, selectBlock, upsertBlockReview, upsertHunkReviews]);

  const changedLoc = useMemo(() => files.reduce((total, file) => total + file.additions + file.deletions, 0), [files]);
  const markReviewed = useCallback(() => saveVerdict('reviewed'), [saveVerdict]);
  // There is no stack to return to: the card is the whole surface, so the
  // selection only ever moves between blocks. Keyboard navigation and clicks
  // in either pane are the two ways to move it.
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
      : <div className="review-stack-layout">
        {active && <div className="review-stack-detail">
          {/* An open card is two panes and nothing else: the code on the left,
              the canvas on the right, each scrolling on its own. They are two
              readings of one thing, so they share a selection rather than
              tracking one each — selecting a hunk moves the canvas, selecting a
              node moves the code. */}
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
                          selectionTick={selectionTick}
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
                    openDetailFor={openChangeId}
                    handledBlocks={handled}
                    renderDetail={(decisionId) => decisionId === active.decision.id
                      ? <ReviewChangeBrief
                          entry={active}
                          saving={upsertBlockReview.isPending}
                          error={upsertBlockReview.error ? 'Try again.' : null}
                          onMarkReviewed={markReviewed}
                          onClose={() => setOpenChangeId(null)}
                        />
                      : null}
                    onSelect={selectBlock}
                    onOpenDetail={openChange}
                    onToggleReadingMode={toggleReadingMode}
                  />)}
            </div>
            <ReviewChangeCanvas
              map={changeMap}
              selectedId={selectedId}
              selectionTick={selectionTick}
              handled={handled}
              onSelect={openChange}
            />
          </div>
        </div>}
      </div>}
  </section>;
});
