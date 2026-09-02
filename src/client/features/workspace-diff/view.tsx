import { memo, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, GitPullRequest, History, RefreshCw } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton.js';
import { languageFromPath, SyntaxHighlight } from '../../components/markdown/syntax-highlight.js';
import type { AgentRunReviewHandoff, WorkspaceDiffFile } from '../../../shared/contracts.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { conversationClient } from '../../data/conversation-client.js';
import { sourceClient } from '../../data/source-client.js';
import type { ReviewAssistTaskIntent } from '../diff-review/decision-detail-card.js';
import { useGitHubPullRequestDiff } from '../github-diff/hooks.js';
import { pullRequestLabel, pullRequestUrls } from '../github-diff/logic.js';
import {
  useWorkspaceCommitDiff,
  useWorkspaceDiff,
  useWorkspaceDiffChanges,
  useWorkspaceDiffSnapshots,
  useWorkspaceRefCommits,
  useWorkspaceRefDiff,
  useWorkspaceRefs,
  useWorkspaceExplorer,
} from './hooks.js';
import { fileLabel, parsePatch } from './logic.js';

type ReviewSource = 'workspace' | 'history' | 'branch' | 'commit' | 'pull-request';

interface WorkspaceOption {
  path: string;
  label: string;
  selected: boolean;
}

interface ReviewDocument {
  workspacePath: string;
  branch: string;
  revision: string;
  files: WorkspaceDiffFile[];
  changedFiles: number;
  additions: number;
  deletions: number;
}

interface WorkspaceDiffViewProps {
  scope: WorkspaceDiffScope;
  isRunning?: boolean;
  activeWorkspacePaths?: string[];
  reviewHandoff?: AgentRunReviewHandoff | null;
  taskIntent?: ReviewAssistTaskIntent;
  pullRequestUrlCandidates?: string[];
  onFixRequest?: (prompt: string) => void;
}

function DiffSkeleton() {
  return <section className="workspace-diff" aria-label="Workspace changes loading" aria-busy="true">
    <header><div><Skeleton width="132px" height="12px" /><Skeleton width="min(440px, 78%)" height="20px" /></div></header>
    <div className="workspace-diff-skeleton"><Skeleton width="30%" height="220px" radius="6px" /><SkeletonText lines={12} /></div>
  </section>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The diff could not be loaded.';
}

function DiffFile({ file }: { file: WorkspaceDiffFile }) {
  const language = languageFromPath(file.path);
  if (file.isBinary || !file.patch) {
    return <article className="workspace-diff-file"><header><strong>{fileLabel(file)}</strong></header><p className="muted">Binary diff unavailable.</p></article>;
  }

  return <article className="workspace-diff-file">
    <header>
      <strong>{fileLabel(file)}</strong>
      <span><b>+{file.additions}</b> <i>−{file.deletions}</i>{file.editorUrl && <> · <a href={file.editorUrl}>Open in editor <ExternalLink size={12} /></a></>}</span>
    </header>
    <pre>{parsePatch(file.patch).map((line) => {
      const hasLineNumber = line.oldLine !== null || line.newLine !== null;
      const marker = hasLineNumber ? line.text.slice(0, 1) || ' ' : '';
      const code = hasLineNumber ? line.text.slice(1) || ' ' : line.text || ' ';
      return <code key={line.key} className={`diff-line ${line.kind}`}>
        <span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span>
        <span>{marker && <span className="diff-line-marker">{marker}</span>}<SyntaxHighlight code={code} language={line.kind === 'header' || !hasLineNumber ? null : language} className="diff-line-code" /></span>
      </code>;
    })}</pre>
  </article>;
}

