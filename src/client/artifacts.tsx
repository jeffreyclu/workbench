import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Ban, Check, Copy, FileText, History, LoaderCircle, MessageSquare, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import { versionUrl } from './artifact-url';
import type { ArtifactComment, ArtifactEvent, ArtifactSummary, ArtifactVersion } from '../shared/contracts';

type LibraryView = 'published' | 'revoked' | 'all';

const eventLabels: Record<ArtifactEvent['kind'], string> = {
  published: 'Published',
  republished: 'Republished',
  revoked: 'Revoked',
  restored: 'Restored',
  commented: 'Feedback received',
  linked: 'Relationships updated',
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="button secondary compact" onClick={async () => {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    }}>
      {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

function VersionList({ artifact, versions }: { artifact: ArtifactSummary; versions: ArtifactVersion[] }) {
  return (
    <div className="artifact-versions">
      <span className="relationship-group-label">Versions</span>
      {versions.map((version) => (
        <div className="artifact-version" key={version.id}>
          <strong>v{version.version}</strong>
          <time>{formatDate(version.publishedAt)}</time>
          {version.version === artifact.version && <em className="relationship-tag">current</em>}
          {!artifact.revokedAt && (
            <a href={versionUrl(artifact.url, version.version)} target="_blank" rel="noreferrer" aria-label={`Open version ${version.version}`}>
              Open <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

function EventList({ events }: { events: ArtifactEvent[] }) {
  return (
    <div className="artifact-history">
      <span className="relationship-group-label">Publication history</span>
      {events.map((event) => (
        <div className="artifact-event" key={event.id}>
          <span className="activity-dot" />
          <div>
            <strong>{eventLabels[event.kind] ?? event.kind}</strong>
            {event.version !== null && <span> v{event.version}</span>}
            {event.detail && <span> — {event.detail}</span>}
            <time>{formatDate(event.createdAt)}</time>
          </div>
        </div>
      ))}
    </div>
  );
}

function CommentThread({ artifactId, comments }: { artifactId: string; comments: ArtifactComment[] }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] }),
    queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
  ]);
  const resolve = useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: string; resolved: boolean }) => api.resolveArtifactComment(artifactId, commentId, resolved),
    onSuccess: invalidate,
  });
  const add = useMutation({
    mutationFn: () => api.addArtifactComment(artifactId, { author: 'Jeffrey', body: body.trim() }),
    onSuccess: async () => { setBody(''); await invalidate(); },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (body.trim()) add.mutate();
  }

  return (
    <div className="artifact-comments">
      <span className="relationship-group-label">Feedback</span>
      {comments.length === 0 && <p className="muted">No feedback yet. Coworkers can leave it on the shared page.</p>}
      {comments.map((comment) => (
        <div className={`artifact-comment ${comment.resolvedAt ? 'resolved' : ''}`} key={comment.id}>
          <div>
            <strong>{comment.author}</strong>
            {comment.version !== null && <em className="relationship-tag">v{comment.version}</em>}
            <time>{formatDate(comment.createdAt)}</time>
          </div>
          <p>{comment.body}</p>
          <button className="button secondary compact" disabled={resolve.isPending} onClick={() => resolve.mutate({ commentId: comment.id, resolved: !comment.resolvedAt })}>
            {comment.resolvedAt ? 'Reopen' : <><Check size={13} /> Resolve</>}
          </button>
        </div>
      ))}
      <form className="artifact-comment-form" onSubmit={submit}>
        <textarea value={body} rows={2} onChange={(event) => setBody(event.target.value)} placeholder="Add your own note about this artifact…" aria-label="Add a note about this artifact" />
        <button className="button secondary compact" disabled={!body.trim() || add.isPending}>{add.isPending ? <LoaderCircle className="spin" size={13} /> : <MessageSquare size={13} />} Add note</button>
      </form>
      {add.error && <p className="error-message">{add.error.message}</p>}
    </div>
  );
}

function ArtifactDetailPanel({ artifact }: { artifact: ArtifactSummary }) {
  const detail = useQuery({ queryKey: ['artifact', artifact.id], queryFn: () => api.getArtifact(artifact.id) });
  if (detail.isLoading) return <div className="page-state"><LoaderCircle className="spin" size={14} /> Loading history…</div>;
  if (detail.isError || !detail.data) return <p className="error-message">Could not load this artifact&rsquo;s history.</p>;
  return (
    <div className="artifact-detail">
      <p className="artifact-source" title={detail.data.artifact.sourcePath}>
        {detail.data.artifact.sourcePath}
        {!detail.data.sourceAvailable && <em className="relationship-tag warn">source file missing</em>}
        {detail.data.sourceChanged && <em className="relationship-tag warn">local changes not published</em>}
      </p>
      <VersionList artifact={detail.data.artifact} versions={detail.data.versions} />
      <EventList events={detail.data.events} />
      <CommentThread artifactId={artifact.id} comments={detail.data.comments} />
    </div>
  );
}

function ArtifactCard({ artifact, onOpenTask, onOpenConversation }: {
  artifact: ArtifactSummary;
  onOpenTask: (taskId: string) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
    queryClient.invalidateQueries({ queryKey: ['artifact', artifact.id] }),
    queryClient.invalidateQueries({ queryKey: ['work-item', artifact.workItemId ?? ''] }),
  ]);
  const republish = useMutation({ mutationFn: () => api.republishArtifact(artifact.id), onSuccess: invalidate });
  const revoke = useMutation({ mutationFn: () => api.revokeArtifact(artifact.id), onSuccess: invalidate });

  return (
    <article className={`artifact-card ${artifact.revokedAt ? 'revoked' : ''}`}>
      <header>
        <FileText size={14} />
        <h3>{artifact.title}</h3>
        <em className="relationship-tag">v{artifact.version}</em>
        {artifact.revokedAt && <em className="relationship-tag warn">revoked</em>}
      </header>
      <div className="artifact-meta">
        <time>{artifact.revokedAt ? `Revoked ${formatDate(artifact.revokedAt)}` : `Published ${formatDate(artifact.publishedAt)}`}</time>
        {artifact.versionCount > 1 && <span>{artifact.versionCount} versions</span>}
        {artifact.openCommentCount > 0 && <span className="artifact-open-comments"><MessageSquare size={12} /> {artifact.openCommentCount} open</span>}
      </div>
      <div className="artifact-links">
        {artifact.workItemId && <button className="relationship-item" onClick={() => onOpenTask(artifact.workItemId!)}><span>{artifact.workItemTitle ?? 'Linked task'}</span></button>}
        {artifact.conversationId && <button className="relationship-item" onClick={() => onOpenConversation(artifact.conversationId!)}><span>{artifact.conversationTitle ?? 'Linked conversation'}</span></button>}
      </div>
      <div className="artifact-actions">
        {!artifact.revokedAt && <a className="button secondary compact" href={artifact.url} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> Open</a>}
        {!artifact.revokedAt && <CopyLink url={artifact.url} />}
        <button className="button secondary compact" disabled={republish.isPending} onClick={() => republish.mutate()}>
          {republish.isPending ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} {artifact.revokedAt ? 'Restore' : 'Republish'}
        </button>
        {!artifact.revokedAt && (
          <button className="button secondary compact danger" disabled={revoke.isPending} onClick={() => { if (window.confirm('Revoke this shared artifact? The link stops working for everyone.')) revoke.mutate(); }}>
            <Ban size={13} /> Revoke
          </button>
        )}
        <button className="button secondary compact" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          <History size={13} /> {expanded ? 'Hide history' : 'History & feedback'}
        </button>
      </div>
      {republish.error && <p className="error-message">{republish.error.message}</p>}
      {revoke.error && <p className="error-message">{revoke.error.message}</p>}
      {expanded && <ArtifactDetailPanel artifact={artifact} />}
    </article>
  );
}

