import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FileDiff, GitPullRequest, History, RefreshCw, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton.js';
import { ModalDialog } from '../../components/dialogs/modal-dialog.js';
import type { DiffHunkReviewState, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildChangeMap } from '../../../shared/change-map.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { conversationClient } from '../../data/conversation-client.js';
import { sourceClient } from '../../data/source-client.js';
import type { DiffFollowUpReference } from '../diff-confidence.js';
import type { ReviewAssistTaskIntent } from '../diff-review/decision-detail-card.js';
import { DiffReviewDecisionDetailCard } from '../diff-review/decision-detail-card.js';
import { DiffReviewDecisionQueue } from '../diff-review/decision-queue.js';
import { DiffReviewFileDiffPane } from '../diff-review/file-diff-pane.js';
import type { ReviewDecision } from '../diff-review/logic.js';
import { buildFileDiffHunks, buildReviewDecisions, nextPendingDecisionId, orderReviewDecisions, reviewDecisionFollowUpReference, reviewStateShortLabel } from '../diff-review/logic.js';
import { useAutoReviewScores } from '../diff-review/auto-score.js';
import { DiffReviewActions } from '../diff-review/review-actions.js';
import { DiffReviewSummaryView } from '../diff-review/summary-view.js';
import { DiffReviewChangeMap } from '../diff-review/change-map.js';
import { useGitHubPullRequestDiff } from '../github-diff/hooks.js';
import { pullRequestLabel, pullRequestUrls } from '../github-diff/logic.js';
import { useDiffHunkReviews, useUpsertDiffHunkReview, useWorkspaceDiff, useWorkspaceDiffChanges, useWorkspaceDiffSnapshots } from './hooks.js';
import { workspaceDiffQueryKeys } from './data.js';
import { readWorkspaceDiffSelection, writeWorkspaceDiffDecision, writeWorkspaceDiffSource } from '../../lib/preferences.js';

/** The parts of a diff this review surface reads, whichever source produced
 * it. A local workspace diff satisfies it directly; a pull request is adapted
 * onto it so both are reviewed through one decision queue. */
interface ReviewSourceDiff {
  branch: string;
  revision: string;
  files: WorkspaceDiffFile[];
}

type ReviewSourceKind = 'workspace' | 'history' | 'pull-request';

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

