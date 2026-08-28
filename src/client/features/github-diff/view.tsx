import { memo, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FileDiff, GitPullRequest } from 'lucide-react';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton.js';
import { useDiffBlockConfidence, useDiffRiskSummary } from '../diff-confidence-hooks.js';
import { groupDiffBlocks, isChangedBlock, type DiffFollowUpReference } from '../diff-confidence.js';
import { DiffBlockList, DiffSummaryStrip, useFlaggedBlockJump } from '../diff-review.js';
import { FileRiskBadge } from '../diff-confidence-bubble.js';
import { highlightHtml, languageFromPath } from '../../components/markdown/syntax-highlight.js';
import { fileLabel, isPreviewableImage, parsePatch, pullRequestLabel, pullRequestUrls } from './logic.js';
import { githubDiffData } from './data.js';
import { useGitHubPullRequestDiff, useSelectedGitHubPullRequest } from './hooks.js';
import { CopyIconButton } from '../../components/markdown/copy-code.js';

function DiffSkeleton() {
  return <section className="github-diff" aria-label="Pull request diff loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div><Skeleton width="72px" height="28px" radius="6px" /></header>
    <div className="github-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

export const GitHubDiffView = memo(function GitHubDiffView({ candidateUrls, onFollowUp }: { candidateUrls: string[]; onFollowUp?: (reference: DiffFollowUpReference) => void }) {
  const urls = useMemo(() => pullRequestUrls(candidateUrls), [candidateUrls]);
  const [url, setUrl] = useSelectedGitHubPullRequest(urls);
  const query = useGitHubPullRequestDiff(url);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [failedImagePath, setFailedImagePath] = useState<string | null>(null);
  const diff = query.data?.pages[0]?.diff;
  const files = useMemo(() => query.data?.pages.flatMap((page) => page.diff.files) ?? [], [query.data]);
  const filesWithBlocks = useMemo(() => files.map((file) => ({ path: file.path, blocks: file.patch ? groupDiffBlocks(parsePatch(file.patch)).filter(isChangedBlock).map((block) => ({ key: block.key, lines: block.lines.map((line) => line.text) })) : [] })), [files]);
  const filesWithChangedBlocks = useMemo(() => new Set(filesWithBlocks.filter((file) => file.blocks.length > 0).map((file) => file.path)), [filesWithBlocks]);
  const { riskByFile, flaggedBlocks } = useDiffRiskSummary(filesWithBlocks);
  const sortedFiles = useMemo(() => [...files].sort((a, b) => (riskByFile.get(b.path) ?? -1) - (riskByFile.get(a.path) ?? -1)), [files, riskByFile]);
  const jumpToNextFlagged = useFlaggedBlockJump(flaggedBlocks, setSelectedPath);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
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

  useEffect(() => { setSelectedPath(null); setFailedImagePath(null); }, [url]);

  if (!url) return null;
  if (query.isLoading) return <DiffSkeleton />;
  if (query.isError) return <section className="github-diff github-diff-error" aria-live="polite"><strong>Could not load this pull-request diff.</strong><p>{query.error.message}</p><button type="button" className="button secondary compact" onClick={() => void query.refetch()} disabled={query.isFetching}>Retry</button><a href={url} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={13} /></a></section>;
  if (!diff) return null;

  return <section className="github-diff" aria-label={`Pull request ${diff.repository} #${diff.number} diff`}>
    <header>
      <div><span className="github-diff-eyebrow"><GitPullRequest size={14} /> {diff.repository} #{diff.number}</span><h2>{diff.title}</h2><small>{diff.baseRef} → {diff.headRef} · <DiffSummaryStrip changedFiles={diff.changedFiles} additions={diff.additions} deletions={diff.deletions} flaggedCount={flaggedBlocks.length} onJumpToNextFlagged={jumpToNextFlagged} /></small></div>
      {urls.length > 1 && <label className="github-diff-picker"><span>Pull request</span><select value={url ?? ''} onChange={(event) => setUrl(event.target.value)} aria-label="Pull request">{urls.map((pullRequestUrl) => <option key={pullRequestUrl} value={pullRequestUrl}>{pullRequestLabel(pullRequestUrl)}</option>)}</select></label>}
      <a href={diff.url} target="_blank" rel="noreferrer">GitHub <ExternalLink size={13} /></a>
    </header>
    {files.length === 0 ? <p className="muted">GitHub reports no changed files for this pull request.</p> : <div className="github-diff-layout diff-review-layout">
      <nav className="diff-file-list" aria-label="Changed files"><span>Files ({files.length}{diff.changedFiles > files.length ? '+' : ''})</span><div>{sortedFiles.map((file) => <div key={file.path} className="diff-file-row"><button type="button" className={selectedFile?.path === file.path ? 'selected' : ''} onClick={() => setSelectedPath(file.path)} title={fileLabel(file)}><FileDiff size={13} /><span>{file.path}</span><b>+{file.additions}</b><i>−{file.deletions}</i>{filesWithChangedBlocks.has(file.path) && <FileRiskBadge risk={riskByFile.get(file.path) ?? null} />}</button><div className="diff-file-actions"><CopyIconButton text={file.path} label="Copy file path" className="diff-file-copy-path" /></div></div>)}</div>{query.hasNextPage && <button type="button" className="github-diff-load-more" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} aria-busy={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Loading more files…' : 'Load 100 more files'}</button>}</nav>
      {selectedFile && <article className="github-diff-file"><header><div className="diff-file-info"><strong>{fileLabel(selectedFile)}</strong><span>{selectedFile.isBinary ? 'Binary file' : selectedFile.status}</span></div>{selectedFile.patch && <CopyIconButton text={selectedFile.patch} label="Copy patch" />}</header>{selectedFile.patch ? <pre><DiffBlockList key={selectedFile.path} blocks={blocks} lineHtml={lineHtml} filePath={selectedFile.path} assessments={Object.fromEntries(blocks.filter(isChangedBlock).map((block) => [block.key, confidence.failedKeys.has(block.key) ? { risk: null, reasoning: 'AI assessment unavailable; review this changed block.' } : confidence.data?.[block.key] ?? null]))} onFollowUp={onFollowUp} /></pre> : <div className="github-diff-unrenderable">{isPreviewableImage(selectedFile.path) && failedImagePath !== selectedFile.path && <img src={githubDiffData.imageUrl(url, selectedFile.path)} alt={`Preview of ${fileLabel(selectedFile)}`} onError={() => setFailedImagePath(selectedFile.path)} />}<p className="muted">GitHub does not provide a text patch for this binary or oversized file.</p><a href={`${diff.url}/files`} target="_blank" rel="noreferrer">View on GitHub <ExternalLink size={13} /></a></div>}</article>}
    </div>}
  </section>;
});
