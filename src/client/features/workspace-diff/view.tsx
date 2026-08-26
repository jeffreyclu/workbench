import { memo, useMemo, useState } from 'react';
import { FileDiff, GitCommitHorizontal, History, RefreshCw, Upload } from 'lucide-react';
import { Skeleton, SkeletonText } from '../../skeleton.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { DiffConfidenceBubble } from '../diff-confidence-bubble.js';
import { useDiffBlockConfidence } from '../diff-confidence-hooks.js';
import { groupDiffBlocks, isChangedBlock } from '../diff-confidence.js';
import { fileLabel, parsePatch } from './logic.js';
import { useCommitAndPushWorkspace, useWorkspaceDiff, useWorkspaceDiffChanges, useWorkspaceDiffSnapshots } from './hooks.js';

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ scope, isRunning }: { scope: WorkspaceDiffScope; isRunning: boolean }) {
  const query = useWorkspaceDiff(scope);
  const snapshotsQuery = useWorkspaceDiffSnapshots(scope, query.data?.diff.revision);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const diff = query.data?.diff;
  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;
  const displayedDiff = selectedSnapshot?.diff ?? diff;
  const files = displayedDiff?.files ?? [];
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const hasChanges = useWorkspaceDiffChanges(scope, diff?.revision, isRunning && !selectedSnapshot);
  const publish = useCommitAndPushWorkspace(scope);
  const patch = selectedFile?.patch ?? null;
  const blocks = useMemo(() => (patch ? groupDiffBlocks(parsePatch(patch)) : []), [patch]);
  const changedBlocks = useMemo(() => blocks.filter(isChangedBlock).map((block) => ({ key: block.key, lines: block.lines.map((line) => line.text) })), [blocks]);
  const confidence = useDiffBlockConfidence(changedBlocks);
  const publishDisabled = publish.isPending || isRunning || Boolean(diff?.publish.reason) || (!diff?.publish.hasChanges && diff?.publish.ahead === 0);
  const publishLabel = publish.isPending ? 'Publishing…'
    : isRunning ? 'Agent running'
      : diff?.publish.reason ?? (diff?.publish.hasChanges ? 'Commit & push' : diff?.publish.ahead ? `Push ${diff.publish.ahead} commit${diff.publish.ahead === 1 ? '' : 's'}` : 'No changes to commit');

  if (query.isLoading) return <DiffSkeleton />;
  if (query.isError) return <section className="workspace-diff workspace-diff-error" aria-live="polite"><strong>Could not load local workspace changes.</strong><p>{query.error.message}</p></section>;
  if (!diff) return null;

  return <section className="workspace-diff" aria-label="Current workspace changes">
    <header>
      <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> {selectedSnapshot ? 'Recorded version' : 'Review before push'}</span><h2>{selectedSnapshot ? 'Workspace diff record' : 'Current workspace changes'}</h2><small>{displayedDiff?.branch} · {displayedDiff?.changedFiles} files · <b>+{displayedDiff?.additions}</b> <i>−{displayedDiff?.deletions}</i></small><p>{selectedSnapshot ? `Captured ${new Date(selectedSnapshot.capturedAt).toLocaleString()}. This record is preserved after commit and push.` : 'Uncommitted changes in this task’s workspace. This includes staged, unstaged, and untracked files.'}</p></div>
      <div className="workspace-diff-actions">
        {snapshots.length > 0 && <label className="workspace-diff-timeline"><History size={13} /><span className="visually-hidden">Workspace diff version</span><select value={selectedSnapshot?.id ?? ''} onChange={(event) => { setSelectedSnapshotId(event.target.value || null); setSelectedPath(null); }}><option value="">Current changes</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.diff.changedFiles} files</option>)}</select></label>}
        <button className={`workspace-diff-refresh${hasChanges ? ' workspace-diff-refresh-pending' : ''}`} type="button" onClick={() => void query.refetch()} disabled={query.isFetching || publish.isPending}><RefreshCw size={13} className={query.isFetching ? 'spin' : ''} /> {hasChanges ? 'Refresh changes' : 'Refresh'}</button>
        <button className="workspace-diff-publish" type="button" onClick={() => publish.mutate(diff.revision)} disabled={publishDisabled || Boolean(selectedSnapshot)}>
          {publish.isPending ? <RefreshCw size={13} className="spin" /> : diff.publish.hasChanges ? <GitCommitHorizontal size={13} /> : <Upload size={13} />} {publishLabel}
        </button>
      </div>
    </header>
    {publish.isError && <p className="workspace-diff-publish-error" role="alert">{publish.error.message}</p>}
    {publish.data?.result.pushed && <p className="workspace-diff-publish-success" role="status">Committed and pushed{publish.data.result.commit ? ` ${publish.data.result.commit}` : ''}.</p>}
    {files.length === 0 ? <p className="muted">No uncommitted changes to review.</p> : <div className="workspace-diff-layout diff-review-layout">
      <nav className="diff-file-list" aria-label="Changed workspace files"><span>Files ({files.length})</span><div>{files.map((file) => <button key={file.path} type="button" className={selectedFile?.path === file.path ? 'selected' : ''} onClick={() => setSelectedPath(file.path)}><FileDiff size={13} /><span>{file.path}</span><b>+{file.additions}</b><i>−{file.deletions}</i></button>)}</div></nav>
      {selectedFile && <article className="workspace-diff-file"><header><strong>{fileLabel(selectedFile)}</strong><span>{selectedFile.isBinary ? 'Binary file' : selectedFile.status}</span></header>{selectedFile.patch ? <pre>{blocks.map((block) => { const changed = isChangedBlock(block); return <div key={block.key} className={changed ? 'diff-block' : undefined}>{changed && !confidence.isError && <DiffConfidenceBubble confidence={confidence.data?.[block.key] ?? null} />}{block.lines.map((line) => <code key={line.key} className={`diff-line ${line.kind}`}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><span>{line.text || ' '}</span></code>)}</div>; })}</pre> : <p className="muted">This binary file cannot be rendered as a text diff.</p>}</article>}
    </div>}
  </section>;
});
