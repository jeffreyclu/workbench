import { memo, useEffect, useMemo, useState } from 'react';
import { FileDiff, GitCommitHorizontal, History, RefreshCw, Upload } from 'lucide-react';
import { Skeleton, SkeletonText } from '../../skeleton.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import type { DiffHunkReview, DiffHunkReviewState } from '../../../shared/contracts.js';
import { DiffConfidenceBubble } from '../diff-confidence-bubble.js';
import { useDiffBlockConfidence } from '../diff-confidence-hooks.js';
import { groupDiffBlocks, isChangedBlock, type DiffFollowUpReference } from '../diff-confidence.js';
import { highlightHtml, languageFromPath } from '../../syntax-highlight.js';
import { compareWorkspaceDiffSnapshots, fileLabel, parsePatch } from './logic.js';
import { useCommitAndPushWorkspace, useDiffHunkReviews, useUpsertDiffHunkReview, useWorkspaceDiff, useWorkspaceDiffChanges, useWorkspaceDiffSnapshots } from './hooks.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { conversationClient } from '../../data/conversation-client.js';
import { sourceClient } from '../../data/source-client.js';
import { workspaceDiffQueryKeys } from './data.js';
import { CopyIconButton } from '../../copy-code.js';

const HUNK_REVIEW_STATES: { state: DiffHunkReviewState; label: string }[] = [
  { state: 'reviewed', label: 'Reviewed' },
  { state: 'needs_changes', label: 'Needs changes' },
  { state: 'commented', label: 'Comment' },
];

