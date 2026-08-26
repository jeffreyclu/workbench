import { memo, useEffect, useState } from 'react';
import { ExternalLink, FileDiff, GitPullRequest } from 'lucide-react';
import type { WorkItemReference } from '../../../shared/contracts.js';
import { Skeleton, SkeletonText } from '../../skeleton.js';
import { fileLabel, parsePatch, pullRequestUrl } from './logic.js';
import { useGitHubPullRequestDiff } from './hooks.js';

function DiffSkeleton() {
  return <section className="github-diff" aria-label="Pull request diff loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div><Skeleton width="72px" height="28px" radius="6px" /></header>
    <div className="github-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

export const GitHubDiffView = memo(function GitHubDiffView({ sourceUrl, references }: { sourceUrl: string | null; references: WorkItemReference[] }) {
  const url = pullRequestUrl([...(sourceUrl ? [sourceUrl] : []), ...references.map((reference) => reference.url)]);
  const query = useGitHubPullRequestDiff(url);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const diff = query.data?.diff;
  const files = diff?.files ?? [];
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  useEffect(() => { setSelectedPath(null); }, [url]);

  if (!url) return null;
  if (query.isLoading) return <DiffSkeleton />;
  if (query.isError) return <section className="github-diff github-diff-error" aria-live="polite"><strong>Could not load this pull-request diff.</strong><p>{query.error.message}</p><a href={url} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={13} /></a></section>;
  if (!diff) return null;

  return <section className="github-diff" aria-label={`Pull request ${diff.repository} #${diff.number} diff`}>
    <header>
      <div><span className="github-diff-eyebrow"><GitPullRequest size={14} /> {diff.repository} #{diff.number}</span><h2>{diff.title}</h2><small>{diff.baseRef} → {diff.headRef} · {diff.changedFiles} files · <b>+{diff.additions}</b> <i>−{diff.deletions}</i></small></div>
      <a href={diff.url} target="_blank" rel="noreferrer">GitHub <ExternalLink size={13} /></a>
    </header>
    {files.length === 0 ? <p className="muted">GitHub reports no changed files for this pull request.</p> : <div className="github-diff-layout diff-review-layout">
      <nav className="diff-file-list" aria-label="Changed files"><span>Files ({files.length}{diff.changedFiles > files.length ? '+' : ''})</span><div>{files.map((file) => <button key={file.path} type="button" className={selectedFile?.path === file.path ? 'selected' : ''} onClick={() => setSelectedPath(file.path)} title={fileLabel(file)}><FileDiff size={13} /><span>{file.path}</span><b>+{file.additions}</b><i>−{file.deletions}</i></button>)}</div></nav>
      {selectedFile && <article className="github-diff-file"><header><strong>{fileLabel(selectedFile)}</strong><span>{selectedFile.isBinary ? 'Binary file' : selectedFile.status}</span></header>{selectedFile.patch ? <pre>{parsePatch(selectedFile.patch).map((line) => <code key={line.key} className={`diff-line ${line.kind}`}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><span>{line.text || ' '}</span></code>)}</pre> : <p className="muted">GitHub does not provide a text patch for this binary or oversized file.</p>}</article>}
    </div>}
  </section>;
});