function usePhoneReviewControls() {
  const query = '(max-width: 640px) and (pointer: coarse)';
  const [isPhone, setIsPhone] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setIsPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return isPhone;
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ scope, isRunning = false, activeWorkspacePaths, onFollowUp, taskIntent = null, pullRequestUrlCandidates }: {
  scope: WorkspaceDiffScope;
  isRunning?: boolean;
  activeWorkspacePaths?: string[];
  onFollowUp?: (reference: DiffFollowUpReference) => void;
  taskIntent?: ReviewAssistTaskIntent;
  /** Any URLs that may be pull requests. Recognised ones join the repository
   * picker as review sources beside the local checkouts. */
  pullRequestUrlCandidates?: string[];
}) {
  const queryClient = useQueryClient();
  const conversationId = 'conversationId' in scope ? scope.conversationId : null;
  const workItemId = 'workItemId' in scope ? scope.workItemId : null;
  const preferenceScope = conversationId ? `conversation:${conversationId}` : `work-item:${workItemId}`;
  const rememberedSelection = useMemo(() => readWorkspaceDiffSelection(preferenceScope), [preferenceScope]);
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
  const [mobileDecisionDetailOpen, setMobileDecisionDetailOpen] = useState(false);
  const isPhoneReview = usePhoneReviewControls();
  // null means "automatically show the latest record when Git is clean";
  // an empty string is the user's explicit choice to view current changes.
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const diff = query.data?.diff;
  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const selectedSnapshot = selectedSnapshotId === null && diff?.changedFiles === 0
    ? snapshots.find((snapshot) => snapshot.diff.changedFiles > 0) ?? null
    : snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;

  // Pull requests are review sources in the same decision queue as local
  // checkouts, but their source is explicit. A pasted URL is accepted here so
  // reviewing a PR never depends on an earlier chat message or task reference.
  const [manualPullRequestUrl, setManualPullRequestUrl] = useState<string | null>(null);
  const [pullRequestUrlDraft, setPullRequestUrlDraft] = useState('');
  const [pullRequestUrlError, setPullRequestUrlError] = useState<string | null>(null);
  const availablePullRequests = useMemo(() => pullRequestUrls([
    ...(pullRequestUrlCandidates ?? []),
    ...(manualPullRequestUrl ? [manualPullRequestUrl] : []),
  ]), [pullRequestUrlCandidates, manualPullRequestUrl]);
  const [selectedPullRequestUrl, setSelectedPullRequestUrl] = useState<string | null>(null);
  const [reviewSource, setReviewSource] = useState<ReviewSourceKind>('workspace');
  useEffect(() => {
    // Drop a selection whose pull request is no longer referenced here.
    setSelectedPullRequestUrl((current) => current && availablePullRequests.includes(current) ? current : null);
  }, [availablePullRequests]);
  useEffect(() => {
    if (rememberedSelection && availablePullRequests.includes(rememberedSelection.source)) {
      setSelectedPullRequestUrl(rememberedSelection.source);
      setReviewSource('pull-request');
    }
  }, [availablePullRequests, rememberedSelection]);
  useEffect(() => {
    // A remembered local workspace is authoritative for this browser session,
    // just as a remembered pull request is. The server remains the shared
    // default when no local preference exists.
    const source = rememberedSelection?.source;
    if (!source || availablePullRequests.includes(source) || !explorer.data) return;
    if (explorer.data.workspaces.some((workspace) => workspace.path === source)) {
      if (source !== explorer.data.selectedPath) selectWorkspace.mutate(source);
    }
  }, [availablePullRequests, explorer.data, rememberedSelection?.source, selectWorkspace]);
  useEffect(() => {
    if (!rememberedSelection?.source.startsWith('history:')) return;
    const snapshotId = rememberedSelection.source.slice('history:'.length);
    if (snapshots.some((snapshot) => snapshot.id === snapshotId)) {
      setSelectedSnapshotId(snapshotId);
      setReviewSource('history');
    }
  }, [rememberedSelection?.source, snapshots]);
  const pullRequestQuery = useGitHubPullRequestDiff(reviewSource === 'pull-request' ? selectedPullRequestUrl : null);
  const isPullRequestSource = reviewSource === 'pull-request';
  const pullRequest = pullRequestQuery.data?.pages[0]?.diff ?? null;
  const pullRequestFiles = useMemo(() => pullRequestQuery.data?.pages.flatMap((page) => page.diff.files) ?? [], [pullRequestQuery.data]);
  const pullRequestDiff: ReviewSourceDiff | null = pullRequest
    ? { branch: `${pullRequest.baseRef} → ${pullRequest.headRef}`, revision: pullRequest.revision, files: pullRequestFiles }
    : null;

  const hasLocalReviewableChanges = (diff?.changedFiles ?? 0) > 0 || snapshots.some((snapshot) => snapshot.diff.changedFiles > 0);
  const hasChosenSource = useRef(false);
  useEffect(() => {
    // Open on a linked pull request only when the local checkout has nothing
    // to review. Decided once, so later local edits never yank the reviewer
    // out of a pull request they are working through.
    if (hasChosenSource.current || query.isLoading || snapshotsQuery.isLoading) return;
    hasChosenSource.current = true;
    if (!hasLocalReviewableChanges && availablePullRequests.length > 0) {
      setSelectedPullRequestUrl(availablePullRequests[0]);
      setReviewSource('pull-request');
    }
  }, [query.isLoading, snapshotsQuery.isLoading, hasLocalReviewableChanges, availablePullRequests]);
  useEffect(() => {
    // A clean checkout displays its latest immutable record. Keep the source
    // control truthful instead of making a history record look like live work.
    if (reviewSource === 'workspace' && diff?.changedFiles === 0 && snapshots.length > 0 && availablePullRequests.length === 0) {
      setReviewSource('history');
    }
  }, [reviewSource, diff?.changedFiles, snapshots.length, availablePullRequests.length]);

  const displayedDiff: ReviewSourceDiff | null | undefined = isPullRequestSource ? pullRequestDiff : selectedSnapshot?.diff ?? diff;
  const agentEditingWorkspace = activeWorkspacePaths
    ? activeWorkspacePaths.includes(diff?.workspacePath ?? '')
    : isRunning;
  const hasChanges = useWorkspaceDiffChanges(scope, diff?.revision, agentEditingWorkspace && !selectedSnapshot && !isPullRequestSource);
  const reviewRevision = displayedDiff?.files.length ? displayedDiff.revision : undefined;
  const hunkReviews = useDiffHunkReviews(scope, reviewRevision);
  const upsertHunkReview = useUpsertDiffHunkReview(scope, reviewRevision);
  const decisions = useMemo(() => buildReviewDecisions(displayedDiff?.files ?? [], hunkReviews.data?.reviews ?? []), [displayedDiff?.files, hunkReviews.data?.reviews]);
  const changeMap = useMemo(() => buildChangeMap(decisions), [decisions]);
  const orderedDecisions = useMemo(() => orderReviewDecisions(decisions), [decisions]);
  // Scores computed by the background pass that starts when an agent comes to
  // rest. Nothing here requests them; they stream in and populate whichever
  // decision panel the reviewer opens.
  const autoScores = useAutoReviewScores({ workItemId, conversationId }, reviewRevision);
  const selectedDecision = orderedDecisions.find((decision) => decision.id === selectedDecisionId) ?? orderedDecisions[0] ?? null;
  const selectedDecisionIndex = selectedDecision ? orderedDecisions.findIndex((decision) => decision.id === selectedDecision.id) : -1;
  const selectedFile = displayedDiff?.files.find((file) => file.path === selectedDecision?.filePaths[0]) ?? null;
  const fileHunks = useMemo(() => (selectedFile ? buildFileDiffHunks(selectedFile) : []), [selectedFile]);
  useEffect(() => {
    if (!displayedDiff?.revision || selectedDecisionId || !rememberedSelection) return;
    const rememberedDecisionId = rememberedSelection.decisions[displayedDiff.revision];
    if (rememberedDecisionId && orderedDecisions.some((decision) => decision.id === rememberedDecisionId)) setSelectedDecisionId(rememberedDecisionId);
  }, [displayedDiff?.revision, orderedDecisions, rememberedSelection, selectedDecisionId]);
  useEffect(() => {
    if (displayedDiff?.revision && selectedDecisionId) writeWorkspaceDiffDecision(preferenceScope, displayedDiff.revision, selectedDecisionId);
  }, [displayedDiff?.revision, preferenceScope, selectedDecisionId]);

  const recordDecisionState = (decision: ReviewDecision, state: DiffHunkReviewState) =>
    upsertHunkReview.mutateAsync({
      hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, hunkRange: hunk.hunkRange })),
      state,
    });

  const saveDecision = async (state: DiffHunkReviewState) => {
    if (!selectedDecision) return;
    const nextId = nextPendingDecisionId(orderedDecisions, selectedDecision.id);
    try {
      await recordDecisionState(selectedDecision, state);
      setSelectedDecisionId(nextId);
      if (isPhoneReview) setMobileDecisionDetailOpen(false);
    } catch {
      // The mutation exposes its stable request error beside the actions.
    }
  };

  const selectDecision = (decisionId: string) => {
    setSelectedDecisionId(decisionId);
    if (isPhoneReview) setMobileDecisionDetailOpen(false);
  };

  const moveDecision = (direction: -1 | 1) => {
    const next = orderedDecisions[selectedDecisionIndex + direction];
    if (next) selectDecision(next.id);
  };

  // Switching source resets the queue: decision ids belong to one diff.
  const selectSource = (value: string) => {
    if (!value) return;
    writeWorkspaceDiffSource(preferenceScope, value);
    setSelectedDecisionId(null);
    hasChosenSource.current = true;
    if (availablePullRequests.includes(value)) {
      setSelectedPullRequestUrl(value);
      setReviewSource('pull-request');
      return;
    }
    setSelectedPullRequestUrl(null);
    setReviewSource('workspace');
    if (value !== explorer.data?.selectedPath) selectWorkspace.mutate(value);
  };

  const selectWorkspaceSource = () => {
    setReviewSource('workspace');
    setSelectedPullRequestUrl(null);
    setSelectedSnapshotId('');
    if (explorer.data?.selectedPath) writeWorkspaceDiffSource(preferenceScope, explorer.data.selectedPath);
  };

  const selectHistorySource = () => {
    const snapshot = snapshots.find((entry) => entry.diff.changedFiles > 0) ?? snapshots[0];
    if (!snapshot) return;
    setReviewSource('history');
    setSelectedPullRequestUrl(null);
    setSelectedSnapshotId(snapshot.id);
    writeWorkspaceDiffSource(preferenceScope, `history:${snapshot.id}`);
  };

  const submitPullRequestUrl = (event: FormEvent) => {
    event.preventDefault();
    const url = pullRequestUrls([pullRequestUrlDraft.trim()])[0];
    if (!url) {
      setPullRequestUrlError('Paste a GitHub pull-request URL.');
      return;
    }
    setManualPullRequestUrl(url);
    setSelectedPullRequestUrl(url);
    setReviewSource('pull-request');
    setPullRequestUrlDraft('');
    setPullRequestUrlError(null);
    writeWorkspaceDiffSource(preferenceScope, url);
  };

  // Following up hands the decision to the agent, so it is recorded as
  // commented rather than left pending. Selection deliberately stays put: the
  // reviewer is about to type about this decision, not move past it. Attaching
  // still happens if the state write fails — the conversation is the point.
  const followUpOnDecision = async () => {
    if (!selectedDecision || !onFollowUp) return;
    const reference = reviewDecisionFollowUpReference(selectedDecision);
    if (selectedDecision.state === null) {
      try {
        await recordDecisionState(selectedDecision, 'commented');
      } catch {
        // The mutation exposes its stable request error beside the actions.
      }
    }
    onFollowUp(reference);
  };

  const workspaces = explorer.data?.workspaces ?? [];
  if (!isPullRequestSource) {
    if (query.isLoading) return <DiffSkeleton />;
    if (query.isError) return <section className="workspace-diff workspace-diff-error" aria-live="polite"><strong>Could not load local workspace changes.</strong><p>{query.error.message}</p><button type="button" className="button secondary compact" onClick={() => void query.refetch()} disabled={query.isFetching}>Retry</button></section>;
    // A pull request stays selectable even with no local checkout to fall back on.
    if (!diff && availablePullRequests.length === 0) return null;
  }

  const refreshSource = () => void (isPullRequestSource ? pullRequestQuery.refetch() : query.refetch());
  const isRefreshing = isPullRequestSource ? pullRequestQuery.isFetching : query.isFetching;

  return <section className="workspace-diff" aria-label={isPullRequestSource ? 'Pull request changes' : 'Current workspace changes'}>
    <header>
      {isPullRequestSource
        ? <div><span className="workspace-diff-eyebrow"><GitPullRequest size={14} /> {pullRequest ? `${pullRequest.repository} #${pullRequest.number}` : selectedPullRequestUrl ? pullRequestLabel(selectedPullRequestUrl) : 'GitHub pull request'}</span><h2>{pullRequest?.title ?? 'Review pull-request decisions'}</h2><small>{displayedDiff?.branch}</small><p>Review behavior decisions in priority order for this pull-request revision. Decisions are recorded against its head commit, so new commits return their hunks to review.</p>{selectedPullRequestUrl && <small className="workspace-diff-provenance"><a href={selectedPullRequestUrl} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={13} /></a></small>}</div>
        : <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> {selectedSnapshot ? 'Recorded version' : 'Workspace review'}</span><h2>{selectedSnapshot ? 'Workspace review record' : 'Review workspace decisions'}</h2>{selectedSnapshot ? <div className="workspace-diff-record-metadata"><small>{displayedDiff?.branch}</small><span>Captured {new Date(selectedSnapshot.capturedAt).toLocaleString()}. This record is preserved in the history.</span><small>{selectedSnapshot.originatingAgentRunId ? `Agent run ${selectedSnapshot.originatingAgentRunId}` : 'No originating agent run recorded'}{selectedSnapshot.commitHash ? ` · Commit ${selectedSnapshot.commitHash.slice(0, 12)}` : ' · No commit recorded'}</small></div> : <p>Review behavior decisions in priority order before publishing these workspace changes.</p>}</div>}
      <div className="workspace-diff-actions">
        <div className="workspace-review-source" role="group" aria-label="Review source">
          <button type="button" aria-pressed={reviewSource === 'workspace'} onClick={selectWorkspaceSource}><FileDiff size={13} />Workspace</button>
          <button type="button" aria-pressed={reviewSource === 'history'} onClick={selectHistorySource} disabled={snapshots.length === 0}><History size={13} />History</button>
          <button type="button" aria-pressed={reviewSource === 'pull-request'} onClick={() => { setReviewSource('pull-request'); setSelectedPullRequestUrl((current) => current ?? availablePullRequests[0] ?? null); }}><GitPullRequest size={13} />GitHub PR</button>
        </div>
        {reviewSource === 'workspace' && (conversationId || workItemId) && workspaces.length > 0 && <label className="workspace-repository-picker"><span>Workspace</span><select value={explorer.data?.selectedPath ?? ''} onChange={(event) => selectSource(event.target.value)} disabled={selectWorkspace.isPending}><option value="" disabled>Select workspace</option>{workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.label}</option>)}</select></label>}
        {reviewSource === 'history' && snapshots.length > 0 && <label className="workspace-diff-timeline"><History size={13} /><span className="visually-hidden">Workspace diff history</span><select value={selectedSnapshotId ?? selectedSnapshot?.id ?? ''} onChange={(event) => { setSelectedSnapshotId(event.target.value); setSelectedDecisionId(null); writeWorkspaceDiffSource(preferenceScope, `history:${event.target.value}`); }}><option value="">Latest recorded version</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.diff.changedFiles} files</option>)}</select></label>}
        {reviewSource === 'pull-request' && <div className="workspace-pr-source"><form onSubmit={submitPullRequestUrl}><label><span className="visually-hidden">Pull request URL</span><input aria-label="Pull request URL" value={pullRequestUrlDraft} onChange={(event) => setPullRequestUrlDraft(event.target.value)} placeholder="Paste GitHub PR URL" /></label><button type="submit">Review PR</button></form>{availablePullRequests.length > 0 && <label className="workspace-repository-picker"><span>PR</span><select aria-label="Pull request" value={selectedPullRequestUrl ?? ''} onChange={(event) => selectSource(event.target.value)}><option value="" disabled>Select pull request</option>{availablePullRequests.map((url) => <option key={url} value={url}>{pullRequestLabel(url)}</option>)}</select></label>}{pullRequestUrlError && <small role="alert">{pullRequestUrlError}</small>}</div>}
        <button className={`workspace-diff-refresh${hasChanges ? ' workspace-diff-refresh-pending' : ''}`} type="button" onClick={refreshSource} disabled={isRefreshing}><RefreshCw size={13} className={isRefreshing ? 'spin' : ''} /> {hasChanges ? 'Refresh changes' : 'Refresh'}</button>
      </div>
    </header>
    {isPullRequestSource && pullRequestQuery.isLoading ? <DiffSkeleton />
      : isPullRequestSource && pullRequestQuery.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not load this pull-request diff.</strong><p>{pullRequestQuery.error.message}</p><button type="button" className="button secondary compact" onClick={() => void pullRequestQuery.refetch()} disabled={pullRequestQuery.isFetching}>Retry</button></section>
        : !displayedDiff || displayedDiff.files.length === 0 ? <p className="muted">{isPullRequestSource ? selectedPullRequestUrl ? 'GitHub reports no changed files for this pull request.' : 'Paste a GitHub pull-request URL or choose one from this conversation.' : 'No uncommitted changes to review.'}</p>
          : hunkReviews.isLoading ? <DiffSkeleton />
            : hunkReviews.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not load review decisions.</strong><p>{hunkReviews.error.message}</p><button type="button" className="button secondary compact" onClick={() => void hunkReviews.refetch()} disabled={hunkReviews.isFetching}>Retry</button></section>
              : <div className="workspace-diff-layout diff-review-layout">
                <DiffReviewSummaryView decisions={decisions} />
                <DiffReviewChangeMap map={changeMap} selectedId={selectedDecision?.id ?? null} onSelect={selectDecision} />
                {autoScores.running && <p className="muted" role="status">Scoring changes in the background — {autoScores.completed} of {autoScores.total} decisions.</p>}
                {!autoScores.running && autoScores.skipped > 0 && <p className="muted">{autoScores.skipped} decisions past the background scoring limit were not scored automatically; use Score risk on those.</p>}
                {selectedDecision && <>
                  <div className="mobile-decision-navigator" aria-label="Decision navigation">
                    <button type="button" onClick={() => moveDecision(-1)} disabled={selectedDecisionIndex <= 0} aria-label="Previous decision"><ChevronLeft size={18} aria-hidden="true" /></button>
                    <span>Decision {selectedDecision.ordinal} of {orderedDecisions.length}<em className={`diff-review-decision-state state-${selectedDecision.state ?? 'pending'}`}>{reviewStateShortLabel(selectedDecision.state)}</em></span>
                    <button type="button" onClick={() => moveDecision(1)} disabled={selectedDecisionIndex >= orderedDecisions.length - 1} aria-label="Next decision"><ChevronRight size={18} aria-hidden="true" /></button>
                    <button type="button" className="mobile-decision-detail-toggle" onClick={() => setMobileDecisionDetailOpen(true)} aria-expanded={mobileDecisionDetailOpen} aria-controls="mobile-decision-detail">View decision</button>
                  </div>
                  <DiffReviewDecisionQueue decisions={orderedDecisions} selectedId={selectedDecision.id} onSelect={selectDecision} />
                  {isPullRequestSource && pullRequestQuery.hasNextPage && <button type="button" className="github-diff-load-more" onClick={() => void pullRequestQuery.fetchNextPage()} disabled={pullRequestQuery.isFetchingNextPage} aria-busy={pullRequestQuery.isFetchingNextPage}>{pullRequestQuery.isFetchingNextPage ? 'Loading more files…' : 'Load 100 more files'}</button>}
                  <div className="diff-review-workbench">
                    {selectedFile && <DiffReviewFileDiffPane filePath={selectedFile.path} editorUrl={selectedFile.editorUrl ?? null} hunks={fileHunks} decisions={decisions} activeDecisionId={selectedDecision.id} onSelect={selectDecision} />}
                    {!isPhoneReview && <div id="mobile-decision-detail"><DiffReviewDecisionDetailCard key={selectedDecision.id} decision={selectedDecision} taskIntent={taskIntent} autoScore={autoScores.results.get(selectedDecision.id)}>
                      <DiffReviewActions key={selectedDecision.id} saving={upsertHunkReview.isPending} error={upsertHunkReview.isError ? upsertHunkReview.error.message : null} onSave={(state) => void saveDecision(state)} onFollowUp={onFollowUp ? () => void followUpOnDecision() : undefined} />
                    </DiffReviewDecisionDetailCard></div>}
                  </div>
                  {isPhoneReview && mobileDecisionDetailOpen && <ModalDialog className="decision-detail-dialog" labelledBy="mobile-decision-detail-title" onClose={() => setMobileDecisionDetailOpen(false)}>
                    <div className="decision-detail-dialog-header">
                      <span id="mobile-decision-detail-title">Decision details</span>
                      <button type="button" onClick={() => setMobileDecisionDetailOpen(false)} aria-label="Close decision details"><X size={18} /></button>
                    </div>
                    <div id="mobile-decision-detail"><DiffReviewDecisionDetailCard key={selectedDecision.id} decision={selectedDecision} taskIntent={taskIntent} autoScore={autoScores.results.get(selectedDecision.id)}>
                      <DiffReviewActions key={selectedDecision.id} saving={upsertHunkReview.isPending} error={upsertHunkReview.isError ? upsertHunkReview.error.message : null} onSave={(state) => void saveDecision(state)} onFollowUp={onFollowUp ? () => void followUpOnDecision() : undefined} />
                    </DiffReviewDecisionDetailCard></div>
                  </ModalDialog>}
                </>}
              </div>}
  </section>;
});