export function ArtifactLibraryView({ onOpenTask, onOpenConversation }: {
  onOpenTask: (taskId: string) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [view, setView] = useState<LibraryView>('published');
  const library = useQuery({ queryKey: ['artifacts', view], queryFn: () => api.listArtifacts(view) });
  const counts = library.data?.counts;

  return (
    <section className="artifact-workspace">
      <header className="discovery-header">
        <div>
          <span className="eyebrow">Shared work</span>
          <h2>Artifact library</h2>
          <p>Every page you have shared with a coworker, with its versions, history, and feedback.</p>
        </div>
      </header>
      <div className="discovery-tabs">
        <button className={view === 'published' ? 'active' : ''} onClick={() => setView('published')}>Live <span>{counts?.published ?? '…'}</span></button>
        <button className={view === 'revoked' ? 'active' : ''} onClick={() => setView('revoked')}>Revoked <span>{counts?.revoked ?? '…'}</span></button>
        <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>All</button>
      </div>
      <div className="artifact-list">
        {library.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading artifacts…</div>}
        {library.isError && <div className="list-state error-message">Could not load the artifact library. <button className="button secondary compact" onClick={() => library.refetch()}>Retry</button></div>}
        {!library.isLoading && !library.data?.artifacts.length && (
          <div className="discovery-empty">
            <FileText size={26} />
            <h3>{view === 'revoked' ? 'Nothing revoked' : 'No shared artifacts yet'}</h3>
            <p>{view === 'revoked' ? 'Revoked shares stay here with their history.' : 'Open an artifact link in an agent reply and choose Share to publish it.'}</p>
          </div>
        )}
        {library.data?.artifacts.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} onOpenTask={onOpenTask} onOpenConversation={onOpenConversation} />
        ))}
      </div>
    </section>
  );
}

export function ArtifactNav({ active, onClick }: { active: boolean; onClick: () => void }) {
  const library = useQuery({ queryKey: ['artifacts', 'published'], queryFn: () => api.listArtifacts('published'), refetchInterval: 10_000 });
  const openComments = library.data?.counts?.openComments ?? 0;
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <FileText size={16} /> Artifacts
      <span className={openComments > 0 ? 'nav-count-alert' : ''} title={openComments > 0 ? `${openComments} pieces of feedback still open` : undefined}>
        {library.data?.counts?.published ?? '…'}
      </span>
    </button>
  );
}
