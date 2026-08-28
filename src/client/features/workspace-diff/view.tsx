import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FileDiff, History, RefreshCw } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton.js';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { conversationClient } from '../../data/conversation-client.js';
import { sourceClient } from '../../data/source-client.js';
import type { DiffConfidenceAssessment, DiffFollowUpReference } from '../diff-confidence.js';
import { useDiffBlockConfidence } from '../diff-confidence-hooks.js';
import { AgentRunReviewHandoffCard } from '../diff-review/review-handoff-card.js';
import { DiffReviewDecisionDetailCard } from '../diff-review/decision-detail-card.js';
import { DiffReviewDecisionQueue } from '../diff-review/decision-queue.js';
import { DiffReviewFileDiffPane } from '../diff-review/file-diff-pane.js';
import type { ReviewDecisionAssessments } from '../diff-review/logic.js';
import { buildFileDiffHunks, buildReviewDecisions, nextPendingDecisionId, orderReviewDecisions, reviewDecisionBlocks } from '../diff-review/logic.js';
import { DiffReviewActions } from '../diff-review/review-actions.js';
import { DiffReviewSummaryView } from '../diff-review/summary-view.js';
import { useDiffHunkReviews, useUpsertDiffHunkReview, useWorkspaceDiff, useWorkspaceDiffChanges, useWorkspaceDiffSnapshots } from './hooks.js';
import { workspaceDiffQueryKeys } from './data.js';

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ scope, isRunning = false, activeWorkspacePaths, reviewHandoff }: {
  scope: WorkspaceDiffScope;
  isRunning?: boolean;
  activeWorkspacePaths?: string[];
  onFollowUp?: (reference: DiffFollowUpReference) => void;
  reviewHandoff?: AgentRunReviewHandoff | null;
}) {
  const queryClient = useQueryClient();
  const conversationId = 'conversationId' in scope ? scope.conversationId : null;
  const workItemId = 'workItemId' in scope ? scope.workItemId : null;
  const explorerKey = conversationId ? ['conversation-workspaces', conversationId] : ['work-item-workspaces', workItemId];
  const explorer = useQuery({
    queryKey: explorerKey,
    queryFn: () => conversationId ? conversationClient.getConversationWorkspaces(conversationId) : sourceClient.getWorkItemWorkspaces(workItemId!),
    enabled: Boolean(conversationId || workItemId),
    // A run can receive its detached worktree after this panel is mounted.
    // Refresh only the tiny explorer payload while it is active; the full diff
    // remains explicit unless its selected workspace actually changes.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: isRunning ? 2_000 : false,
  });
  const selectWorkspace = useMutation({
    mutationFn: (workspacePath: string) => conversationId ? conversationClient.selectConversationWorkspace(conversationId, workspacePath) : sourceClient.selectWorkItemWorkspace(workItemId!, workspacePath),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: explorerKey });
      await queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.detail(scope) });
      await queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.snapshots(scope) });
    },
  });
  const query = useWorkspaceDiff(scope);
  const snapshotsQuery = useWorkspaceDiffSnapshots(scope, query.data?.diff?.revision);
  const selectedWorkspacePath = explorer.data?.selectedPath ?? undefined;
  const previousWorkspacePath = useRef<string | undefined>(undefined);
  const hasObservedWorkspace = useRef(false);
  useEffect(() => {
    // The first explorer response and the initial diff request both ask the
    // server for its current selection. Subsequent changes mean the agent was
    // assigned a different detached worktree, so replace the old diff now.
    if (hasObservedWorkspace.current && previousWorkspacePath.current !== selectedWorkspacePath) {
      void query.refetch();
      void snapshotsQuery.refetch();
    }
    hasObservedWorkspace.current = true;
    previousWorkspacePath.current = selectedWorkspacePath;
  }, [selectedWorkspacePath, query.refetch, snapshotsQuery.refetch]);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  // null means "automatically show the latest record when Git is clean";
  // an empty string is the user's explicit choice to view current changes.
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const diff = query.data?.diff;
  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const selectedSnapshot = selectedSnapshotId === null && diff?.changedFiles === 0
    ? snapshots.find((snapshot) => snapshot.diff.changedFiles > 0) ?? null
    : snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;
  const displayedDiff = selectedSnapshot?.diff ?? diff;
  const agentEditingWorkspace = activeWorkspacePaths
    ? activeWorkspacePaths.includes(diff?.workspacePath ?? '')
    : isRunning;
  const hasChanges = useWorkspaceDiffChanges(scope, diff?.revision, agentEditingWorkspace && !selectedSnapshot);
  const reviewRevision = displayedDiff?.files.length ? displayedDiff.revision : undefined;
  const hunkReviews = useDiffHunkReviews(scope, reviewRevision);
  const upsertHunkReview = useUpsertDiffHunkReview(scope, reviewRevision);
  const decisions = useMemo(() => buildReviewDecisions(displayedDiff?.files ?? [], hunkReviews.data?.reviews ?? []), [displayedDiff?.files, hunkReviews.data?.reviews]);
  // The model scores every decision; the queue's order, badges and card
  // reasoning all read from these assessments rather than any static heuristic.
  const decisionBlocks = useMemo(() => reviewDecisionBlocks(decisions), [decisions]);
  const confidence = useDiffBlockConfidence(decisionBlocks);
  const assessments: ReviewDecisionAssessments = {};
  for (const decision of decisions) {
    const assessment = confidence.data[decision.id] as DiffConfidenceAssessment | undefined;
    if (assessment) assessments[decision.id] = assessment;
    else if (confidence.failedKeys.has(decision.id)) assessments[decision.id] = { risk: null, reasoning: 'The AI scorer could not be reached for this decision.' };
  }
  // Re-sorting is keyed on the scores themselves so a streamed assessment
  // reorders the queue, while an unrelated re-render leaves it stable.
  const assessmentOrderKey = decisions.map((decision) => `${decision.id}:${assessments[decision.id]?.risk ?? ''}`).join('|');
  const orderedDecisions = useMemo(() => orderReviewDecisions(decisions, assessments), [decisions, assessmentOrderKey]);
  const selectedDecision = orderedDecisions.find((decision) => decision.id === selectedDecisionId) ?? orderedDecisions[0] ?? null;
  const selectedFile = displayedDiff?.files.find((file) => file.path === selectedDecision?.filePaths[0]) ?? null;
  const fileHunks = useMemo(() => (selectedFile ? buildFileDiffHunks(selectedFile) : []), [selectedFile]);

  const saveDecision = async (state: 'reviewed' | 'needs_changes' | 'commented', note: string | undefined) => {
    if (!selectedDecision) return;
    const nextId = nextPendingDecisionId(orderedDecisions, selectedDecision.id, assessments);
    try {
      await upsertHunkReview.mutateAsync({
        hunks: selectedDecision.hunks.map((hunk) => ({ filePath: hunk.filePath, hunkRange: hunk.hunkRange })),
        state,
        note,
      });
      setSelectedDecisionId(nextId);
    } catch {
      // The mutation exposes its stable request error beside the actions.
    }
  };

  if (query.isLoading) return <DiffSkeleton />;
  if (query.isError) return <section className="workspace-diff workspace-diff-error" aria-live="polite"><strong>Could not load local workspace changes.</strong><p>{query.error.message}</p><button type="button" className="button secondary compact" onClick={() => void query.refetch()} disabled={query.isFetching}>Retry</button></section>;
  if (!diff) return null;

  return <section className="workspace-diff" aria-label="Current workspace changes">
    <header>
      <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> {selectedSnapshot ? 'Recorded version' : 'Workspace review'}</span><h2>{selectedSnapshot ? 'Workspace review record' : 'Review workspace decisions'}</h2><small>{displayedDiff?.branch}</small><p>{selectedSnapshot ? `Captured ${new Date(selectedSnapshot.capturedAt).toLocaleString()}. This record is preserved in the history.` : 'Review behavior decisions in priority order before publishing these workspace changes.'}</p>{selectedSnapshot && <small className="workspace-diff-provenance">{selectedSnapshot.originatingAgentRunId ? `Agent run ${selectedSnapshot.originatingAgentRunId}` : 'No originating agent run recorded'}{selectedSnapshot.commitHash ? ` · Commit ${selectedSnapshot.commitHash.slice(0, 12)}` : ' · No commit recorded'}</small>}</div>
      <div className="workspace-diff-actions">
        {(conversationId || workItemId) && Array.isArray(explorer.data?.workspaces) && <label className="workspace-repository-picker"><span>Repository</span><select value={explorer.data.selectedPath ?? ''} onChange={(event) => selectWorkspace.mutate(event.target.value)} disabled={selectWorkspace.isPending}><option value="" disabled>Select repository</option>{explorer.data.workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.label}</option>)}</select></label>}
        {snapshots.length > 0 && <label className="workspace-diff-timeline"><History size={13} /><span className="visually-hidden">Workspace diff history</span><select value={selectedSnapshotId ?? selectedSnapshot?.id ?? ''} onChange={(event) => { setSelectedSnapshotId(event.target.value); setSelectedDecisionId(null); }}><option value="">Current changes</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.diff.changedFiles} files</option>)}</select></label>}
        <button className={`workspace-diff-refresh${hasChanges ? ' workspace-diff-refresh-pending' : ''}`} type="button" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={13} className={query.isFetching ? 'spin' : ''} /> {hasChanges ? 'Refresh changes' : 'Refresh'}</button>
      </div>
    </header>
    {!selectedSnapshot && reviewHandoff && <AgentRunReviewHandoffCard handoff={reviewHandoff} />}
    {!displayedDiff || displayedDiff.files.length === 0 ? <p className="muted">No uncommitted changes to review.</p>
      : hunkReviews.isLoading ? <DiffSkeleton />
        : hunkReviews.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not load review decisions.</strong><p>{hunkReviews.error.message}</p><button type="button" className="button secondary compact" onClick={() => void hunkReviews.refetch()} disabled={hunkReviews.isFetching}>Retry</button></section>
          : <div className="workspace-diff-layout diff-review-layout">
            <DiffReviewSummaryView decisions={decisions} assessments={assessments} />
            {selectedDecision && <>
              <DiffReviewDecisionQueue decisions={orderedDecisions} assessments={assessments} selectedId={selectedDecision.id} onSelect={setSelectedDecisionId} />
              <div className="diff-review-workbench">
                {selectedFile && <DiffReviewFileDiffPane filePath={selectedFile.path} editorUrl={selectedFile.editorUrl ?? null} hunks={fileHunks} decisions={decisions} activeDecisionId={selectedDecision.id} onSelect={setSelectedDecisionId} />}
                <DiffReviewDecisionDetailCard decision={selectedDecision} assessment={assessments[selectedDecision.id]}>
                  <DiffReviewActions key={selectedDecision.id} initialNote={selectedDecision.note} saving={upsertHunkReview.isPending} error={upsertHunkReview.isError ? upsertHunkReview.error.message : null} onSave={(state, note) => void saveDecision(state, note)} />
                </DiffReviewDecisionDetailCard>
              </div>
            </>}
          </div>}
  </section>;
});
