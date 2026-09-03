import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ClipboardCheck, ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, GitPullRequest, History, RefreshCw, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalDialog } from '../../components/dialogs/modal-dialog.js';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton.js';
import type { AgentRunReviewHandoff, DiffHunkReviewState, WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildChangeMap } from '../../../shared/change-map.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { conversationClient } from '../../data/conversation-client.js';
import { sourceClient } from '../../data/source-client.js';
import type { ReviewAssistTaskIntent } from '../diff-review/decision-detail-card.js';
import { DiffReviewDecisionDetailCard } from '../diff-review/decision-detail-card.js';
import { DecisionPopover, type DecisionPopoverAnchor } from '../diff-review/decision-popover.js';
import { DecisionRelationshipDiagram } from '../diff-review/decision-relationship-diagram.js';
import { DiffReviewDecisionQueue } from '../diff-review/decision-queue.js';
import { DiffReviewFileDiffPane } from '../diff-review/file-diff-pane.js';
import type { ReviewDecision } from '../diff-review/logic.js';
import { aiRiskBand, buildFileDiffHunks, buildReviewDecisions, fixRequestPrompt, nextPendingDecisionId, orderReviewDecisions, parseAiRiskScore, reviewStateLabel } from '../diff-review/logic.js';
import { useAutoReviewScores } from '../diff-review/auto-score.js';
import { DiffReviewActions } from '../diff-review/review-actions.js';
import { DiffReviewSummaryView } from '../diff-review/summary-view.js';
import { DiffReviewChangeMap } from '../diff-review/change-map.js';
import { AgentRunReviewHandoffCard } from '../diff-review/review-handoff-card.js';
import { useGitHubPullRequestDiff, useGitHubPullRequestFile } from '../github-diff/hooks.js';
import { pullRequestLabel, pullRequestUrls } from '../github-diff/logic.js';
import { useDiffHunkReviews, useUpsertDiffHunkReview, useWorkspaceCommitDiff, useWorkspaceDiff, useWorkspaceDiffChanges, useWorkspaceDiffSnapshots, useWorkspaceFileSource, useWorkspaceRefCommits, useWorkspaceRefDiff, useWorkspaceRefs, workspaceExplorerQueryKey } from './hooks.js';
import { workspaceDiffScopeKeys } from './data.js';
// Tier routing and the delegated sweep, reached across to the review stack.
// These four are pure policy over a `ReviewDecision` — no block splitting, no
// block rows, none of the machinery that is deliberately kept out of Changes.
// What a change costs to answer is one decision, and it should not be made
// twice with two sets of rules just because two tabs ask it.
import { blockObligations } from '../review-stack/review-obligations.js';
import { REVIEW_TIER_LABELS, routeReviewBlock } from '../review-stack/review-routing.js';
import { isDelegatedTier, type DelegationTarget } from '../review-stack/review-delegation.js';
import { useDelegatedReview } from '../review-stack/use-delegated-review.js';
import { fileSourceRevision } from '../review-stack/review-full-file.js';
import { ReviewFullFilePane } from '../review-stack/review-full-file-pane.js';
import { readReviewStackReadingMode, readWorkspaceDiffSelection, writeReviewStackReadingMode, writeWorkspaceDiffDecision, writeWorkspaceDiffSource, type ReviewStackReadingMode } from '../../lib/preferences.js';
import { useWorkspaceDiffKeyboardNavigation } from './use-keyboard-navigation.js';
import { WorkspaceContextSwitcher } from './context-switcher.js';
import { AiProviderSelect } from '../../components/ai-provider-select.js';
import { useAiProvider } from '../../hooks/ai-provider.js';

/** The parts of a diff this review surface reads, whichever source produced
 * it. A local workspace diff satisfies it directly; a pull request is adapted
 * onto it so both are reviewed through one decision queue. */
interface ReviewSourceDiff {
  branch: string;
  revision: string;
  files: WorkspaceDiffFile[];
}

type ReviewSourceKind = 'workspace' | 'history' | 'pull-request' | 'repository' | 'branch';

/** One tooltip for the one key that cycles all three readings, so the button
 * never claims a two-way toggle. */
const READING_MODE_TITLE = 'Cycle the reading: unified diff, final code, whole file (d)';

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

/**
 * b13bf425-4047-4b22-b7c3-85317d6819fe LEGACY-AFFECTING: Changes now exposes
 * the same full diff size line and linear keyboard review flow as Review.
 * The new controls delegate to Changes' existing selection and hunk-review
 * mutation so its source handling, persistence, and auto-advance stay intact.
 */