function pullRequestDocument(pages: ReturnType<typeof useGitHubPullRequestDiff>['data']): ReviewDocument | null {
  const first = pages?.pages[0]?.diff;
  if (!first) return null;
  const files = pages.pages.flatMap((page) => page.diff.files);
  return {
    workspacePath: '',
    branch: `${first.headRef} → ${first.baseRef}`,
    revision: first.revision,
    files,
    changedFiles: first.changedFiles,
    additions: first.additions,
    deletions: first.deletions,
  };
}

/**
 * Changes is a repository browser. Its selected workspace and source are
 * explicit inputs to every read, never ambient server state. That single
 * invariant makes cached responses, active agent worktrees and repository
 * switching commute instead of racing to redefine what the screen means.
 */
export const WorkspaceDiffView = memo(function WorkspaceDiffView({ scope, isRunning = false, pullRequestUrlCandidates }: WorkspaceDiffViewProps) {
  const conversationId = 'conversationId' in scope ? scope.conversationId : null;
  const workItemId = 'workItemId' in scope ? scope.workItemId : null;
  const isStandaloneReview = 'reviewId' in scope;
  const explorer = useWorkspaceExplorer(scope, isRunning);
  const workspaces = useMemo<WorkspaceOption[]>(() => explorer.data?.workspaces ?? [], [explorer.data?.workspaces]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [source, setSource] = useState<ReviewSource>('workspace');
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [commit, setCommit] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const availablePullRequests = useMemo(() => pullRequestUrls(pullRequestUrlCandidates ?? []), [pullRequestUrlCandidates]);
  const [pullRequestUrl, setPullRequestUrl] = useState<string | null>(null);
  const [pullRequestDraft, setPullRequestDraft] = useState('');
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (isStandaloneReview || !explorer.data) return;
    setWorkspacePath((current) => workspaces.some((workspace) => workspace.path === current)
      ? current
      : explorer.data.selectedPath ?? workspaces[0]?.path ?? null);
  }, [explorer.data, isStandaloneReview, workspaces]);

  useEffect(() => {
    setPullRequestUrl((current) => current && availablePullRequests.includes(current) ? current : availablePullRequests[0] ?? null);
  }, [availablePullRequests]);

  const persistWorkspace = useMutation({
    mutationFn: (path: string) => conversationId
      ? conversationClient.selectConversationWorkspace(conversationId, path)
      : sourceClient.selectWorkItemWorkspace(workItemId!, path),
  });

  const workspaceQuery = useWorkspaceDiff(scope, workspacePath);
  const snapshotsQuery = useWorkspaceDiffSnapshots(scope, workspacePath, workspaceQuery.data?.diff.revision);
  const refsQuery = useWorkspaceRefs(scope, workspacePath);
  const snapshots = useMemo(() => snapshotsQuery.data?.snapshots ?? [], [snapshotsQuery.data?.snapshots]);
  const branches = useMemo(() => refsQuery.data?.refs?.branches ?? [], [refsQuery.data?.refs?.branches]);

  useEffect(() => {
    setSnapshotId((current) => snapshots.some((snapshot) => snapshot.id === current) ? current : snapshots[0]?.id ?? null);
  }, [snapshots]);

  useEffect(() => {
    setBranch((current) => branches.some((candidate) => candidate.name === current)
      ? current
      : branches.find((candidate) => candidate.current)?.name ?? branches[0]?.name ?? null);
  }, [branches]);

  const branchQuery = useWorkspaceRefDiff(scope, workspacePath, source === 'branch' ? branch : null);
  const commitsQuery = useWorkspaceRefCommits(scope, workspacePath, null);
  const commits = useMemo(() => commitsQuery.data?.commits ?? [], [commitsQuery.data?.commits]);
  useEffect(() => {
    setCommit((current) => commits.some((candidate) => candidate.sha === current) ? current : commits[0]?.sha ?? null);
  }, [commits]);
  const commitQuery = useWorkspaceCommitDiff(scope, workspacePath, source === 'commit' ? commit : null);
  const pullRequestQuery = useGitHubPullRequestDiff(source === 'pull-request' ? pullRequestUrl : null);

  const document = useMemo<ReviewDocument | null>(() => {
    if (source === 'history') return snapshots.find((snapshot) => snapshot.id === snapshotId)?.diff ?? null;
    if (source === 'branch') return branchQuery.data?.diff ?? null;
    if (source === 'commit') return commitQuery.data?.diff ?? null;
    if (source === 'pull-request') return pullRequestDocument(pullRequestQuery.data);
    return workspaceQuery.data?.diff ?? null;
  }, [branchQuery.data?.diff, commitQuery.data?.diff, pullRequestQuery.data, snapshotId, snapshots, source, workspaceQuery.data?.diff]);

  useEffect(() => {
    setSelectedFilePath((current) => document?.files.some((file) => file.path === current) ? current : document?.files[0]?.path ?? null);
  }, [document]);

  const hasNewWorkspaceRevision = useWorkspaceDiffChanges(scope, workspacePath, workspaceQuery.data?.diff.revision, isRunning && source === 'workspace');
  const selectedFile = document?.files.find((file) => file.path === selectedFilePath) ?? document?.files[0] ?? null;
  const sourceQuery = source === 'branch' ? branchQuery : source === 'commit' ? commitQuery : source === 'pull-request' ? pullRequestQuery : workspaceQuery;
  const sourceError = source === 'history' ? snapshotsQuery.error ?? snapshotsQuery.failureReason : sourceQuery.error ?? sourceQuery.failureReason;
  const sourcePending = source !== 'history' && sourceQuery.isPending && !sourceError;

  const selectWorkspace = (path: string) => {
    setWorkspacePath(path);
    setSource('workspace');
    setSelectedFilePath(null);
    persistWorkspace.mutate(path);
  };

  const selectReviewSource = (next: ReviewSource) => {
    setSource(next);
    setSelectedFilePath(null);
  };

  const submitPullRequest = (event: FormEvent) => {
    event.preventDefault();
    const [url] = pullRequestUrls([pullRequestDraft]);
    if (!url) {
      setPullRequestError('Enter a GitHub pull-request URL.');
      return;
    }
    setPullRequestError(null);
    setPullRequestUrl(url);
  };

  const refresh = () => {
    if (source === 'branch') void branchQuery.refetch();
    else if (source === 'commit') void commitQuery.refetch();
    else if (source === 'pull-request') void pullRequestQuery.refetch();
    else if (source === 'history') void snapshotsQuery.refetch();
    else void workspaceQuery.refetch();
  };

  if (!isStandaloneReview && explorer.isPending && !workspacePath) return <DiffSkeleton />;
  if (!isStandaloneReview && explorer.isError) {
    return <section className="workspace-diff workspace-diff-error" role="alert"><strong>Could not list repositories.</strong><p>{errorMessage(explorer.error)}</p><button type="button" onClick={() => void explorer.refetch()}>Retry</button></section>;
  }

  return <section className="workspace-diff" aria-label="Changes">
    <header>
      <div><span className="workspace-diff-eyebrow"><FileDiff size={14} /> Changes</span><h2>{document?.branch ?? 'Repository changes'}</h2><small>{document?.workspacePath || pullRequestUrl || workspacePath}</small></div>
      <div className="workspace-diff-actions">
        {!isStandaloneReview && workspaces.length > 0 && <label className="workspace-repository-picker"><span>Repository</span><select aria-label="Repository" value={workspacePath ?? ''} onChange={(event) => selectWorkspace(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.label}</option>)}</select></label>}
        <div className="workspace-review-source" role="group" aria-label="Review source">
          <button type="button" aria-pressed={source === 'workspace'} onClick={() => selectReviewSource('workspace')}><FileDiff size={13} />Workspace</button>
          <button type="button" aria-pressed={source === 'history'} disabled={snapshots.length === 0} onClick={() => selectReviewSource('history')}><History size={13} />History</button>
          <button type="button" aria-pressed={source === 'branch'} onClick={() => selectReviewSource('branch')}><GitBranch size={13} />Branch</button>
          <button type="button" aria-pressed={source === 'commit'} onClick={() => selectReviewSource('commit')}><GitCommitHorizontal size={13} />Commit</button>
          <button type="button" aria-pressed={source === 'pull-request'} onClick={() => selectReviewSource('pull-request')}><GitPullRequest size={13} />GitHub PR</button>
        </div>
        {source === 'history' && <label className="workspace-diff-timeline"><History size={13} /><span className="visually-hidden">Recorded version</span><select aria-label="Recorded version" value={snapshotId ?? ''} onChange={(event) => setSnapshotId(event.target.value)}>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.diff.changedFiles} files</option>)}</select></label>}
        {source === 'branch' && <label className="workspace-repository-commit"><GitBranch size={13} /><span className="visually-hidden">Branch</span><select aria-label="Branch" value={branch ?? ''} onChange={(event) => setBranch(event.target.value)}>{branches.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}</select></label>}
        {source === 'commit' && <label className="workspace-repository-commit"><GitCommitHorizontal size={13} /><span className="visually-hidden">Commit</span><select aria-label="Commit" value={commit ?? ''} onChange={(event) => setCommit(event.target.value)}>{commits.map((candidate) => <option key={candidate.sha} value={candidate.sha}>{candidate.shortSha} · {candidate.title}</option>)}</select></label>}
        {source === 'pull-request' && <div className="workspace-pr-source"><form onSubmit={submitPullRequest}><input aria-label="Pull request URL" value={pullRequestDraft} onChange={(event) => setPullRequestDraft(event.target.value)} placeholder="Paste GitHub PR URL" /><button type="submit">Review PR</button></form>{availablePullRequests.length > 0 && <select aria-label="Pull request" value={pullRequestUrl ?? ''} onChange={(event) => setPullRequestUrl(event.target.value)}>{availablePullRequests.map((url) => <option key={url} value={url}>{pullRequestLabel(url)}</option>)}</select>}{pullRequestError && <small role="alert">{pullRequestError}</small>}</div>}
        <button className={`workspace-diff-refresh${hasNewWorkspaceRevision ? ' workspace-diff-refresh-pending' : ''}`} type="button" onClick={refresh} disabled={sourceQuery.isFetching}><RefreshCw size={13} className={sourceQuery.isFetching ? 'spin' : ''} />{hasNewWorkspaceRevision ? 'Refresh changes' : 'Refresh'}</button>
      </div>
    </header>

    {(persistWorkspace.isError || sourceError) && <section className="diff-review-load-error" role="alert"><strong>Could not load this source.</strong><p>{errorMessage(persistWorkspace.error ?? sourceError)}</p>{sourceError && <button type="button" onClick={refresh} disabled={sourceQuery.isFetching}>Retry</button>}</section>}
    {sourcePending ? <DiffSkeleton /> : !document || document.files.length === 0 ? <p className="muted">No changes in this source.</p> : <>
      <aside className="review-diff-stat" role="note" aria-label="Diff size"><strong>{document.changedFiles} {document.changedFiles === 1 ? 'file' : 'files'} changed</strong><span className="review-diff-stat-added">+{document.additions}</span><span className="review-diff-stat-removed">−{document.deletions}</span></aside>
      <div className="workspace-diff-layout">
        <nav aria-label="Changed files"><div>{document.files.map((file) => <div className="diff-file-row" key={file.path}><button type="button" aria-current={selectedFile?.path === file.path ? 'true' : undefined} onClick={() => setSelectedFilePath(file.path)}><strong>{fileLabel(file)}</strong><small>+{file.additions} −{file.deletions}</small></button></div>)}</div></nav>
        {selectedFile && <DiffFile file={selectedFile} />}
      </div>
    </>}
  </section>;
});
