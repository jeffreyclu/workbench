import { memo, useEffect, useState } from 'react';
import { FileDiff, RefreshCw } from 'lucide-react';
import { Skeleton, SkeletonText } from '../../skeleton.js';
import { fileLabel, parsePatch } from './logic.js';
import { useWorkspaceDiff } from './hooks.js';

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

export const WorkspaceDiffView = memo(function WorkspaceDiffView({ workItemId, isRunning }: { workItemId: string; isRunning: boolean }) {
  const query = useWorkspaceDiff(workItemId, isRunning);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const files = query.data?.diff.files ?? [];
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  useEffect(() => { setSelectedPath(null); }, [query.dataUpdatedAt]);

  if (query.isLoading) return <DiffSkeleton />;
  if (query.isError) return <section className="workspace-diff workspace-diff-error" aria-live="polite"><strong>Could not load local workspace changes.</strong><p>{query.error.message}</p></section>;
  if (!query.data) return null;
  const { diff } = query.data;

  return <section className="workspace-diff" aria-label="Current workspace changes">
    <header>
      <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> Review before push</span><h2>Current workspace changes</h2><small>{diff.branch} · {diff.changedFiles} files · <b>+{diff.additions}</b> <i>−{diff.deletions}</i></small><p>Uncommitted changes in this task’s workspace. This includes staged, unstaged, and untracked files.</p></div>
      <button className="workspace-diff-refresh" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={13} className={query.isFetching ? 'spin' : ''} /> Refresh</button>
    </header>
    {files.length === 0 ? <p className="muted">No uncommitted changes to review.</p> : <div className="workspace-diff-layout">
      <nav aria-label="Changed workspace files"><span>Files ({files.length})</span><div>{files.map((file) => <button key={file.path} type="button" className={selectedFile?.path === file.path ? 'selected' : ''} onClick={() => setSelectedPath(file.path)} title={fileLabel(file)}><FileDiff size={13} /><span>{file.path}</span><b>+{file.additions}</b><i>−{file.deletions}</i></button>)}</div></nav>
      {selectedFile && <article className="workspace-diff-file"><header><strong>{fileLabel(selectedFile)}</strong><span>{selectedFile.isBinary ? 'Binary file' : selectedFile.status}</span></header>{selectedFile.patch ? <pre>{parsePatch(selectedFile.patch).map((line) => <code key={line.key} className={`diff-line ${line.kind}`}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><span>{line.text || ' '}</span></code>)}</pre> : <p className="muted">This binary file cannot be rendered as a text diff.</p>}</article>}
    </div>}
  </section>;
});