export const WorkspaceDiffView = memo(function WorkspaceDiffView({ scope, isRunning = false, activeWorkspacePaths, reviewHandoff, taskIntent = null, pullRequestUrlCandidates, onFixRequest }: {
  scope: WorkspaceDiffScope;
  isRunning?: boolean;
  activeWorkspacePaths?: string[];
  reviewHandoff?: AgentRunReviewHandoff | null;
  taskIntent?: ReviewAssistTaskIntent;
  /** Any URLs that may be pull requests. Recognised ones join the repository
   * picker as review sources beside the local checkouts. */
  pullRequestUrlCandidates?: string[];
  /** Where a Fix goes. A surface with a composer supplies this and receives the
   * change as message text; one without simply does not offer the button. */
  onFixRequest?: (prompt: string) => void;
}) {
  const queryClient = useQueryClient();
  const conversationId = 'conversationId' in scope ? scope.conversationId : null;
  const workItemId = 'workItemId' in scope ? scope.workItemId : null;
  const preferenceScope = conversationId ? `conversation:${conversationId}` : `work-item:${workItemId}`;
  const rememberedSelection = useMemo(() => readWorkspaceDiffSelection(preferenceScope), [preferenceScope]);
  // The same key the diff hooks resolve the selected repository through, so
  // one explorer read serves the whole panel.
  const explorerKey = workspaceExplorerQueryKey(scope);
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
      // Every diff, history and file entry is keyed by the selected repository,
      // so the panel asks a different question the moment the selection lands.
      // The entries under the previous key are still dropped rather than left
      // to age out: the server switched repository the instant it answered this
      // mutation, so anything that refetched while the explorer read was still
      // in flight was stored under the old repository's key holding the new
      // repository's answer. Keeping it means the next visit to that checkout
      // opens on another repository's diff.
      for (const key of workspaceDiffScopeKeys(scope)) queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: explorerKey });
    },
  });
  const query = useWorkspaceDiff(scope);
  const snapshotsQuery = useWorkspaceDiffSnapshots(scope, query.data?.diff?.revision);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  // React bails out of a state update that sets the same id, so re-picking the
  // decision already shown would render nothing and the diff would stay where
  // the reviewer had scrolled it. Counting selections gives the diff pane a
  // signal for every click, not only the ones that change the decision.
  const [selectionTick, setSelectionTick] = useState(0);
  // The change the reviewer moved away from on the last selection, so the
  // diagram beside the panel can mark the way back.
  const [cameFromDecisionId, setCameFromDecisionId] = useState<string | null>(null);
  // The desktop decision detail is popover content opened from a block's gutter
  // marker, so the open state has to carry the marker that opened it: the
  // popover positions itself off that element's rect.
  const [detailAnchor, setDetailAnchor] = useState<{ decisionId: string; anchor: DecisionPopoverAnchor; anchorAttribute: string } | null>(null);
  const [isHandoffOpen, setIsHandoffOpen] = useState(false);
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
  // The repo browser has one control: which commit is being read. A commit is
  // always shown against the one before it, so there is no comparison base to
  // pick and no second selector to keep in sync.
  const [selectedCommitSha, setSelectedCommitSha] = useState('');
  const isRepositorySource = reviewSource === 'repository';
  const commitsQuery = useWorkspaceRefCommits(isRepositorySource ? scope : null, null);
  const commits = commitsQuery.data?.commits ?? [];
  const selectedCommit = commits.find((commit) => commit.sha === selectedCommitSha) ?? null;
  // The commit diff answers with the same WorkspaceDiff the working tree does,
  // so it feeds the one decision queue rather than a second review surface.
  const repositoryQuery = useWorkspaceCommitDiff(isRepositorySource && selectedCommitSha ? scope : null, selectedCommitSha || null);
  const repositoryDiff = isRepositorySource ? repositoryQuery.data?.diff ?? null : null;
  // Opening the browser lands on the newest commit, because that is the change
  // the reviewer is already thinking about.
  const latestCommitSha = commits[0]?.sha ?? '';
  useEffect(() => {
    if (!isRepositorySource || selectedCommitSha || !latestCommitSha) return;
    setSelectedCommitSha(latestCommitSha);
  }, [isRepositorySource, latestCommitSha, selectedCommitSha]);
  // Work already committed on a branch is invisible to the working-tree source:
  // `git diff HEAD` is empty there. That is the ordinary shape of a change split
  // across two repositories - one still dirty, the other already committed - so
  // switching to the second repository used to land on "no uncommitted changes"
  // with no way forward. The branch review answers with the same WorkspaceDiff,
  // so it feeds the one decision queue rather than a second review surface.
  const [selectedBranchName, setSelectedBranchName] = useState('');
  const isBranchSource = reviewSource === 'branch';
  // Branches are read either because the reviewer asked for them, or because
  // this checkout is clean and therefore has nothing else to offer. A dirty
  // checkout never pays for the ref walk.
  const workspaceIsClean = !query.isPending && (query.data?.diff?.changedFiles ?? 0) === 0;
  const refsQuery = useWorkspaceRefs(isBranchSource || workspaceIsClean ? scope : null);
  const branches = refsQuery.data?.refs?.branches ?? [];
  const baseBranch = refsQuery.data?.refs?.base ?? null;
  const branchQuery = useWorkspaceRefDiff(isBranchSource && selectedBranchName ? scope : null, selectedBranchName ? `branch:${selectedBranchName}` : null);
  const branchDiff = isBranchSource ? branchQuery.data?.diff ?? null : null;
  useEffect(() => {
    // Drop a selection whose pull request is no longer referenced here.
    setSelectedPullRequestUrl((current) => current && availablePullRequests.includes(current) ? current : null);
  }, [availablePullRequests]);
  useEffect(() => {
    if (rememberedSelection?.source === 'repository') setReviewSource('repository');
    if (rememberedSelection?.source === 'branch') setReviewSource('branch');
  }, [rememberedSelection?.source]);
  useEffect(() => {
    if (rememberedSelection && availablePullRequests.includes(rememberedSelection.source)) {
      setSelectedPullRequestUrl(rememberedSelection.source);
      setReviewSource('pull-request');
    }
  }, [availablePullRequests, rememberedSelection]);
  // Local preferences may restore presentation-only sources such as a PR or
  // recorded revision. A repository selection is shared server state and is
  // restored by the explorer response itself. Never replay a local repository
  // preference through the mutation here: an active run can authoritatively
  // select its worktree, making the server return a different path; mutation
  // invalidation would then rerun this render effect forever.
  useEffect(() => {
    if (!rememberedSelection?.source.startsWith('history:')) return;
    const snapshotId = rememberedSelection.source.slice('history:'.length);
    if (snapshots.some((snapshot) => snapshot.id === snapshotId)) {
      setSelectedSnapshotId(snapshotId);
      setReviewSource('history');
    }
  }, [rememberedSelection?.source, snapshots]);
  useEffect(() => {
    // Records belong to the repository they were captured in, so the picker
    // changes which ones exist. A record from the previous repository is not
    // in this one's history: drop the stale choice instead of leaving History
    // selected over a repository that has no records to show.
    if (snapshotsQuery.isPending) return;
    if (selectedSnapshotId && !snapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) setSelectedSnapshotId(null);
    if (reviewSource === 'history' && snapshots.length === 0) setReviewSource('workspace');
  }, [snapshots, selectedSnapshotId, reviewSource, snapshotsQuery.isPending]);
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
    // The opening source is decided once, from the first loaded response.
    // Later edits - and any repository the reviewer picks themselves - must
    // never yank the source control back, which would unmount the repository
    // picker and make the Workspace button unclickable.
    // `isPending`, not `isLoading`: both requests wait for Repo Explorer's
    // selection, and a waiting request is not a loading one. Reading it as
    // loaded would decide the opening source from an empty timeline.
    if (hasChosenSource.current || query.isPending || snapshotsQuery.isPending) return;
    hasChosenSource.current = true;
    // Open on a linked pull request only when the local checkout has nothing
    // to review, so a reviewer working through a PR is never pulled out of it.
    if (!hasLocalReviewableChanges && availablePullRequests.length > 0) {
      setSelectedPullRequestUrl(availablePullRequests[0]);
      setReviewSource('pull-request');
      return;
    }
    // A clean checkout opens on its latest immutable record. Keep the source
    // control truthful instead of making a history record look like live work.
    if (reviewSource === 'workspace' && diff?.changedFiles === 0 && snapshots.length > 0) setReviewSource('history');
  }, [query.isPending, snapshotsQuery.isPending, hasLocalReviewableChanges, availablePullRequests, reviewSource, diff?.changedFiles, snapshots.length]);
  // The repository picker's whole job is to reach the other half of a change.
  // A checkout whose work is committed has no working-tree diff and no records
  // captured here, so landing on Workspace showed an empty pane and looked
  // broken. Open its branch instead - once per repository, so a reviewer who
  // deliberately goes back to Workspace is not dragged out of it again.
  const autoBranchedForPath = useRef<string | null>(null);
  useEffect(() => {
    const path = explorer.data?.selectedPath ?? null;
    if (!path || autoBranchedForPath.current === path) return;
    if (reviewSource !== 'workspace' || query.isPending || snapshotsQuery.isPending || !refsQuery.data?.refs) return;
    if ((diff?.changedFiles ?? 0) > 0 || snapshots.length > 0) return;
    const current = refsQuery.data.refs.branches.find((branch) => branch.current);
    if (!current || current.ahead === 0) return;
    autoBranchedForPath.current = path;
    setSelectedBranchName(current.name);
    setReviewSource('branch');
  }, [explorer.data?.selectedPath, reviewSource, query.isPending, snapshotsQuery.isPending, refsQuery.data, diff?.changedFiles, snapshots.length]);
  // The branch shown defaults to the one this checkout actually has out: it is
  // the branch the reviewer switched repository to see.
  const currentBranchName = (branches.find((branch) => branch.current) ?? branches[0])?.name ?? '';
  useEffect(() => {
    if (!isBranchSource || selectedBranchName || !currentBranchName) return;
    setSelectedBranchName(currentBranchName);
  }, [isBranchSource, currentBranchName, selectedBranchName]);

  const displayedDiff: ReviewSourceDiff | null | undefined = isPullRequestSource ? pullRequestDiff
    : isRepositorySource ? repositoryDiff
      : isBranchSource ? branchDiff
        : selectedSnapshot?.diff ?? diff;
  const agentEditingWorkspace = activeWorkspacePaths
    ? activeWorkspacePaths.includes(diff?.workspacePath ?? '')
    : isRunning;
  const hasChanges = useWorkspaceDiffChanges(scope, diff?.revision, agentEditingWorkspace && !selectedSnapshot && !isPullRequestSource && !isRepositorySource && !isBranchSource);
  const reviewRevision = displayedDiff?.files.length ? displayedDiff.revision : undefined;
  const hunkReviews = useDiffHunkReviews(scope, reviewRevision);
  const upsertHunkReview = useUpsertDiffHunkReview(scope, reviewRevision);
  const decisions = useMemo(() => buildReviewDecisions(displayedDiff?.files ?? [], hunkReviews.data?.reviews ?? []), [displayedDiff?.files, hunkReviews.data?.reviews]);
  const changeMap = useMemo(() => buildChangeMap(decisions), [decisions]);
  const orderedDecisions = useMemo(() => orderReviewDecisions(decisions, changeMap), [decisions, changeMap]);
  // What a model answers instead of Jeffrey. Changes has no logic-block
  // analysis to feed routing, so the tier is read from the change type and its
  // risk signals alone; a decision already carrying a verdict is never
  // delegated, so nothing is re-bought after it is answered.
  const reviewIsTestOnly = useMemo(() => decisions.length > 0 && decisions.every((decision) => decision.changeType === 'test_only'), [decisions]);
  // The tier each decision is priced at — and the key its assist answers are
  // bought and read back under. The detail card has to be handed the same one
  // the delegated turn spent, or the answer already paid for sits in the cache
  // under a key nothing ever reads and the panel opens empty.
  // Routing is kept whole rather than reduced to the tier on the way in: the
  // dimming and the progress line both need to know a change was settled by
  // proof, which is exactly the part a tier-only map throws away.
  const decisionRouting = useMemo(() => new Map(decisions.map((decision) =>
    [decision.id, routeReviewBlock(decision, blockObligations(decision), null, { reviewIsTestOnly })] as const)), [decisions, reviewIsTestOnly]);
  const decisionTiers = useMemo(() => new Map([...decisionRouting].map(([decisionId, routing]) => [decisionId, routing.tier] as const)), [decisionRouting]);
  // Changes the reviewer is done with, and the one word that says why: a
  // recorded verdict, or T0 routing settling it by proof. A delegated tier is
  // not a third way — a change priced "delegated" is still owed until its turn
  // actually answers. Named changes collapse to their header, so reading time
  // is spent on what is still open.
  const handledDecisions = useMemo(() => new Map(decisions.flatMap((decision) => {
    if (decision.state !== null) return [[decision.id, reviewStateLabel(decision.state)] as const];
    return decisionRouting.get(decision.id)?.tier === 'T0' ? [[decision.id, REVIEW_TIER_LABELS.T0] as const] : [];
  })), [decisionRouting, decisions]);
  const reviewProgress = useMemo(() => {
    let settled = 0;
    let judged = 0;
    let remaining = 0;
    for (const decision of decisions) {
      const autoSettled = decisionRouting.get(decision.id)?.autoSettled ?? false;
      if (autoSettled) settled += 1;
      if (decision.state !== null) judged += 1;
      else if (!autoSettled) remaining += 1;
    }
    return { total: decisions.length, settled, judged, remaining };
  }, [decisionRouting, decisions]);
  const delegationTargets = useMemo((): DelegationTarget[] => decisions.flatMap((decision) => {
    const tier = decisionTiers.get(decision.id);
    return decision.state === null && tier && isDelegatedTier(tier) ? [{ decisionId: decision.id, decision, tier }] : [];
  }), [decisions, decisionTiers]);
  // Scores computed by the background pass that starts when an agent comes to
  // rest. Nothing here requests them; they stream in and populate whichever
  // decision panel the reviewer opens.
  const autoScores = useAutoReviewScores({ workItemId, conversationId }, reviewRevision);
  // The only review check that reads outside the patch, so the only one that
  // needs the server. Keyed on the revision because its answer is invalidated
  // by any edit to the working tree, and disabled outside work-item scope
  // where the endpoint does not apply — the panel treats it as optional.
  const staleReferences = useQuery({
    queryKey: ['stale-references', workItemId, reviewRevision],
    queryFn: () => sourceClient.getStaleReferences(workItemId!),
    enabled: Boolean(workItemId) && reviewSource === 'workspace',
    staleTime: 60_000,
  });
  const selectedDecision = orderedDecisions.find((decision) => decision.id === selectedDecisionId) ?? orderedDecisions[0] ?? null;
  // A decision groups hunks by subject, and a subject routinely spans several
  // files. Resolving only `filePaths[0]` rendered one file and silently hid the
  // rest of the same decision, so the header could read "1 decision across 4
  // files" above a single file's diff. Every file the decision touches is shown.
  const selectedFiles = useMemo(
    () => (selectedDecision?.filePaths ?? []).map((path) => displayedDiff?.files.find((file) => file.path === path)).filter((file): file is WorkspaceDiffFile => Boolean(file)),
    [displayedDiff?.files, selectedDecision?.filePaths],
  );
  const selectedFile = selectedFiles[0] ?? null;
  // The full size of the diff under review, always shown: how many files, how
  // many lines added, how many removed. It reports the numbers and leaves the
  // judgment of when to stop reading to the reviewer.
  const diffStat = useMemo(() => (displayedDiff?.files ?? []).reduce((total, file) => ({ files: total.files + 1, additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { files: 0, additions: 0, deletions: 0 }), [displayedDiff?.files]);
  const changedFilePaths = useMemo(() => displayedDiff?.files.map((file) => file.path) ?? [], [displayedDiff?.files]);
  // The same AI score the detail panel shows, reduced to a band for the gutter
  // dot, so severity is readable straight off the diff instead of only after
  // opening each decision.
  const riskBands = useMemo(() => {
    const bands = new Map<string, string>();
    for (const [decisionId, result] of autoScores.results) {
      const parsed = parseAiRiskScore(result.answer);
      if (parsed) bands.set(decisionId, aiRiskBand(parsed.score));
    }
    return bands;
  }, [autoScores.results]);
  // GitHub review comments are keyed by file path; a decision can span several
  // files, so its badge sums whichever of those paths carry loaded comments.
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!pullRequest?.comments?.available) return counts;
    for (const decision of orderedDecisions) {
      const total = decision.filePaths.reduce((sum, path) => sum + (pullRequest.comments.byPath[path] ?? 0), 0);
      if (total > 0) counts.set(decision.id, total);
    }
    return counts;
  }, [orderedDecisions, pullRequest?.comments]);
  // The popover follows the marker that opened it rather than the selection.
  // They are normally the same decision, but a refetch can reconcile the
  // selection onto a different one — and gating the panel on that equality
  // turned the marker into a dead click. Resolving by the anchored id keeps it
  // open, falling back to the selected decision so it always has content.
  const popoverDecision = detailAnchor
    ? orderedDecisions.find((decision) => decision.id === detailAnchor.decisionId) ?? selectedDecision
    : null;
  const fileHunkGroups = useMemo(() => selectedFiles.map((file) => ({ file, hunks: buildFileDiffHunks(file) })), [selectedFiles]);
  const fileHunks = fileHunkGroups[0]?.hunks ?? [];
  useEffect(() => {
    if (!displayedDiff?.revision || selectedDecisionId || !rememberedSelection) return;
    const rememberedDecisionId = rememberedSelection.decisions[displayedDiff.revision];
    if (rememberedDecisionId && orderedDecisions.some((decision) => decision.id === rememberedDecisionId)) setSelectedDecisionId(rememberedDecisionId);
  }, [displayedDiff?.revision, orderedDecisions, rememberedSelection, selectedDecisionId]);
  useEffect(() => {
    if (displayedDiff?.revision && selectedDecisionId) writeWorkspaceDiffDecision(preferenceScope, displayedDiff.revision, selectedDecisionId);
  }, [displayedDiff?.revision, preferenceScope, selectedDecisionId]);

  // Three readings of the same change, widening each time: the unified diff,
  // the finished code, then the whole file the change sits in. One key cycles
  // them because they answer the same question at different magnifications.
  // Changes keeps the unified diff as its default; the reviewer's own last
  // choice outranks it and survives remounting and reloading.
  const [readingMode, setReadingMode] = useState<ReviewStackReadingMode>(() => readReviewStackReadingMode() ?? 'diff');
  const toggleReadingMode = useCallback(() => {
    const order: ReviewStackReadingMode[] = ['diff', 'final', 'file'];
    const next = order[(order.indexOf(readingMode) + 1) % order.length]!;
    setReadingMode(next);
    writeReviewStackReadingMode(next);
  }, [readingMode]);
  // PR after-state is fetched from GitHub at its resolved head SHA. This must
  // not fall back to the local checkout: it may hold unrelated text at the
  // same path. Binary files stay in the diff-only reader.
  const wholeFileReadable = !selectedFile?.isBinary;
  const workspaceFileSourceQuery = useWorkspaceFileSource(
    scope,
    selectedFile?.path ?? null,
    fileSourceRevision(displayedDiff?.revision),
    readingMode === 'file' && wholeFileReadable && !isPullRequestSource,
  );
  const githubFileSourceQuery = useGitHubPullRequestFile(
    selectedPullRequestUrl,
    selectedFile?.path ?? null,
    displayedDiff?.revision ?? null,
    readingMode === 'file' && wholeFileReadable && isPullRequestSource,
  );
  const fileSourceQuery = isPullRequestSource ? githubFileSourceQuery : workspaceFileSourceQuery;

  const recordDecisionState = useCallback((decision: ReviewDecision, state: DiffHunkReviewState) =>
    upsertHunkReview.mutateAsync({
      hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, hunkRange: hunk.hunkRange, contentHash: hunk.contentHash })),
      state,
    }), [upsertHunkReview]);

  // The same delegation Review runs, against the hunk decisions Changes owns.
  // A confident T1 answer records the reviewed verdict through the identical
  // writer the buttons use, so it persists, reconciles, and can be reopened
  // exactly like one Jeffrey gave. T2 is delegated but never auto-reviewed:
  // routing priced it as a judgment call, and buying the answer early only
  // means it is already waiting when the decision is opened.
  // This pane spends three kinds of AI turn — block scoring, the background
  // auto-score, and the delegated sweep — and until now offered no way to say
  // which model buys them. The selector writes the shared browser-local
  // choice, which `useDiffBlockConfidence` reads directly and the delegated
  // sweep reads at dispatch time.
  const { provider: aiProvider, setProvider: setAiProvider } = useAiProvider();
  const delegation = useDelegatedReview({
    targets: delegationTargets,
    siblings: decisions,
    taskIntent: taskIntent ?? null,
    revision: reviewRevision,
    enabled: Boolean(reviewRevision),
    onAutoReview: (target) => {
      // The mutation surfaces its own error state; a rejected auto-verdict
      // leaves the decision owed rather than tearing down the pane.
      void recordDecisionState(target.decision, 'reviewed').catch(() => {});
    },
  });

  const saveDecision = useCallback(async (decision: ReviewDecision, state: DiffHunkReviewState) => {
    const nextId = nextPendingDecisionId(orderedDecisions, decision.id, changeMap);
    try {
      await recordDecisionState(decision, state);
      if (nextId !== decision.id) setCameFromDecisionId(decision.id);
      setSelectedDecisionId(nextId);
      setDetailAnchor(null);
    } catch {
      // The mutation exposes its stable request error beside the actions.
    }
  }, [changeMap, orderedDecisions, recordDecisionState]);

  // Moving on without answering. The decision keeps its pending state, so the
  // queue, the counts and the map all still owe it — the only thing that
  // changes is which change the reviewer is reading.
  const skipDecision = useCallback((decision: ReviewDecision) => {
    const nextId = nextPendingDecisionId(orderedDecisions, decision.id, changeMap);
    setDetailAnchor(null);
    if (!nextId || nextId === decision.id) return;
    setCameFromDecisionId(decision.id);
    setSelectedDecisionId(nextId);
    setSelectionTick((tick) => tick + 1);
  }, [changeMap, orderedDecisions]);

  // Handing the change back to the agent. The verdict is deliberately not
  // recorded: what happens to this change depends on the answer, and the
  // reviewer reads it in the conversation before deciding.
  const requestFix = useCallback((decision: ReviewDecision) => {
    onFixRequest?.(fixRequestPrompt(decision));
    setDetailAnchor(null);
  }, [onFixRequest]);

  const openDecisionDetail = (decisionId: string, anchor: DecisionPopoverAnchor, anchorAttribute = 'data-decision-marker') => {
    setDetailAnchor((current) => (current?.decisionId === decisionId ? null : { decisionId, anchor, anchorAttribute }));
  };

  const selectDecision = useCallback((decisionId: string) => {
    if (selectedDecisionId && selectedDecisionId !== decisionId) setCameFromDecisionId(selectedDecisionId);
    setSelectedDecisionId(decisionId);
    // Selecting elsewhere closes an open popover, but the marker selects its own
    // decision before it opens, so keep the anchor when the id is unchanged —
    // otherwise the marker would clear and immediately reopen, never toggling.
    setDetailAnchor((current) => (current && current.decisionId === decisionId ? current : null));
    setSelectionTick((tick) => tick + 1);
  }, [selectedDecisionId]);

  const markSelectedReviewed = useCallback(() => {
    if (selectedDecision) void saveDecision(selectedDecision, 'reviewed');
  }, [saveDecision, selectedDecision]);
  // b13bf425-4047-4b22-b7c3-85317d6819fe LEGACY-AFFECTING: Shortcuts call
  // the same selection and verdict paths as the existing Changes controls.
  useWorkspaceDiffKeyboardNavigation({
    decisions: orderedDecisions,
    filePaths: changedFilePaths,
    activeId: selectedDecision?.id ?? null,
    activeFilePath: selectedFile?.path ?? null,
    canMarkReviewed: Boolean(selectedDecision && reviewRevision && !upsertHunkReview.isPending),
    onSelect: selectDecision,
    onMarkReviewed: markSelectedReviewed,
    onToggleReadingMode: toggleReadingMode,
  });

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
    // Picking a repository means reading that repository's live changes, not
    // whichever recorded version the previous checkout fell back to - and not
    // a commit that only exists in the repository being left.
    setSelectedSnapshotId('');
    setSelectedCommitSha('');
    setSelectedBranchName('');
    if (value !== explorer.data?.selectedPath) selectWorkspace.mutate(value);
  };

  const selectWorkspaceContext = async (value: string) => {
    if (!value) return;
    writeWorkspaceDiffSource(preferenceScope, value);
    setSelectedDecisionId(null);
    hasChosenSource.current = true;
    setSelectedPullRequestUrl(null);
    setReviewSource('workspace');
    setSelectedSnapshotId('');
    setSelectedCommitSha('');
    setSelectedBranchName('');
    if (value !== explorer.data?.selectedPath) await selectWorkspace.mutateAsync(value);
  };

  const selectRepositorySource = () => {
    hasChosenSource.current = true;
    setReviewSource('repository');
    setSelectedPullRequestUrl(null);
    setSelectedSnapshotId('');
    setSelectedDecisionId(null);
    writeWorkspaceDiffSource(preferenceScope, 'repository');
  };

  const selectBranchSource = () => {
    hasChosenSource.current = true;
    setReviewSource('branch');
    setSelectedPullRequestUrl(null);
    setSelectedSnapshotId('');
    setSelectedDecisionId(null);
    writeWorkspaceDiffSource(preferenceScope, 'branch');
  };

  const selectWorkspaceSource = () => {
    hasChosenSource.current = true;
    autoBranchedForPath.current = explorer.data?.selectedPath ?? null;
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

  const workspaces = explorer.data?.workspaces ?? [];
  // The repo browser reads committed history, so it stays usable while the
  // working tree is still being read and on a checkout with nothing to review.
  if (!isPullRequestSource && !isRepositorySource && !isBranchSource) {
    if (query.isPending) return <DiffSkeleton />;
    if (query.isError) return <section className="workspace-diff workspace-diff-error" aria-live="polite"><strong>Could not load local workspace changes.</strong><p>{query.error.message}</p><button type="button" className="button secondary compact" onClick={() => void query.refetch()} disabled={query.isFetching}>Retry</button></section>;
    // A pull request stays selectable even with no local checkout to fall back on.
    if (!diff && availablePullRequests.length === 0) return null;
  }

  const refreshSource = () => void (isPullRequestSource ? pullRequestQuery.refetch() : isRepositorySource ? Promise.all([commitsQuery.refetch(), repositoryQuery.refetch()]) : isBranchSource ? Promise.all([refsQuery.refetch(), branchQuery.refetch()]) : query.refetch());
  const isRefreshing = isPullRequestSource ? pullRequestQuery.isFetching : isRepositorySource ? commitsQuery.isFetching || repositoryQuery.isFetching : isBranchSource ? refsQuery.isFetching || branchQuery.isFetching : query.isFetching;

  return <section className="workspace-diff" aria-label={isPullRequestSource ? 'Pull request changes' : 'Current workspace changes'}>
    <header>
      {isPullRequestSource
        ? <div><span className="workspace-diff-eyebrow"><GitPullRequest size={14} /> {pullRequest ? `${pullRequest.repository} #${pullRequest.number}` : selectedPullRequestUrl ? pullRequestLabel(selectedPullRequestUrl) : 'GitHub pull request'}</span><h2>{pullRequest?.title ?? 'Review pull-request decisions'}</h2><small>{displayedDiff?.branch}</small>{pullRequest && <p className="workspace-diff-pr-status">
              <span className={`workspace-diff-pr-badge workspace-diff-pr-badge-${pullRequest.state}`}>{pullRequest.draft ? 'Draft' : pullRequest.state === 'open' ? 'Open' : pullRequest.state === 'merged' ? 'Merged' : 'Closed'}</span>
              {pullRequest.state === 'open' && pullRequest.mergeableState !== 'unknown' && <span className="workspace-diff-pr-mergeable">{pullRequest.mergeableState}</span>}
              {pullRequest.reviewDecision && <span className={`workspace-diff-pr-review-decision workspace-diff-pr-review-decision-${pullRequest.reviewDecision}`}>{pullRequest.reviewDecision === 'approved' ? 'Approved' : pullRequest.reviewDecision === 'changes_requested' ? 'Changes requested' : 'Review required'}</span>}
              {pullRequest.comments?.available
                ? <span className="workspace-diff-pr-comments">{pullRequest.comments.total} review comment{pullRequest.comments.total === 1 ? '' : 's'}{pullRequest.comments.partial ? ' (partial)' : ''}</span>
                : <span className="workspace-diff-pr-comments muted">Comments unavailable</span>}
            </p>}<p>Review behavior decisions in priority order for this pull-request revision. Decisions are recorded against its head commit, so new commits return their hunks to review.</p>{selectedPullRequestUrl && <small className="workspace-diff-provenance"><a href={selectedPullRequestUrl} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={13} /></a></small>}</div>
        : isBranchSource ? <div><span className="workspace-diff-eyebrow"><GitBranch size={14} /> Branch</span><h2>{selectedBranchName || 'Review a branch'}</h2><div className="workspace-diff-record-metadata"><small>{selectedBranchName ? `${selectedBranchName}${baseBranch ? ` → ${baseBranch}` : ''}` : 'No branch selected'}</small><span>{baseBranch ? `Everything this branch adds since ${baseBranch}, including work already committed.` : 'Everything this branch adds since its base, including work already committed.'}</span></div></div>
        : isRepositorySource ? <div><span className="workspace-diff-eyebrow"><GitCommitHorizontal size={14} /> Repository</span><h2>Commit</h2><div className="workspace-diff-record-metadata"><small>{selectedCommit ? `${selectedCommit.shortSha} · ${selectedCommit.title}` : displayedDiff?.branch ?? 'No commit selected'}</small><span>This commit, compared against the one before it.</span></div></div>
        : <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> {selectedSnapshot ? 'Recorded version' : 'Workspace review'}</span>{selectedSnapshot && <><h2>Workspace review record</h2><div className="workspace-diff-record-metadata"><small>{displayedDiff?.branch}</small><span>Captured {new Date(selectedSnapshot.capturedAt).toLocaleString()}. This record is preserved in the history.</span><small>{selectedSnapshot.originatingAgentRunId ? `Agent run ${selectedSnapshot.originatingAgentRunId}` : 'No originating agent run recorded'}{selectedSnapshot.commitHash ? ` · Commit ${selectedSnapshot.commitHash.slice(0, 12)}` : ' · No commit recorded'}</small></div></>}</div>}
      <div className="workspace-diff-actions">
        <div className="workspace-review-source" role="group" aria-label="Review source">
          <button type="button" aria-pressed={reviewSource === 'workspace'} onClick={selectWorkspaceSource}><FileDiff size={13} />Workspace</button>
          <button type="button" aria-pressed={reviewSource === 'history'} onClick={selectHistorySource} disabled={snapshots.length === 0}><History size={13} />History</button>
          <button type="button" aria-pressed={isBranchSource} onClick={selectBranchSource}><GitBranch size={13} />Branch</button>
          <button type="button" aria-pressed={isRepositorySource} onClick={selectRepositorySource}><GitCommitHorizontal size={13} />Repository</button>
          <button type="button" aria-pressed={reviewSource === 'pull-request'} onClick={() => { setReviewSource('pull-request'); setSelectedPullRequestUrl((current) => current ?? availablePullRequests[0] ?? null); }}><GitPullRequest size={13} />GitHub PR</button>
        </div>
        {/* The repository picker is never gated on the active review source. A
            clean checkout opens on History and a linked PR opens on GitHub PR, so
            gating it there removed the only control that reaches another
            repository. */}
        {(conversationId || workItemId) && workspaces.length > 0 && <WorkspaceContextSwitcher selectedPath={explorer.data?.selectedPath ?? null} options={workspaces} onSelect={selectWorkspaceContext} />}
        {isBranchSource && <label className="workspace-repository-commit"><GitBranch size={13} /><span className="visually-hidden">Branch</span><select value={selectedBranchName} onChange={(event) => { setSelectedBranchName(event.target.value); setSelectedDecisionId(null); }} disabled={refsQuery.isPending || branches.length === 0}><option value="" disabled>{refsQuery.isPending ? 'Reading branches' : 'Select a branch'}</option>{branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.ahead ? ` · ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'}` : ''}</option>)}</select></label>}
        {isRepositorySource && <label className="workspace-repository-commit"><GitCommitHorizontal size={13} /><span className="visually-hidden">Commit</span><select value={selectedCommitSha} onChange={(event) => { setSelectedCommitSha(event.target.value); setSelectedDecisionId(null); }} disabled={commitsQuery.isPending || commits.length === 0}><option value="" disabled>{commitsQuery.isPending ? 'Reading repository' : 'Select a commit'}</option>{commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.shortSha} · {commit.title}</option>)}</select></label>}
        {reviewSource === 'history' && snapshots.length > 0 && <label className="workspace-diff-timeline"><History size={13} /><span className="visually-hidden">Workspace diff history</span><select value={selectedSnapshotId ?? selectedSnapshot?.id ?? ''} onChange={(event) => { setSelectedSnapshotId(event.target.value); setSelectedDecisionId(null); writeWorkspaceDiffSource(preferenceScope, `history:${event.target.value}`); }}><option value="">Latest recorded version</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.diff.changedFiles} files</option>)}</select></label>}
        {reviewSource === 'pull-request' && <div className="workspace-pr-source"><form onSubmit={submitPullRequestUrl}><label><span className="visually-hidden">Pull request URL</span><input aria-label="Pull request URL" value={pullRequestUrlDraft} onChange={(event) => setPullRequestUrlDraft(event.target.value)} placeholder="Paste GitHub PR URL" /></label><button type="submit">Review PR</button></form>{availablePullRequests.length > 0 && <label className="workspace-repository-picker"><span>PR</span><select aria-label="Pull request" value={selectedPullRequestUrl ?? ''} onChange={(event) => selectSource(event.target.value)}><option value="" disabled>Select pull request</option>{availablePullRequests.map((url) => <option key={url} value={url}>{pullRequestLabel(url)}</option>)}</select></label>}{pullRequestUrlError && <small role="alert">{pullRequestUrlError}</small>}</div>}
        <AiProviderSelect value={aiProvider} onChange={setAiProvider} ariaLabel="AI provider for diff scoring and delegated review" />
        {!isPullRequestSource && <button className="workspace-diff-handoff" type="button" onClick={() => setIsHandoffOpen(true)}><ClipboardCheck size={14} />Agentic handoff</button>}
        <button className={`workspace-diff-refresh${hasChanges ? ' workspace-diff-refresh-pending' : ''}`} type="button" onClick={refreshSource} disabled={isRefreshing}><RefreshCw size={13} className={isRefreshing ? 'spin' : ''} /> {hasChanges ? 'Refresh changes' : 'Refresh'}</button>
      </div>
    </header>
    <aside className="review-diff-stat" role="note" aria-label="Diff size">
      <strong>{diffStat.files} {diffStat.files === 1 ? 'file' : 'files'} changed</strong>
      <span className="review-diff-stat-added">+{diffStat.additions}</span>
      <span className="review-diff-stat-removed">−{diffStat.deletions}</span>
      <span className="review-diff-stat-total">{diffStat.additions + diffStat.deletions} changed lines</span>
    </aside>
    {reviewProgress.total > 0 && <p className="review-stack-progress" role="status">
      {reviewProgress.remaining} to judge · {reviewProgress.settled} settled automatically · {reviewProgress.judged} of {reviewProgress.total} answered
    </p>}
    {isHandoffOpen && <ModalDialog className="review-handoff-dialog" labelledBy="review-handoff-dialog-title" onClose={() => setIsHandoffOpen(false)}>
      <header className="review-handoff-dialog-header">
        <div className="review-handoff-dialog-icon"><ClipboardCheck size={20} /></div>
        <div><span>Run evidence</span><h2 id="review-handoff-dialog-title">Agentic handoff</h2>{reviewHandoff && <small>Captured {new Date(reviewHandoff.createdAt).toLocaleString()}</small>}</div>
        <button type="button" onClick={() => setIsHandoffOpen(false)} aria-label="Close agentic handoff"><X size={17} /></button>
      </header>
      {reviewHandoff
        ? <AgentRunReviewHandoffCard handoff={reviewHandoff} />
        : <div className="review-handoff-empty"><ClipboardCheck size={24} /><strong>No handoff recorded</strong><p>This review is not linked to a completed agent run with handoff evidence.</p></div>}
    </ModalDialog>}
    {isBranchSource && refsQuery.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not read this repository's branches.</strong><p>{refsQuery.error.message}</p><button type="button" className="button secondary compact" onClick={() => void refsQuery.refetch()} disabled={refsQuery.isFetching}>Retry</button></section>
      : isBranchSource && !selectedBranchName ? <p className="muted">{refsQuery.isPending ? 'Reading this repository.' : 'This repository has no branch to review beside its base.'}</p>
      : isBranchSource && branchQuery.isPending ? <DiffSkeleton />
      : isBranchSource && branchQuery.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not load this branch.</strong><p>{branchQuery.error.message}</p><button type="button" className="button secondary compact" onClick={() => void branchQuery.refetch()} disabled={branchQuery.isFetching}>Retry</button></section>
      : isRepositorySource && !selectedCommitSha && !commitsQuery.isError ? <p className="muted">{commitsQuery.isPending ? 'Reading this repository.' : 'This repository has no commits to browse.'}</p>
      : isRepositorySource && commitsQuery.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not read this repository.</strong><p>{commitsQuery.error.message}</p><button type="button" className="button secondary compact" onClick={() => void commitsQuery.refetch()} disabled={commitsQuery.isFetching}>Retry</button></section>
      : isRepositorySource && repositoryQuery.isPending ? <DiffSkeleton />
      : isRepositorySource && repositoryQuery.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not load this commit.</strong><p>{repositoryQuery.error.message}</p><button type="button" className="button secondary compact" onClick={() => void repositoryQuery.refetch()} disabled={repositoryQuery.isFetching}>Retry</button></section>
      : isPullRequestSource && pullRequestQuery.isLoading ? <DiffSkeleton />
      : isPullRequestSource && pullRequestQuery.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not load this pull-request diff.</strong><p>{pullRequestQuery.error.message}</p><button type="button" className="button secondary compact" onClick={() => void pullRequestQuery.refetch()} disabled={pullRequestQuery.isFetching}>Retry</button></section>
        : !displayedDiff || displayedDiff.files.length === 0 ? <p className="muted">{isPullRequestSource ? selectedPullRequestUrl ? 'GitHub reports no changed files for this pull request.' : 'Paste a GitHub pull-request URL or choose one from this conversation.' : isRepositorySource ? 'This commit changes no files.' : isBranchSource ? 'This branch adds nothing over its base.' : 'No uncommitted changes to review.'}</p>
          : hunkReviews.isLoading ? <DiffSkeleton />
            : hunkReviews.isError ? <section className="diff-review-load-error" role="alert"><strong>Could not load review decisions.</strong><p>{hunkReviews.error.message}</p><button type="button" className="button secondary compact" onClick={() => void hunkReviews.refetch()} disabled={hunkReviews.isFetching}>Retry</button></section>
              : <div className="workspace-diff-layout diff-review-layout">
                <DiffReviewSummaryView decisions={decisions} />
                <DiffReviewChangeMap map={changeMap} selectedId={selectedDecision?.id ?? null} riskBands={riskBands} openDetailFor={detailAnchor?.decisionId ?? null} onSelect={selectDecision} onOpenDetail={(decisionId, anchor) => openDecisionDetail(decisionId, anchor, 'data-change-map-node')} />
                {autoScores.running && <p className="muted" role="status">Scoring changes in the background — {autoScores.completed} of {autoScores.total} decisions.</p>}
                {!autoScores.running && autoScores.skipped > 0 && <p className="muted">{autoScores.skipped} decisions past the background scoring limit were not scored automatically; use Score risk on those.</p>}
                {(delegation.running || delegation.failed > 0 || delegation.skipped > 0) && <p className="muted" role="status">
                  {delegation.running
                    ? `Delegating — ${delegation.completed} of ${delegation.total} decisions answered.`
                    : `${delegation.completed} of ${delegation.total} decisions delegated.`}
                  {delegation.failed > 0 && ` ${delegation.failed} could not be answered and are still owed.`}
                  {delegation.skipped > 0 && ` ${delegation.skipped} past the delegation limit were left for you.`}
                </p>}
                {selectedDecision && <>
                  <DiffReviewDecisionQueue decisions={orderedDecisions} selectedId={selectedDecision.id} onSelect={selectDecision} commentCounts={isPullRequestSource ? commentCounts : undefined} delegating={delegation.pending} />
                  {isPullRequestSource && pullRequestQuery.hasNextPage && <button type="button" className="github-diff-load-more" onClick={() => void pullRequestQuery.fetchNextPage()} disabled={pullRequestQuery.isFetchingNextPage} aria-busy={pullRequestQuery.isFetchingNextPage}>{pullRequestQuery.isFetchingNextPage ? 'Loading more files…' : 'Load 100 more files'}</button>}
                  <div className="diff-review-workbench">
                    {readingMode === 'file' && selectedFile
                      ? <div className="review-full-file-shell">
                          <button type="button" className="diff-review-reading-mode mode-file" title={READING_MODE_TITLE} onClick={toggleReadingMode}>Whole file</button>
                          {wholeFileReadable
                            ? <ReviewFullFilePane filePath={selectedFile.path} file={fileSourceQuery.data?.file ?? null} isLoading={fileSourceQuery.isLoading} error={fileSourceQuery.error ? 'This file could not be read.' : null} hunks={fileHunks} activeDecisionId={selectedDecision.id} selectionTick={selectionTick} onSelect={selectDecision} />
                            : <p className="review-full-file-note">This binary file cannot be read whole.</p>}
                        </div>
                      : null}
                    {/* Whole-file reading magnifies one file, so the decision's
                        remaining files stay readable as diffs underneath it
                        rather than disappearing with the mode switch. */}
                    {(readingMode === 'file' ? fileHunkGroups.slice(1) : fileHunkGroups).map(({ file, hunks }) =>
                      <DiffReviewFileDiffPane key={file.path} filePath={file.path} editorUrl={file.editorUrl ?? null} hunks={hunks} decisions={decisions} activeDecisionId={selectedDecision.id} selectionTick={selectionTick} changeMap={changeMap} riskBands={riskBands} delegating={delegation.pending} handledBlocks={handledDecisions} readingMode={readingMode === 'file' ? 'diff' : readingMode} modeTitle={READING_MODE_TITLE} openDetailFor={detailAnchor?.decisionId ?? null} onSelect={selectDecision} onOpenDetail={openDecisionDetail} onToggleReadingMode={toggleReadingMode} />)}
                    {detailAnchor && popoverDecision && <DecisionPopover anchor={detailAnchor.anchor} anchorId={detailAnchor.decisionId} anchorAttribute={detailAnchor.anchorAttribute} labelledBy="diff-review-decision-title" aside={<DecisionRelationshipDiagram map={changeMap} decisionId={popoverDecision.id} cameFromId={cameFromDecisionId} riskBands={riskBands} onSelect={selectDecision} />} onClose={() => setDetailAnchor(null)}>
                      <DiffReviewDecisionDetailCard key={popoverDecision.id} decision={popoverDecision} decisions={decisions} taskIntent={taskIntent} autoScore={autoScores.results.get(popoverDecision.id)} staleReferences={staleReferences.data?.report ?? null} tier={decisionTiers.get(popoverDecision.id) ?? null}>
                        <DiffReviewActions key={popoverDecision.id} saving={upsertHunkReview.isPending} error={upsertHunkReview.isError ? upsertHunkReview.error.message : null} onSave={(state) => void saveDecision(popoverDecision, state)} onFix={onFixRequest ? () => requestFix(popoverDecision) : undefined} onSkip={() => skipDecision(popoverDecision)} />
                      </DiffReviewDecisionDetailCard>
                    </DecisionPopover>}
                  </div>
                </>}
              </div>}
  </section>;
});
