import { memo, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DiffHunkReview, DiffHunkReviewState } from '../../../shared/contracts.js';
import { buildChangeMap } from '../../../shared/change-map.js';
import { buildReviewDecisions } from '../../../shared/review-decisions.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { ReviewAssistTaskIntent } from '../diff-review/decision-detail-card.js';
import { DiffReviewDecisionDetailCard } from '../diff-review/decision-detail-card.js';
import { DecisionRelationshipDiagram } from '../diff-review/decision-relationship-diagram.js';
import { DiffReviewFileDiffPane } from '../diff-review/file-diff-pane.js';
import { DiffReviewActions } from '../diff-review/review-actions.js';
import { buildFileDiffHunks } from '../diff-review/logic.js';
import { writeReviewStackBlock } from '../../lib/preferences.js';
import { indexReviewBlocks, toBlockLevelFiles } from './review-blocks.js';
import { buildReviewQueue, nextUnsettledBlockId, reviewQueueProgress } from './review-queue.js';
import { ReviewQueueList } from './review-queue-list.js';
import { REVIEW_TIER_LABELS } from './review-routing.js';
import { useDiffBlockReviews, useUpsertDiffBlockReview } from './use-block-reviews.js';
import { useReviewSource } from './use-review-source.js';

/**
 * The review stack: an alternative to the Changes view, not a replacement.
 *
 * Changes renders a diff and lets a reviewer walk it. This surface starts from
 * the opposite end — a queue of semantic blocks ordered by the attention each
 * one deserves — and only then shows the code. Everything it needs that Changes
 * also uses is either a read-only component or a data hook; its splitting, its
 * ranking, its selection, its preferences and its persisted verdicts are all
 * its own, so Changes behaves exactly as it did before this existed.
 */
export const ReviewStackView = memo(function ReviewStackView({ scope, taskIntent = null, pullRequestUrlCandidates }: {
  scope: WorkspaceDiffScope;
  taskIntent?: ReviewAssistTaskIntent;
  pullRequestUrlCandidates?: string[];
}) {
  const source = useReviewSource(scope, pullRequestUrlCandidates);
  const files = useMemo(() => source.source?.files ?? [], [source.source]);
  // Blocks are cut once, and both the diff the reviewer reads and the identity
  // the verdict is stored against come from that same split.
  const blockFiles = useMemo(() => toBlockLevelFiles(files), [files]);
  const blocks = useMemo(() => indexReviewBlocks(files), [files]);

  const revision = files.length > 0 ? source.source?.revision : undefined;
  const blockReviews = useDiffBlockReviews(scope, revision);
  const upsertBlockReview = useUpsertDiffBlockReview(scope, revision);

  // Only verdicts whose block still hashes the same are applied: a block whose
  // lines were rewritten under an unchanged range asks its question again
  // rather than inheriting an answer given about other code.
  const currentReviews = useMemo((): DiffHunkReview[] => (blockReviews.data?.reviews ?? []).flatMap((review) => {
    const identity = blocks.get(`${review.filePath}::${review.blockRange}`);
    if (!identity || identity.contentHash !== review.contentHash) return [];
    return [{ id: review.id, revision: review.revision, filePath: review.filePath, hunkRange: review.blockRange, state: review.state, note: review.note, updatedAt: review.updatedAt }];
  }), [blockReviews.data, blocks]);

  const decisions = useMemo(() => buildReviewDecisions(blockFiles, currentReviews), [blockFiles, currentReviews]);
  const changeMap = useMemo(() => buildChangeMap(decisions), [decisions]);
  const queue = useMemo(() => buildReviewQueue(decisions, changeMap, blocks), [decisions, changeMap, blocks]);
  const progress = useMemo(() => reviewQueueProgress(queue), [queue]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectionTick, setSelectionTick] = useState(0);
  useEffect(() => {
    // Open on the top of the queue, and recover when the diff changes under a
    // selection that no longer exists.
    if (queue.length === 0) return;
    if (selectedId && queue.some((entry) => entry.decision.id === selectedId)) return;
    setSelectedId(queue.find((entry) => !entry.routing.autoSettled)?.decision.id ?? queue[0].decision.id);
  }, [queue, selectedId]);

  const selectBlock = (decisionId: string) => {
    setSelectedId(decisionId);
    setSelectionTick((tick) => tick + 1);
    if (revision) writeReviewStackBlock(source.preferenceScope, revision, decisionId);
  };

  const active = queue.find((entry) => entry.decision.id === selectedId) ?? null;
  const activeFilePath = active?.decision.hunks[0]?.filePath ?? null;
  const activeFile = blockFiles.find((file) => file.path === activeFilePath) ?? null;
  const fileHunks = useMemo(() => activeFile ? buildFileDiffHunks(activeFile) : [], [activeFile]);

  const saveVerdict = (state: DiffHunkReviewState) => {
    if (!active || !revision) return;
    // One thought can span several blocks; the verdict is recorded against
    // every block it covers so none of them comes back as unanswered.
    for (const identity of active.identities) {
      upsertBlockReview.mutate({ filePath: identity.filePath, blockRange: identity.range, contentHash: identity.contentHash, state });
    }
    const next = nextUnsettledBlockId(queue, active.decision.id);
    if (next) selectBlock(next);
  };

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

    {queue.length === 0
      ? <p className="review-stack-empty">Nothing to review in this source.</p>
      : <div className="review-stack-layout">
        <ReviewQueueList queue={queue} activeId={selectedId} onSelect={selectBlock} />
        {active && <div className="review-stack-detail">
          <DiffReviewDecisionDetailCard decision={active.decision} taskIntent={taskIntent} decisions={decisions} tier={active.routing.tier}>
            <div className="review-stack-obligations">
              <h4>{REVIEW_TIER_LABELS[active.routing.tier]} — {active.routing.reason}</h4>
              <ul>
                {active.obligations.map((obligation) => <li key={obligation.id} className={`settled-by-${obligation.settledBy}`}>
                  <span>{obligation.settledBy}</span>{obligation.question}
                </li>)}
              </ul>
            </div>
            <DiffReviewActions saving={upsertBlockReview.isPending} error={upsertBlockReview.error instanceof Error ? upsertBlockReview.error.message : null} onSave={saveVerdict} />
          </DiffReviewDecisionDetailCard>

          {/* The map is a camera for the critical parts, not a dashboard: it is
              drawn only for a block that earned it. */}
          {active.showsMap && <DecisionRelationshipDiagram map={changeMap} decisionId={active.decision.id} onSelect={selectBlock} />}

          {activeFile && <DiffReviewFileDiffPane
            filePath={activeFile.path}
            editorUrl={activeFile.editorUrl ?? null}
            hunks={fileHunks}
            decisions={decisions}
            activeDecisionId={active.decision.id}
            selectionTick={selectionTick}
            changeMap={changeMap}
            onSelect={selectBlock}
          />}
        </div>}
      </div>}
  </section>;
});
