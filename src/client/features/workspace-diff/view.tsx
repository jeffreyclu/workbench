import { memo, useMemo, useState } from 'react';
import { ExternalLink, FileDiff, History, RefreshCw } from 'lucide-react';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { useDiffBlockConfidence, useDiffRiskSummary } from '../diff-confidence-hooks.js';
import { groupDiffBlocks, isChangedBlock, type DiffFollowUpReference } from '../diff-confidence.js';
import { DiffBlockList, DiffSummaryStrip, useFlaggedBlockJump } from '../diff-review.js';
import { FileRiskBadge } from '../diff-confidence-bubble.js';
import { highlightHtml, languageFromPath } from '../../components/markdown/syntax-highlight.js';
import { fileLabel, parsePatch } from './logic.js';
import { useWorkspaceDiff, useWorkspaceDiffChanges, useWorkspaceDiffSnapshots } from './hooks.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { conversationClient } from '../../data/conversation-client.js';
import { sourceClient } from '../../data/source-client.js';
import { workspaceDiffQueryKeys } from './data.js';
import { CopyIconButton } from '../../components/markdown/copy-code.js';

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ scope, isRunning = false, activeWorkspacePaths, onFollowUp }: { scope: WorkspaceDiffScope; isRunning?: boolean; activeWorkspacePaths?: string[]; onFollowUp?: (reference: DiffFollowUpReference) => void }) {
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
  // null means "automatically show the latest record when Git is clean";
  // an empty string is the user's explicit choice to view current changes.
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const diff = query.data?.diff;
  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const selectedSnapshot = selectedSnapshotId === null && diff?.changedFiles === 0
    ? snapshots.find((snapshot) => snapshot.diff.changedFiles > 0) ?? null
    : snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;
  const displayedDiff = selectedSnapshot?.diff ?? diff;
  // A conversation can run agents in several repositories. Only activity in
  // this selected workspace should cause the diff to poll for fresh changes.
  const agentEditingWorkspace = activeWorkspacePaths
    ? activeWorkspacePaths.includes(diff?.workspacePath ?? '')
    : isRunning;
  const files = useMemo(() => displayedDiff?.files ?? [], [displayedDiff]);
  const filesWithBlocks = useMemo(() => files.map((file) => ({ path: file.path, blocks: file.patch ? groupDiffBlocks(parsePatch(file.patch)).filter(isChangedBlock).map((block) => ({ key: block.key, lines: block.lines.map((line) => line.text) })) : [] })), [files]);
  const filesWithChangedBlocks = useMemo(() => new Set(filesWithBlocks.filter((file) => file.blocks.length > 0).map((file) => file.path)), [filesWithBlocks]);
  const { riskByFile, flaggedBlocks } = useDiffRiskSummary(filesWithBlocks);
  const sortedFiles = useMemo(() => [...files].sort((a, b) => (riskByFile.get(b.path) ?? -1) - (riskByFile.get(a.path) ?? -1)), [files, riskByFile]);
  const jumpToNextFlagged = useFlaggedBlockJump(flaggedBlocks, setSelectedPath);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const hasChanges = useWorkspaceDiffChanges(scope, diff?.revision, agentEditingWorkspace && !selectedSnapshot);
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
  if (query.isLoading) return <DiffSkeleton />;
  if (query.isError) return <section className="workspace-diff workspace-diff-error" aria-live="polite"><strong>Could not load local workspace changes.</strong><p>{query.error.message}</p><button type="button" className="button secondary compact" onClick={() => void query.refetch()} disabled={query.isFetching}>Retry</button></section>;
  if (!diff) return null;

  return <section className="workspace-diff" aria-label="Current workspace changes">
    <header>
      <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> {selectedSnapshot ? 'Recorded version' : 'Workspace review'}</span><h2>{selectedSnapshot ? 'Workspace diff record' : 'Current workspace changes'}</h2><small>{displayedDiff?.branch} · <DiffSummaryStrip changedFiles={displayedDiff?.changedFiles ?? 0} additions={displayedDiff?.additions ?? 0} deletions={displayedDiff?.deletions ?? 0} flaggedCount={flaggedBlocks.length} onJumpToNextFlagged={jumpToNextFlagged} /></small><p>{selectedSnapshot ? `Captured ${new Date(selectedSnapshot.capturedAt).toLocaleString()}. This record is preserved in the history.` : 'Uncommitted changes in the selected repository. This includes staged, unstaged, and untracked files.'}</p>{selectedSnapshot && <small className="workspace-diff-provenance">{selectedSnapshot.originatingAgentRunId ? `Agent run ${selectedSnapshot.originatingAgentRunId}` : 'No originating agent run recorded'}{selectedSnapshot.commitHash ? ` · Commit ${selectedSnapshot.commitHash.slice(0, 12)}` : ' · No commit recorded'}</small>}</div>
      <div className="workspace-diff-actions">
        {(conversationId || workItemId) && Array.isArray(explorer.data?.workspaces) && <label className="workspace-repository-picker"><span>Repository</span><select value={explorer.data.selectedPath ?? ''} onChange={(event) => selectWorkspace.mutate(event.target.value)} disabled={selectWorkspace.isPending}><option value="" disabled>Select repository</option>{explorer.data.workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.label}</option>)}</select></label>}
        {snapshots.length > 0 && <label className="workspace-diff-timeline"><History size={13} /><span className="visually-hidden">Workspace diff history</span><select value={selectedSnapshotId ?? selectedSnapshot?.id ?? ''} onChange={(event) => { setSelectedSnapshotId(event.target.value); setSelectedPath(null); }}><option value="">Current changes</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.diff.changedFiles} files</option>)}</select></label>}
        <button className={`workspace-diff-refresh${hasChanges ? ' workspace-diff-refresh-pending' : ''}`} type="button" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={13} className={query.isFetching ? 'spin' : ''} /> {hasChanges ? 'Refresh changes' : 'Refresh'}</button>
      </div>
    </header>
    {files.length === 0 ? <p className="muted">No uncommitted changes to review.</p> : <div className="workspace-diff-layout diff-review-layout">
      <nav className="diff-file-list" aria-label="Changed workspace files"><span>Files ({files.length})</span><div>{sortedFiles.map((file) => <div key={file.path} className="diff-file-row"><button type="button" className={selectedFile?.path === file.path ? 'selected' : ''} onClick={() => setSelectedPath(file.path)}><FileDiff size={13} /><span>{file.path}</span><b>+{file.additions}</b><i>−{file.deletions}</i>{filesWithChangedBlocks.has(file.path) && <FileRiskBadge risk={riskByFile.get(file.path) ?? null} />}</button><div className="diff-file-actions">{file.editorUrl && <a href={file.editorUrl} className="diff-file-open-editor" aria-label={`Open ${file.path} in editor`} title="Open in editor"><ExternalLink size={13} /></a>}<CopyIconButton text={file.path} label="Copy file path" className="diff-file-copy-path" /></div></div>)}</div></nav>
      {selectedFile && <article className="workspace-diff-file"><header><div className="diff-file-info"><strong>{fileLabel(selectedFile)}</strong><span>{selectedFile.isBinary ? 'Binary file' : selectedFile.status}</span></div>{selectedFile.patch && <CopyIconButton text={selectedFile.patch} label="Copy patch" />}</header>{selectedFile.patch ? <pre><DiffBlockList key={selectedFile.path} blocks={blocks} lineHtml={lineHtml} filePath={selectedFile.path} assessments={Object.fromEntries(blocks.filter(isChangedBlock).map((block) => [block.key, confidence.failedKeys.has(block.key) ? { risk: null, reasoning: 'AI assessment unavailable; review this changed block.' } : confidence.data?.[block.key] ?? null]))} onFollowUp={onFollowUp} /></pre> : <p className="muted">This binary file cannot be rendered as a text diff.</p>}</article>}
    </div>}
  </section>;
});