function HunkReviewControl({ review, saving, onSave }: { review: DiffHunkReview | undefined; saving: boolean; onSave: (input: { state: DiffHunkReviewState; note?: string }) => void }) {
  const [note, setNote] = useState(review?.note ?? '');
  useEffect(() => { setNote(review?.note ?? ''); }, [review?.note]);
  return <div className="diff-hunk-review">
    <div className="diff-hunk-review-states">
      {HUNK_REVIEW_STATES.map(({ state, label }) => <button key={state} type="button" className={`diff-hunk-review-badge diff-hunk-review-badge-${state}${review?.state === state ? ' active' : ''}`} disabled={saving} onClick={() => onSave({ state, note: note.trim() || undefined })}>{label}</button>)}
    </div>
    {review && <input type="text" className="diff-hunk-review-note" placeholder="Add a note…" value={note} disabled={saving} onChange={(event) => setNote(event.target.value)} onBlur={() => { if (note.trim() !== (review.note ?? '')) onSave({ state: review.state, note: note.trim() || undefined }); }} />}
  </div>;
}

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ scope, isRunning, defaultCommitMessage = 'chore: update', onFollowUp }: { scope: WorkspaceDiffScope; isRunning: boolean; defaultCommitMessage?: string; onFollowUp?: (reference: DiffFollowUpReference) => void }) {
  const queryClient = useQueryClient();
  const conversationId = 'conversationId' in scope ? scope.conversationId : null;
  const workItemId = 'workItemId' in scope ? scope.workItemId : null;
  const explorerKey = conversationId ? ['conversation-workspaces', conversationId] : ['work-item-workspaces', workItemId];
  const explorer = useQuery({ queryKey: explorerKey, queryFn: () => conversationId ? conversationClient.getConversationWorkspaces(conversationId) : sourceClient.getWorkItemWorkspaces(workItemId!), enabled: Boolean(conversationId || workItemId) });
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  const [commitMessageEdited, setCommitMessageEdited] = useState(false);
  // The default message derives from a title that can arrive after this view's
  // first render (async task/conversation queries); keep tracking it until the
  // user actually edits the field themselves.
  useEffect(() => { if (!commitMessageEdited) setCommitMessage(defaultCommitMessage); }, [defaultCommitMessage, commitMessageEdited]);
  // null means "automatically show the latest record when Git is clean";
  // an empty string is the user's explicit choice to view current changes.
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [comparisonSnapshotId, setComparisonSnapshotId] = useState('');
  const diff = query.data?.diff;
  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const selectedSnapshot = selectedSnapshotId === null && diff?.changedFiles === 0
    ? snapshots.find((snapshot) => snapshot.diff.changedFiles > 0) ?? null
    : snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;
  const comparisonSnapshot = selectedSnapshot && comparisonSnapshotId
    ? snapshots.find((snapshot) => snapshot.id === comparisonSnapshotId) ?? null
    : null;
  const comparisonDiff = selectedSnapshot && comparisonSnapshot
    ? compareWorkspaceDiffSnapshots(comparisonSnapshot, selectedSnapshot)
    : null;
  const displayedDiff = comparisonDiff ?? selectedSnapshot?.diff ?? diff;
  const isSnapshotComparison = Boolean(comparisonDiff);
  const files = displayedDiff?.files ?? [];
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const hasChanges = useWorkspaceDiffChanges(scope, diff?.revision, isRunning && !selectedSnapshot);
  const publish = useCommitAndPushWorkspace(scope);
  const hunkReviews = useDiffHunkReviews(scope, isSnapshotComparison ? undefined : displayedDiff?.revision);
  const upsertHunkReview = useUpsertDiffHunkReview(scope, isSnapshotComparison ? undefined : displayedDiff?.revision);
  const hunkReviewByKey = useMemo(() => {
    const map = new Map<string, DiffHunkReview>();
    for (const review of hunkReviews.data?.reviews ?? []) map.set(`${review.filePath}::${review.hunkRange}`, review);
    return map;
  }, [hunkReviews.data]);
  const patch = selectedFile?.patch ?? null;
  const blocks = useMemo(() => (patch ? groupDiffBlocks(parsePatch(patch)) : []), [patch]);
  const language = selectedFile ? languageFromPath(selectedFile.path) : null;
  const lineHtml = useMemo(() => {
    const html = new Map<string, string>();
    for (const block of blocks) for (const line of block.lines) {
      if (line.kind !== 'header') html.set(line.key, highlightHtml(line.text.slice(1), language));
    }
    return html;
  }, [blocks, language]);
  const changedBlocks = useMemo(() => blocks.filter(isChangedBlock).map((block) => ({ key: block.key, lines: block.lines.map((line) => line.text) })), [blocks]);
  const confidence = useDiffBlockConfidence(changedBlocks);
  const publishDisabled = publish.isPending || isRunning || Boolean(diff?.publish.reason) || (!diff?.publish.hasChanges && diff?.publish.ahead === 0) || (Boolean(diff?.publish.hasChanges) && !commitMessage.trim());
  const publishLabel = publish.isPending ? 'Publishing…'
    : isRunning ? 'Agent running'
      : diff?.publish.reason ?? (diff?.publish.hasChanges ? 'Commit & push' : diff?.publish.ahead ? `Push ${diff.publish.ahead} commit${diff.publish.ahead === 1 ? '' : 's'}` : 'No changes to commit');

  if (query.isLoading) return <DiffSkeleton />;
  if (query.isError) return <section className="workspace-diff workspace-diff-error" aria-live="polite"><strong>Could not load local workspace changes.</strong><p>{query.error.message}</p><button type="button" className="button secondary compact" onClick={() => void query.refetch()} disabled={query.isFetching}>Retry</button></section>;
  if (!diff) return null;

  return <section className="workspace-diff" aria-label="Current workspace changes">
    <header>
      <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> {isSnapshotComparison ? 'Snapshot comparison' : selectedSnapshot ? 'Recorded version' : 'Review before push'}</span><h2>{isSnapshotComparison ? 'Changes between snapshots' : selectedSnapshot ? 'Workspace diff record' : 'Current workspace changes'}</h2><small>{displayedDiff?.branch} · {displayedDiff?.changedFiles} files · <b>+{displayedDiff?.additions}</b> <i>−{displayedDiff?.deletions}</i></small><p>{isSnapshotComparison && comparisonSnapshot ? `Showing files whose recorded patch changed from ${new Date(comparisonSnapshot.capturedAt).toLocaleString()} to ${new Date(selectedSnapshot!.capturedAt).toLocaleString()}.` : selectedSnapshot ? `Captured ${new Date(selectedSnapshot.capturedAt).toLocaleString()}. This record is preserved after commit and push.` : 'Uncommitted changes in the selected repository. This includes staged, unstaged, and untracked files.'}</p>{selectedSnapshot && !isSnapshotComparison && <small className="workspace-diff-provenance">{selectedSnapshot.originatingAgentRunId ? `Agent run ${selectedSnapshot.originatingAgentRunId}` : 'No originating agent run recorded'}{selectedSnapshot.commitHash ? ` · Commit ${selectedSnapshot.commitHash.slice(0, 12)}` : ' · No commit recorded'}</small>}</div>
      <div className="workspace-diff-actions">
        {(conversationId || workItemId) && Array.isArray(explorer.data?.workspaces) && <label className="workspace-repository-picker"><span>Repository</span><select value={explorer.data.selectedPath ?? ''} onChange={(event) => selectWorkspace.mutate(event.target.value)} disabled={selectWorkspace.isPending}><option value="" disabled>Select repository</option>{explorer.data.workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.label}</option>)}</select></label>}
        {snapshots.length > 0 && <label className="workspace-diff-timeline"><History size={13} /><span className="visually-hidden">Workspace diff version</span><select value={selectedSnapshotId ?? selectedSnapshot?.id ?? ''} onChange={(event) => { setSelectedSnapshotId(event.target.value); setComparisonSnapshotId(''); setSelectedPath(null); }}><option value="">Current changes</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.diff.changedFiles} files</option>)}</select></label>}
        {selectedSnapshot && snapshots.length > 1 && <label className="workspace-diff-timeline"><span className="visually-hidden">Compare snapshot against</span><select value={comparisonSnapshotId} onChange={(event) => { setComparisonSnapshotId(event.target.value); setSelectedPath(null); }}><option value="">Compare against…</option>{snapshots.filter((snapshot) => snapshot.id !== selectedSnapshot.id).map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.originatingAgentRunId ? `run ${snapshot.originatingAgentRunId.slice(0, 8)}` : 'manual'}</option>)}</select></label>}
        <button className={`workspace-diff-refresh${hasChanges ? ' workspace-diff-refresh-pending' : ''}`} type="button" onClick={() => void query.refetch()} disabled={query.isFetching || publish.isPending}><RefreshCw size={13} className={query.isFetching ? 'spin' : ''} /> {hasChanges ? 'Refresh changes' : 'Refresh'}</button>
        {diff.publish.hasChanges && <label className="workspace-diff-commit-message"><span className="visually-hidden">Commit message</span><input type="text" value={commitMessage} placeholder="Commit message" disabled={publish.isPending} onChange={(event) => { setCommitMessage(event.target.value); setCommitMessageEdited(true); }} /></label>}
        <button className="workspace-diff-publish" type="button" onClick={() => publish.mutate({ revision: diff.revision, message: commitMessage.trim() || undefined })} disabled={publishDisabled || Boolean(selectedSnapshot)}>
          {publish.isPending ? <RefreshCw size={13} className="spin" /> : diff.publish.hasChanges ? <GitCommitHorizontal size={13} /> : <Upload size={13} />} {publishLabel}
        </button>
      </div>
    </header>
    {publish.isError && <p className="workspace-diff-publish-error" role="alert">{publish.error.message}</p>}
    {publish.data?.result.pushed && <p className="workspace-diff-publish-success" role="status">Committed and pushed{publish.data.result.commit ? ` ${publish.data.result.commit}` : ''}.</p>}
    {files.length === 0 ? <p className="muted">No uncommitted changes to review.</p> : <div className="workspace-diff-layout diff-review-layout">
      <nav className="diff-file-list" aria-label="Changed workspace files"><span>Files ({files.length})</span><div>{files.map((file) => <div key={file.path} className="diff-file-row"><button type="button" className={selectedFile?.path === file.path ? 'selected' : ''} onClick={() => setSelectedPath(file.path)}><FileDiff size={13} /><span>{file.path}</span><b>+{file.additions}</b><i>−{file.deletions}</i></button><CopyIconButton text={file.path} label="Copy file path" className="diff-file-copy-path" /></div>)}</div></nav>
      {selectedFile && <article className="workspace-diff-file"><header><div className="diff-file-info"><strong>{fileLabel(selectedFile)}</strong><span>{selectedFile.isBinary ? 'Binary file' : selectedFile.status}</span></div>{selectedFile.patch && <CopyIconButton text={selectedFile.patch} label="Copy patch" />}</header>{selectedFile.patch ? <pre>{blocks.map((block) => {
              const changed = isChangedBlock(block);
              const assessment = confidence.data?.[block.key] ?? null;
              const isHunkHeader = block.lines[0]?.kind === 'header';
              const hunkRange = isHunkHeader ? block.lines[0].text : null;
              const review = hunkRange ? hunkReviewByKey.get(`${selectedFile.path}::${hunkRange}`) : undefined;
              return <div key={block.key} className={changed ? 'diff-block' : undefined}>
                {changed && !confidence.isError && <DiffConfidenceBubble assessment={assessment} onFollowUp={assessment && onFollowUp ? () => onFollowUp({ filePath: selectedFile.path, lines: block.lines, assessment }) : undefined} />}
                {block.lines.map((line) => <code key={line.key} className={`diff-line ${line.kind}`}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><span>{line.kind === 'header' ? (line.text || ' ') : <><span className="diff-line-marker">{line.text.slice(0, 1) || ' '}</span><span className="diff-line-code" dangerouslySetInnerHTML={{ __html: lineHtml.get(line.key) || '&nbsp;' }} /></>}</span></code>)}
                {hunkRange && !isSnapshotComparison && <HunkReviewControl review={review} saving={upsertHunkReview.isPending} onSave={(input) => upsertHunkReview.mutate({ filePath: selectedFile.path, hunkRange, ...input })} />}
              </div>;
            })}</pre> : <p className="muted">This binary file cannot be rendered as a text diff.</p>}</article>}
    </div>}
  </section>;
});
