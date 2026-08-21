import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  ArrowUpRight,
  ArrowLeft,
  AlertTriangle,
  Bot,
  Check,
  Archive,
  Cloud,
  Command,
  FileText,
  GitPullRequest,
  LoaderCircle,
  Menu,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Link2,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Sparkles,
  User,
  X,
  Wrench,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownComposer } from './markdown-composer.js';
import { isSelfAssigned, SELF_ASSIGNED_EXECUTION_MESSAGE, SELF_ASSIGNED_OWNER_MESSAGE } from '../shared/contracts';
import type { AgentRun, Assignee, BrokerConnection, BrokerSourceId, DiscoveryCandidate, ExecutionPlan, ProviderSyncConflict, QueueItemExplanation, SharedConversation, SharedMessage, UpdateWorkItemInput, WorkItem, WorkItemDetail, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../shared/contracts';
import { api } from './api';
import { ArtifactLibraryView, ArtifactNav } from './artifacts';
import { ConfirmationDialog } from './confirmation-dialog';
import { InsightsView, InsightsNav } from './insights';
import { hideWorkbenchControlBlocks, humanizeRunOutput } from './run-output';
import { navigate, useRoute, type StackName } from './router';
import { parseSnippet } from './search-snippet';
import { Toaster } from './toast';
import { toast, toastError } from './toast-store';
import { SortableQueueItem as TaskQueueItem, TaskClassificationSelect } from './task-queue';

function ReferenceTypeIcon({ type }: { type: WorkItemReferenceType }) {
  if (type === 'linear_issue') return <Cloud size={13} />;
  if (type === 'pull_request') return <GitPullRequest size={13} />;
  if (type === 'slack_thread') return <MessageSquare size={13} />;
  if (type === 'document') return <FileText size={13} />;
  return <Link2 size={13} />;
}

function ConversationOriginBadge({ workItemId }: Pick<SharedConversation, 'workItemId'>) {
  const isTaskLinked = Boolean(workItemId);
  return <span
    className={`conversation-origin conversation-origin-${isTaskLinked ? 'task' : 'manual'}`}
    title={isTaskLinked ? 'Created automatically for a task' : 'Created manually'}
  >
    {isTaskLinked ? <Bot size={10} aria-hidden="true" /> : <User size={10} aria-hidden="true" />}
    {isTaskLinked ? 'Task-linked' : 'Manual'}
  </span>;
}

function sourceLinkLabel(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname;
    if (host.includes('slack.com')) return 'Open in Slack';
    if (host.includes('github.com')) return 'Open in GitHub';
    if (host.includes('atlassian.net')) return 'Open in Atlassian';
    if (host.includes('figma.com')) return 'Open in Figma';
    if (host.includes('linear.app')) return 'Open in Linear';
  } catch { /* Use the generic label for malformed legacy URLs. */ }
  return 'Open source';
}

function sourceReferenceType(sourceUrl: string): WorkItemReferenceType {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    if (host.includes('slack.com')) return 'slack_thread';
    if (host.includes('github.com') && /\/pull\/\d+(?:\/|$)/.test(sourceUrl)) return 'pull_request';
    if (host.includes('linear.app')) return 'linear_issue';
    if (host.includes('atlassian.net') || host.includes('confluence')) return 'document';
  } catch { /* The normal source link still supports legacy malformed URLs. */ }
  return 'other';
}

function sourceReferenceTitle(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/**
 * The activity log mixes Workbench's own routing decisions with Jeffrey's edits.
 * Labelling each entry keeps both scannable without opening a run.
 */
const activityKindLabels: Record<string, string> = {
  agent_fallback: 'fallback',
  archived: 'archive',
  chat_completed: 'chat',
  chat_started: 'chat',
  classification: 'task type',
  completed: 'done',
  edited: 'edit',
  execution_retried: 'retry',
  execution_started: 'routing',
  model_selected: 'model',
  model_preference: 'model pref',
  provider_conflict_resolved: 'sync',
  queue_moved: 'queue',
  reference_added: 'link',
  restored: 'restore',
  stack_changed: 'stack',
};

const agentDecisionKinds = new Set(['agent_fallback', 'classification', 'execution_retried', 'execution_started', 'model_selected']);

function activityKindLabel(kind: string): string {
  return activityKindLabels[kind] ?? kind.replace(/_/g, ' ');
}

function selectBalancedVisibleAgent(messages: Array<{ author: string }>): 'codex' | 'claude' {
  const codexCount = messages.filter((message) => message.author === 'codex').length;
  const claudeCount = messages.filter((message) => message.author === 'claude').length;
  return codexCount <= claudeCount ? 'codex' : 'claude';
}

function formatRunTelemetry(entry: Pick<AgentRun | SharedMessage, 'executionProfile' | 'inputTokens' | 'outputTokens' | 'fallbackFrom' | 'fallbackReason' | 'createdAt' | 'completedAt'> & { startedAt?: string | null }): string {
  const started = entry.startedAt ?? entry.createdAt;
  const duration = entry.completedAt ? Math.max(0, new Date(entry.completedAt).getTime() - new Date(started).getTime()) : null;
  const running = !entry.completedAt;
  const tokenText = running
    ? entry.outputTokens === null ? 'counting tokens…' : `~${entry.outputTokens.toLocaleString()} out · live estimate`
    : entry.inputTokens === null && entry.outputTokens === null ? 'tokens not reported' : `${entry.inputTokens?.toLocaleString() ?? '—'} in · ${entry.outputTokens?.toLocaleString() ?? '—'} out`;
  const durationText = duration === null ? '' : ` · ${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`;
  const fallbackText = entry.fallbackFrom ? ` · fallback from ${entry.fallbackFrom}${entry.fallbackReason ? ` (${entry.fallbackReason})` : ''}` : '';
  return `${entry.executionProfile ?? 'unrouted'} · ${tokenText}${durationText}${fallbackText}`;
}

function compactTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatRunBadge(entry: Pick<AgentRun | SharedMessage, 'inputTokens' | 'outputTokens' | 'completedAt'>): string {
  if (!entry.completedAt) return entry.outputTokens && entry.outputTokens > 0 ? `~${compactTokenCount(entry.outputTokens)} out` : 'counting…';
  if (entry.inputTokens === null && entry.outputTokens === null) return 'usage unavailable';
  const input = entry.inputTokens === null ? '—' : compactTokenCount(entry.inputTokens);
  const output = entry.outputTokens === null ? '—' : compactTokenCount(entry.outputTokens);
  return `${input} in · ${output} out`;
}

function ModelProfileSelect({ value, onChange, className = '' }: { value: AgentRun['executionProfile']; onChange: (value: AgentRun['executionProfile']) => void; className?: string }) {
  return <select className={className} value={value ?? 'auto'} onChange={(event) => onChange(event.target.value === 'auto' ? null : event.target.value as NonNullable<AgentRun['executionProfile']>)} aria-label="Model choice">
    <option value="auto">Auto model</option>
    <option value="economy">Fast · Haiku / Luna</option>
    <option value="standard">Balanced · Sonnet / Terra</option>
    <option value="deep">Powerful · Opus / Sol</option>
  </select>;
}

const conversationModelStorageKey = 'workbench:conversation-model-profiles';
const taskModelStorageKey = 'workbench:task-model-profiles';
const conversationDraftStorageKey = 'workbench:conversation-drafts';
function readTaskModelProfiles(): Record<string, NonNullable<AgentRun['executionProfile']>> {
  try {
    const value = JSON.parse(window.localStorage.getItem(taskModelStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, NonNullable<AgentRun['executionProfile']>] => ['economy', 'standard', 'deep'].includes(String(entry[1]))));
  } catch {
    return {};
  }
}

function writeTaskModelProfile(taskId: string, profile: AgentRun['executionProfile']): void {
  const profiles = readTaskModelProfiles();
  if (profile) profiles[taskId] = profile;
  else delete profiles[taskId];
  window.localStorage.setItem(taskModelStorageKey, JSON.stringify(profiles));
}

function readConversationDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(conversationDraftStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function writeConversationDraft(conversationId: string, body: string): void {
  const drafts = readConversationDrafts();
  if (body) drafts[conversationId] = body;
  else delete drafts[conversationId];
  window.localStorage.setItem(conversationDraftStorageKey, JSON.stringify(drafts));
}

function clearSentConversationDraft(conversationId: string, sentBody: string): void {
  const drafts = readConversationDrafts();
  if ((drafts[conversationId] ?? '') !== sentBody) return;
  delete drafts[conversationId];
  window.localStorage.setItem(conversationDraftStorageKey, JSON.stringify(drafts));
}

function readConversationModelProfiles(): Record<string, NonNullable<AgentRun['executionProfile']>> {
  try {
    const value = JSON.parse(window.localStorage.getItem(conversationModelStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, NonNullable<AgentRun['executionProfile']>] => ['economy', 'standard', 'deep'].includes(String(entry[1]))));
  } catch {
    return {};
  }
}

function AgentMessageBody({ body, running, conversationId, workItemId }: { body: string; running: boolean; conversationId?: string; workItemId?: string }) {
  const visibleBody = hideWorkbenchControlBlocks(running ? humanizeRunOutput(body) : body);
  if (!visibleBody) return null;
  return <div className="agent-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href = '', children, ...props }) => {
      const external = /^(?:(?!file:)[a-z][a-z0-9+.-]*:|#)/i.test(href);
      const artifactHref = external ? href : `/api/artifacts/open?path=${encodeURIComponent(href)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''}${workItemId ? `&workItemId=${encodeURIComponent(workItemId)}` : ''}`;
      return <a {...props} href={artifactHref} target="_blank" rel="noreferrer">{children}</a>;
    },
  }}>{visibleBody}</ReactMarkdown></div>;
}

/** Per-task score breakdown backing a queue proposal or the "why this order" explain view. */
function QueueExplanationList({ explanations }: { explanations: QueueItemExplanation[] }) {
  if (!explanations.length) return <p className="explanation-empty">No score breakdown is available yet.</p>;
  return <ol className="queue-explanations">
    {explanations.map((explanation) => {
      const moved = explanation.proposedPosition - explanation.previousPosition;
      return <li key={explanation.itemId} className="queue-explanation">
        <div className="queue-explanation-head">
          <span className="queue-explanation-rank">{String(explanation.proposedPosition + 1).padStart(2, '0')}</span>
          <strong>{explanation.title}</strong>
          {moved !== 0 && <span className={`queue-explanation-move ${moved < 0 ? 'up' : 'down'}`}>{moved < 0 ? `↑ ${Math.abs(moved)}` : `↓ ${moved}`}</span>}
        </div>
        {explanation.signals.length > 0 && <ul className="queue-signal-list">
          {explanation.signals.map((signal, index) => <li key={`${explanation.itemId}-${signal.key}-${index}`} className={signal.delta >= 0 ? 'positive' : 'negative'}>
            <span className="queue-signal-delta">{signal.delta >= 0 ? '+' : ''}{signal.delta}</span> {signal.detail}
          </li>)}
        </ul>}
      </li>;
    })}
  </ol>;
}

function CreateTask({ onClose, onCreated, defaultProjectName = '' }: { onClose: () => void; onCreated: (item: WorkItem) => void; defaultProjectName?: string }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'search' | 'link' | 'ai' | 'manual'>('search');
  const [sourceQuery, setSourceQuery] = useState('');
  const [submittedSourceQuery, setSubmittedSourceQuery] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiDraftReady, setAiDraftReady] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectName, setProjectName] = useState(defaultProjectName);
  const createManual = useMutation({
    mutationFn: api.createWorkItem,
    onSuccess: async ({ item }) => {
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
      onCreated(item);
      onClose();
    },
  });
  const searchedSources: BrokerSourceId[] = ['linear', 'github', 'atlassian', 'slack'];
  const sourceSearches = useQueries({
    queries: searchedSources.map((source) => ({
      queryKey: ['source-search', source, submittedSourceQuery],
      queryFn: ({ signal }) => api.searchSources(submittedSourceQuery, [source], signal),
      enabled: mode === 'search' && submittedSourceQuery.length >= 2,
    })),
  });
  const searchIsFetching = sourceSearches.some((search) => search.isFetching);
  const searchResults = sourceSearches.flatMap((search) => search.data?.results ?? []);
  async function startSourceSearch() {
    const query = sourceQuery.trim();
    if (query.length < 2) return;
    await queryClient.cancelQueries({ queryKey: ['source-search'] });
    setSubmittedSourceQuery(query);
  }
  async function cancelSourceSearch() {
    await queryClient.cancelQueries({ queryKey: ['source-search'] });
    queryClient.removeQueries({ queryKey: ['source-search'] });
    setSubmittedSourceQuery('');
  }
  const addSearchResult = useMutation({
    mutationFn: (result: { title: string; summary: string; url: string | null }) => api.createWorkItem({ title: result.title.replace(/^[^·]+ · /, ''), description: result.summary, projectName: defaultProjectName || null, status: 'backlog', dueDate: null, sourceUrl: result.url, workspacePath: null }),
    onSuccess: async ({ item }) => {
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
      onCreated(item);
      onClose();
    },
  });
  const resolveLink = useMutation({
    mutationFn: api.resolveSourceUrl,
    onSuccess: ({ draft }) => { setTitle(draft.title); setDescription(draft.description); setSourceUrl(draft.sourceUrl); },
  });
  const generateDraft = useMutation({
    mutationFn: api.generateTaskDraft,
    onSuccess: ({ draft }) => {
      setTitle(draft.title); setDescription(draft.description); setProjectName(defaultProjectName || draft.projectName || ''); setAiDraftReady(true);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    createManual.mutate({
      title,
      description,
      projectName: projectName || null,
      status: 'backlog',
      dueDate: null,
      sourceUrl: sourceUrl || null,
      workspacePath: null,
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog add-task-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Add to queue</span>
            <h2>Choose your next task</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="task-mode-tabs four-tabs" role="tablist">
          <button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}><Search size={14} /> From search</button>
          <button className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}><ArrowUpRight size={14} /> Paste link</button>
          <button className={mode === 'ai' ? 'active' : ''} onClick={() => setMode('ai')}><Sparkles size={14} /> Describe to AI</button>
          <button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}><Plus size={14} /> Manual task</button>
        </div>

        {mode === 'search' ? (
          <div className="linear-picker">
            <form className="linear-search" onSubmit={(event) => { event.preventDefault(); void startSourceSearch(); }}><Search size={16} /><input autoFocus value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} placeholder="Search Linear, Slack, Atlassian, and GitHub…" />{searchIsFetching && <button type="button" className="button secondary compact" onClick={() => void cancelSourceSearch()}>Cancel</button>}<button className="button primary compact" disabled={sourceQuery.trim().length < 2}>Search</button></form>
            <div className="linear-results">
              {submittedSourceQuery && <div className="source-search-progress">{searchedSources.map((source, index) => <span key={source} className={sourceSearches[index].isFetching ? 'searching' : sourceSearches[index].data || sourceSearches[index].error ? 'done' : ''}>{sourceSearches[index].isFetching && <LoaderCircle className="spin" size={10} />}{source}</span>)}</div>}
              {sourceSearches.map((search, index) => search.error ? <p key={searchedSources[index]} className="source-search-error"><strong>{searchedSources[index]}</strong> · {search.error.message}</p> : search.data ? Object.entries(search.data.errors).map(([source, error]) => <p key={source} className="source-search-error"><strong>{source}</strong> · {error}</p>) : null)}
              {!searchIsFetching && submittedSourceQuery.length >= 2 && searchResults.length === 0 && (
                <div className="list-state compact-state">No matching work found.</div>
              )}
              {searchResults.map((result, index) => (
                <button className="linear-result" key={`${result.source}-${result.url ?? index}`} onClick={() => addSearchResult.mutate(result)} disabled={addSearchResult.isPending}>
                  <span className="source-result-badge">{result.source}</span>
                  <span className="source-result-copy"><strong>{result.title}</strong><small>{result.summary}</small></span>
                  <span className="add-result">Add</span>
                </button>
              ))}
            </div>
          </div>
        ) : mode === 'link' ? (
          <form onSubmit={submit}>
            <label>Source URL<div className="resolve-row"><input autoFocus value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="Slack, GitHub, Linear, Confluence, or Gmail URL" /><button type="button" className="button secondary" onClick={() => resolveLink.mutate(sourceUrl)} disabled={!sourceUrl || resolveLink.isPending}>{resolveLink.isPending ? <LoaderCircle className="spin" size={14} /> : 'Resolve'}</button></div></label>
            <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Generated from the source" /></label>
            <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Generated description remains editable" rows={5} /></label>
            {resolveLink.error && <p className="error-message">{resolveLink.error.message}</p>}
            <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!title.trim() || createManual.isPending}><Plus size={16} /> Add to stack</button></div>
          </form>
        ) : mode === 'ai' ? (
          <form onSubmit={submit} className="ai-task-form">
            {!aiDraftReady ? <>
              <label>Describe the task<textarea autoFocus value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="Paste rough notes, links, constraints, or the outcome you want…" rows={9} /></label>
              <p className="ai-draft-help">AI will turn this into one self-contained, executable task. You can edit everything before adding it.</p>
              {generateDraft.error && <p className="error-message">{generateDraft.error.message}</p>}
              <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={() => generateDraft.mutate(aiPrompt)} disabled={aiPrompt.trim().length < 3 || generateDraft.isPending}>{generateDraft.isPending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} {generateDraft.isPending ? 'Writing task…' : 'Create draft'}</button></div>
            </> : <>
              <div className="ai-draft-banner"><Sparkles size={14} /><span><strong>AI draft</strong><small>Review and edit before adding it to the stack.</small></span><button type="button" onClick={() => setAiDraftReady(false)}>Start over</button></div>
              <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={9} /></label>
              <label>Project<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Optional" /></label>
              {createManual.error && <p className="error-message">{createManual.error.message}</p>}
              <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setAiDraftReady(false)}>Back</button><button className="button primary" disabled={!title.trim() || createManual.isPending}><Plus size={16} /> Add to stack</button></div>
            </>}
          </form>
        ) : (
          <form onSubmit={submit}>
            <label>
              Title
              <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to happen?" />
            </label>
            <label>
              Description
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Notes, constraints, links…" rows={5} />
            </label>
            <label>
              Project
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Personal" />
            </label>
            {createManual.error && <p className="error-message">{createManual.error.message}</p>}
            <div className="dialog-actions">
              <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
              <button className="button primary" disabled={!title.trim() || createManual.isPending}>
                {createManual.isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                Add to queue
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function SourceConnectionCard({ connection }: { connection: BrokerConnection }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const provider = connection.id;
  const reconnecting = connection.state === 'error' || connection.state === 'reauth_required';
  const disconnect = useMutation({
    mutationFn: () => api.disconnectSource(provider === 'atlassian' ? 'confluence' : provider === 'slack' || provider === 'figma' ? provider : 'github'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-connections'] }),
  });
  const mcpConnect = useMutation({
    mutationFn: async () => {
      // `codex mcp login figma` opens the provider's browser window itself.
      // Opening a Workbench popup as well duplicates the authorization window.
      if (provider === 'figma') {
        await api.startManagedFigmaOAuth();
        return;
      }
      const popup = window.open('about:blank', `workbench-${provider}-oauth`, 'popup,width=720,height=760');
      if (!popup) throw new Error('Popup blocked. Allow popups for Workbench and try again.');
      popup.document.write('<title>Connecting MCP</title><body style="margin:0;background:#10100f;color:#ddd;font:16px system-ui;display:grid;place-items:center;min-height:100vh">Preparing secure MCP authorization…</body>');
      try {
        if (provider === 'slack') {
          popup.location.replace('https://chatgpt.com/#settings/Connectors');
          return;
        }
        const oauthProvider = provider === 'atlassian' ? 'confluence' : null;
        if (!oauthProvider) throw new Error(`${connection.name} does not support MCP authorization here.`);
        if (reconnecting) await api.disconnectSource(oauthProvider);
        const { url } = await api.startMcpOAuth(oauthProvider); popup.location.replace(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start MCP authorization.';
        popup.document.body.textContent = `Connection failed: ${message}`;
        throw error;
      }
    },
  });
  useEffect(() => {
    const receiveOAuth = (event: MessageEvent) => {
      if (event.data?.type === 'workbench:slack-connected' || event.data?.type === 'workbench:mcp-connected') {
        void queryClient.invalidateQueries({ queryKey: ['source-connections'] });
        setOpen(false);
      }
    };
    window.addEventListener('message', receiveOAuth);
    return () => window.removeEventListener('message', receiveOAuth);
  }, [queryClient]);
  const connected = connection.state === 'connected';
  useEffect(() => {
    if (provider === 'figma' && connected) setOpen(false);
  }, [connected, provider]);
  const disabled = connection.state === 'disabled';
  const canAuthorize = provider === 'atlassian' || provider === 'slack' || provider === 'figma';
  return <div className={`connection-card ${connected ? 'connected' : ''} ${disabled ? 'unavailable' : ''}`}>
    <div className="connection-summary"><span><strong>{connection.name}</strong><small>{connection.detail}</small></span>
      {canAuthorize && connected && provider !== 'slack' ? <button className="button secondary compact" onClick={() => disconnect.mutate()}>Disconnect</button> : canAuthorize ? <button className="button secondary compact" onClick={() => setOpen((value) => !value)}>{open ? 'Cancel' : provider === 'slack' ? 'Manage connection' : reconnecting ? 'Reconnect MCP' : 'Connect MCP'}</button> : <span className="mcp-required">{disabled ? 'Awaiting IT approval' : connected ? 'Connected' : 'Not connected'}</span>}
    </div>
    <div className="connection-meta">{connection.host === 'workbench' ? 'Workbench' : 'Managed connector'}<span>·</span>{connection.capabilities.map((capability) => capability.replace('_', ' ')).join(' · ') || 'Unavailable'}</div>
    {connection.lastError && <p className="error-message">{connection.lastError}</p>}
    {open && canAuthorize && <div className="connection-form mcp-connection-form">
      <button className="button primary" onClick={() => mcpConnect.mutate()} disabled={mcpConnect.isPending}>{mcpConnect.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {provider === 'slack' ? 'Open ChatGPT connections' : 'Authorize MCP'}</button>
      {provider === 'figma' && mcpConnect.isSuccess && <p className="muted">Complete authorization in the Figma window that just opened.</p>}
      {mcpConnect.error && <p className="error-message">Connection failed: {mcpConnect.error.message}</p>}
    </div>}
  </div>;
}

function SourcesDialog({ onClose }: { onClose: () => void }) {
  const connections = useQuery({ queryKey: ['source-connections'], queryFn: api.listSourceConnections, refetchInterval: 2_000 });
  const linearConnection = connections.data?.connections.find((connection) => connection.id === 'linear');
  const linearConfigured = linearConnection?.state === 'connected';

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog sources-dialog" onMouseDown={(event) => event.stopPropagation()} aria-label="Workbench connections">
        <div className="dialog-header">
          <div><span className="eyebrow">Workbench</span><h2>Connections</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        <p className="dialog-description">Workbench uses these connections to resolve links and give agents source context without sending you through their authentication dialogs.</p>
        <div className="connection-list">
          <div className={`connection-card ${linearConfigured ? 'connected' : ''}`}>
            <div className="connection-summary"><span><strong>Linear</strong><small>{linearConfigured ? 'Connected · issues and project context' : 'Add LINEAR_API_KEY to .env to connect'}</small></span>
              <span className="mcp-required">{linearConfigured ? 'Connected' : 'Not connected'}</span>
            </div>
          </div>
          {connections.data?.connections.filter((connection) => connection.id !== 'linear').map((connection) => <SourceConnectionCard key={connection.id} connection={connection} />)}
        </div>
      </section>
    </div>
  );
}

function FollowUpArchiveDialog({ count, onChoose, onClose, pending }: { count: number; onChoose: (archiveParent: boolean) => void; onClose: () => void; pending: boolean }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="dialog follow-up-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="follow-up-archive-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="dialog-header"><div><span className="eyebrow">Create follow-ups</span><h2 id="follow-up-archive-title">What should happen to the original?</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></div>
      <p className="dialog-description">Create {count} selected follow-up task{count === 1 ? '' : 's'}, then choose whether the original task and conversation stay active.</p>
      <div className="follow-up-archive-actions">
        <button type="button" className="button primary" disabled={pending} onClick={() => onChoose(false)}>Create and keep open</button>
        <button type="button" className="button secondary" disabled={pending} onClick={() => onChoose(true)}><Archive size={14} /> Create and archive original</button>
      </div>
    </section>
  </div>;
}

export function SharedWorkspace({ initialConversationId, onOpenTask, onSelectConversation }: { initialConversationId?: string | null; onOpenTask?: (taskId: string) => void; onSelectConversation?: (conversationId: string | null) => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(() => initialConversationId ? readConversationDrafts()[initialConversationId] ?? '' : '');
  const [dispatchTo, setDispatchTo] = useState<'both' | 'codex' | 'claude'>('codex');
  const [conversationModelProfiles, setConversationModelProfiles] = useState(readConversationModelProfiles);
  const dispatchInitializedConversationId = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null);
  const [locallyReadConversationIds, setLocallyReadConversationIds] = useState<Set<string>>(new Set());
  const conversationIdRef = useRef(conversationId);
  const sentDraftRef = useRef<{ conversationId: string; body: string } | null>(null);
  const updateConversationPreferences = useMutation({
    mutationFn: ({ conversationId, profile }: { conversationId: string; profile: AgentRun['executionProfile'] }) => api.updateSharedConversationPreferences(conversationId, profile),
    onSuccess: async ({ conversation }) => {
      setConversationModelProfiles((current) => ({ ...current, ...(conversation.preferredExecutionProfile ? { [conversation.id]: conversation.preferredExecutionProfile } : {}) }));
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not save the model choice.', error),
  });
  const selectConversationRef = useRef(onSelectConversation);
  useEffect(() => { selectConversationRef.current = onSelectConversation; });
  useEffect(() => {
    conversationIdRef.current = conversationId;
    setBody(conversationId ? readConversationDrafts()[conversationId] ?? '' : '');
  }, [conversationId]);
  useEffect(() => {
    // The rail keeps owning the live selection; the address bar just follows it,
    // so an open conversation can be reloaded, shared, and stepped back out of.
    selectConversationRef.current?.(conversationId);
  }, [conversationId]);
  function updateBody(nextBody: string) {
    setBody(nextBody);
    if (conversationId) writeConversationDraft(conversationId, nextBody);
  }
  function setExecutionProfile(profile: AgentRun['executionProfile']) {
    if (!conversationId) return;
    const targetConversationId = conversationId;
    setConversationModelProfiles((current) => {
      const next = { ...current };
      if (profile) next[targetConversationId] = profile;
      else delete next[targetConversationId];
      window.localStorage.setItem(conversationModelStorageKey, JSON.stringify(next));
      return next;
    });
    updateConversationPreferences.mutate({ conversationId: targetConversationId, profile });
  }
  const [conversationView, setConversationView] = useState<'active' | 'archive'>('active');
  const [deleteConversationPromptOpen, setDeleteConversationPromptOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [dismissedCompletionPromptPromotionId, setDismissedCompletionPromptPromotionId] = useState<string | null>(null);
  const [debouncedConversationSearch, setDebouncedConversationSearch] = useState('');
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedConversationSearch(conversationSearch.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [conversationSearch]);
  const conversationSearchResults = useQuery({
    queryKey: ['shared-search', debouncedConversationSearch],
    queryFn: () => api.searchShared(debouncedConversationSearch),
    enabled: debouncedConversationSearch.length > 0,
  });
  const [pendingSelectedConversation, setPendingSelectedConversation] = useState<{ id: string; title: string } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [railOpen, setRailOpen] = useState(false);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const [proposedPlan, setProposedPlan] = useState<ExecutionPlan | null>(null);
  const [proposedPlanConversationId, setProposedPlanConversationId] = useState<string | null>(null);
  const [selectedPlanTaskIndexes, setSelectedPlanTaskIndexes] = useState<Set<number>>(new Set());
  const [planArchivePromptOpen, setPlanArchivePromptOpen] = useState(false);
  const initializedPlanSelectionId = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const conversations = useInfiniteQuery({
    queryKey: ['shared-conversations', conversationView], queryFn: ({ pageParam }) => api.listSharedConversations(conversationView, pageParam),
    initialPageParam: undefined as string | undefined, getNextPageParam: (page) => page.nextCursor ?? undefined, refetchInterval: 1_000,
  });
  const conversationList = useMemo(() => conversations.data?.pages.flatMap((page) => page.conversations) ?? [], [conversations.data?.pages]);
  const conversationVirtualizer = useVirtualizer({ count: conversationList.length, getScrollElement: () => conversationScrollRef.current, estimateSize: () => 58, overscan: 5, initialRect: { width: 250, height: 600 } });
  const conversationRows = conversationVirtualizer.getVirtualItems();
  const displayedConversationRows = conversationRows.length ? conversationRows : conversationList.map((_, index) => ({ index, start: index * 58 }));
  useEffect(() => {
    const last = conversationRows.at(-1);
    if (last && last.index >= conversationList.length - 5 && conversations.hasNextPage && !conversations.isFetchingNextPage) void conversations.fetchNextPage();
  }, [conversationList.length, conversationRows, conversations]);
  const conversationActivity = useQuery({ queryKey: ['shared-message-activity'], queryFn: () => api.listSharedMessages(), refetchInterval: 1_000 });
  const activeConversationIds = new Set(conversationActivity.data?.messages.filter((message) => message.status === 'running').map((message) => message.conversationId) ?? []);
  const fallbackConversationStates = useMemo(() => {
    const states = new Map<string, SharedConversation['state']>();
    for (const message of conversationActivity.data?.messages ?? []) {
      if (message.author !== 'codex' && message.author !== 'claude') continue;
      states.set(message.conversationId, message.status === 'running' || message.status === 'queued' ? 'working'
        : message.status === 'failed' || message.status === 'canceled' ? 'needs_attention'
          : message.status === 'completed' ? 'finished' : null);
    }
    return states;
  }, [conversationActivity.data?.messages]);
  const selectedConversation = conversationList.find((conversation) => conversation.id === conversationId);
  const executionProfile = conversationId ? conversationModelProfiles[conversationId] ?? selectedConversation?.preferredExecutionProfile ?? null : null;
  useEffect(() => {
    if (!selectedConversation?.preferredExecutionProfile) return;
    const profile = selectedConversation.preferredExecutionProfile;
    setConversationModelProfiles((current) => {
      if (current[selectedConversation.id] === profile) return current;
      const next = { ...current, [selectedConversation.id]: profile };
      window.localStorage.setItem(conversationModelStorageKey, JSON.stringify(next));
      return next;
    });
  }, [selectedConversation?.id, selectedConversation?.preferredExecutionProfile]);
  const linkedWorkItemId = selectedConversation?.workItemId ?? null;
  const linkedWorkItem = useQuery({ queryKey: ['work-item', linkedWorkItemId], queryFn: () => api.getWorkItem(linkedWorkItemId!), enabled: Boolean(linkedWorkItemId), refetchInterval: 1_000 });
  const linkedTaskCompleted = linkedWorkItem.data?.item.completionStatus === 'completed';
  // A task Jeffrey has claimed keeps its owner: chatting here must not hand it to an agent.
  const linkedTaskIsSelfAssigned = isSelfAssigned(linkedWorkItem.data?.item.assignees ?? []);
  // initialConversationId is navigation input, not a controlled selection.
  // Applying later prop changes here allowed a delayed Execute response to
  // steal focus after Jeffrey had already selected another conversation.
  // The workspace is remounted when it is opened from another view, so the
  // useState initializer above is the only synchronization we need.
  useEffect(() => {
    if (!conversationId && conversationList[0]) setConversationId(conversationList[0].id);
  }, [conversationId, conversationList]);
  useEffect(() => {
    setProposedPlan(linkedWorkItem.data?.executionPlan ?? null);
    setProposedPlanConversationId(linkedWorkItem.data?.executionPlan ? conversationId : null);
  }, [conversationId, linkedWorkItem.data?.executionPlan]);
  useEffect(() => {
    if (proposedPlan && initializedPlanSelectionId.current !== proposedPlan.id) {
      initializedPlanSelectionId.current = proposedPlan.id;
      setSelectedPlanTaskIndexes(new Set(proposedPlan.tasks.map((_, index) => index)));
    }
  }, [proposedPlan]);
  const messages = useQuery({
    queryKey: ['shared-messages', conversationId], queryFn: () => api.listSharedMessages(conversationId!), enabled: Boolean(conversationId),
    refetchInterval: (query) => query.state.data?.messages.some((message) => message.status === 'running' || message.status === 'queued') ? 750 : false,
  });
  useEffect(() => {
    if (!conversationId || dispatchInitializedConversationId.current === conversationId || !messages.data) return;
    if (linkedWorkItemId) {
      if (!linkedWorkItem.data) return;
      const executionAgent = [...messages.data.messages].reverse().find((message) => message.author === 'codex' || message.author === 'claude')?.author;
      if (executionAgent === 'codex' || executionAgent === 'claude') setDispatchTo(executionAgent);
      else {
        const assignedAgents = linkedWorkItem.data?.item.assignees.filter((assignee) => assignee === 'codex' || assignee === 'claude') ?? [];
        if (assignedAgents.length === 2) setDispatchTo('both');
        else if (assignedAgents[0] === 'codex' || assignedAgents[0] === 'claude') setDispatchTo(assignedAgents[0]);
        else setDispatchTo(selectBalancedVisibleAgent(conversationActivity.data?.messages ?? []));
      }
    } else setDispatchTo(selectBalancedVisibleAgent(conversationActivity.data?.messages ?? []));
    dispatchInitializedConversationId.current = conversationId;
  }, [conversationActivity.data?.messages, conversationId, linkedWorkItem.data, linkedWorkItemId, messages.data]);
  const send = useMutation({
    mutationFn: async () => {
      const attachments = await Promise.all(files.map(async (file) => ({
        name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
        dataBase64: await new Promise<string>((resolveValue, reject) => {
          const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolveValue(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file);
        }),
      })));
      return api.createSharedMessage(conversationId!, body, dispatchTo, attachments, executionProfile);
    },
    onMutate: async () => {
      if (!linkedWorkItemId) return undefined;
      await queryClient.cancelQueries({ queryKey: ['work-item', linkedWorkItemId] });
      const previous = queryClient.getQueryData<WorkItemDetail>(['work-item', linkedWorkItemId]);
      if (previous && !previous.item.archivedAt && previous.item.status !== 'done' && previous.item.status !== 'canceled') {
        queryClient.setQueryData<WorkItemDetail>(['work-item', linkedWorkItemId], { ...previous, item: { ...previous.item, status: 'in_progress' } });
      }
      return { previous };
    },
    onSuccess: async () => {
      const sentDraft = sentDraftRef.current;
      if (sentDraft) {
        clearSentConversationDraft(sentDraft.conversationId, sentDraft.body);
        if (conversationIdRef.current === sentDraft.conversationId) setBody((current) => current === sentDraft.body ? '' : current);
      }
      sentDraftRef.current = null;
      setFiles([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['insights'] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        linkedWorkItemId ? queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }) : Promise.resolve(),
      ]);
    },
    onError: (error, _variables, context) => {
      if (linkedWorkItemId && context?.previous) queryClient.setQueryData(['work-item', linkedWorkItemId], context.previous);
      toastError('Could not send that message.', error);
    },
  });
  const approvePreview = useMutation({
    mutationFn: () => api.createSharedMessage(conversationId!, 'Approve the Workbench preview.', 'none', []),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['runtime-preview-status'] }),
      ]);
    },
  });
  const createConversation = useMutation({
    mutationFn: () => api.createSharedConversation(),
    onSuccess: async ({ conversation }) => { setConversationId(conversation.id); await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }); },
  });
  const deleteConversation = useMutation({
    mutationFn: api.deleteSharedConversation,
    onSuccess: async () => {
      setDeleteConversationPromptOpen(false);
      setConversationId(null);
      toast.success('Conversation deleted.');
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not delete the conversation.', error),
  });
  const archiveConversation = useMutation({
    mutationFn: api.archiveSharedConversation,
    onSuccess: async ({ conversation }) => {
      setConversationView('archive');
      setConversationId(conversation.id);
      setPendingSelectedConversation({ id: conversation.id, title: conversation.title });
      toast.success(linkedWorkItemId ? 'Conversation and related task archived.' : 'Conversation archived.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item-counts'] }),
        linkedWorkItemId ? queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }) : Promise.resolve(),
      ]);
    },
    onError: (error) => toastError('Could not archive the conversation.', error),
  });
  const restoreConversation = useMutation({
    mutationFn: api.restoreSharedConversation,
    onSuccess: async ({ conversation }) => {
      setConversationView('active');
      setConversationId(conversation.id);
      setPendingSelectedConversation({ id: conversation.id, title: conversation.title });
      toast.success('Conversation restored.');
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not restore the conversation.', error),
  });
  const completeLinkedTask = useMutation({
    mutationFn: () => api.completeWorkItem(linkedWorkItemId!),
    onSuccess: async ({ item }) => {
      queryClient.setQueryData<WorkItemDetail>(['work-item', item.id], (current) => current && ({ ...current, item }));
      if (conversationId && selectedConversation) {
        setConversationView('archive');
        setPendingSelectedConversation({ id: conversationId, title: selectedConversation.title });
      }
      toast.success('Task completed.', { description: item.title });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['archived-work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item-counts'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', item.id] }),
      ]);
    },
    onError: (error) => toastError('Could not complete the task.', error),
  });
  const forkConversation = useMutation({
    mutationFn: api.forkSharedConversation,
    onSuccess: async ({ conversation }) => {
      setConversationView('active');
      setConversationId(conversation.id);
      toast.success('Conversation forked.');
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not fork the conversation.', error),
  });
  const cancelReply = useMutation({
    mutationFn: api.cancelSharedReply,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] }),
    onError: (error) => toastError('Could not cancel the response.', error),
  });
  const retryReply = useMutation<unknown, Error, SharedMessage>({
    mutationFn: async (message: SharedMessage) => {
      const linkedRun = linkedWorkItem.data?.runs.find((run) => run.messageId === message.id);
      return linkedRun ? await api.retryAgentRun(linkedRun.id) : await api.retrySharedMessage(message.id);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
      ]);
    },
    onError: (error) => toastError('Could not retry the response.', error),
  });
  const interjectMessage = useMutation({
    mutationFn: api.interjectSharedMessage,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] }),
    onError: (error) => toastError('Could not interject that message.', error),
  });
  const updateConversationOwner = useMutation({
    mutationFn: (target: 'both' | 'codex' | 'claude') => {
      const agents = target === 'both' ? ['codex' as const, 'claude' as const] : [target];
      return api.updateWorkItem(linkedWorkItemId!, { assignees: agents });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }),
  });
  const createTasks = useMutation({
    mutationFn: ({ messageId }: { messageId: string; conversationId: string }) => api.createTasksFromReport(messageId),
    onSuccess: async ({ plan }, variables) => {
      if (plan) {
        setProposedPlan(plan);
        setProposedPlanConversationId(variables.conversationId);
      }
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['shared-messages', variables.conversationId] }), queryClient.invalidateQueries({ queryKey: ['shared-conversations'] })]);
    },
  });
  const resolvePlan = useMutation({
    mutationFn: ({ resolution, archiveParent = false }: { resolution: 'accepted' | 'rejected'; archiveParent?: boolean }) =>
      api.resolveExecutionPlan(proposedPlan!.id, resolution, resolution === 'accepted' ? [...selectedPlanTaskIndexes] : undefined, archiveParent),
    onSuccess: async (result, { resolution }) => {
      // Accepting a decomposition archives the historical parent task and its
      // conversation. Keep that originating thread selected in the Archive
      // view instead of rendering its cached messages under "New conversation".
      if (resolution === 'accepted' && result.parentArchived && conversationId) {
        setConversationView('archive');
        setPendingSelectedConversation({ id: conversationId, title: selectedConversation?.title ?? 'Conversation' });
      }
      setProposedPlan(null);
      setProposedPlanConversationId(null);
      setPlanArchivePromptOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }),
      ]);
    },
  });
  const latestMessageLength = messages.data?.messages.at(-1)?.body.length ?? 0;
  useEffect(() => {
    if (!conversationId) return;
    setLocallyReadConversationIds((current) => current.has(conversationId) ? current : new Set(current).add(conversationId));
    void api.markSharedConversationRead(conversationId)
      .then(() => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation-unread-count'] }),
      ]))
      .catch(() => undefined);
  }, [conversationId, latestMessageLength, queryClient]);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages.data?.messages.length, latestMessageLength, proposedPlan]);
  useEffect(() => {
    if (!railOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRailOpen(false);
      railToggleRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [railOpen]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if ((body.trim() || files.length) && conversationId && !send.isPending) {
      sentDraftRef.current = { conversationId, body };
      send.mutate();
    }
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if ((body.trim() || files.length) && conversationId && !send.isPending) {
      sentDraftRef.current = { conversationId, body };
      send.mutate();
    }
  }

  const conversationMessages = messages.data?.messages ?? [];
  const latestAgentMessageId = [...conversationMessages].reverse().find((message) => message.author === 'codex' || message.author === 'claude')?.id ?? null;
  const previewStatus = useQuery({ queryKey: ['runtime-preview-status'], queryFn: api.getRuntimePreviewStatus, refetchInterval: 2_000 });
  const promotionInFlight = conversationMessages.some((message) =>
    message.author === 'system' && message.status === 'running' && /approval received|promot/i.test(message.body));
  const agentWorkInFlight = conversationMessages.some((message) =>
    (message.author === 'codex' || message.author === 'claude') && (message.status === 'queued' || message.status === 'running'));
  const latestCompletedAgentIndex = conversationMessages.reduce((latest, message, index) =>
    (message.author === 'codex' || message.author === 'claude') && message.status === 'completed' ? index : latest, -1);
  const latestPreviewApprovalRequestIndex = conversationMessages.reduce((latest, message, index) =>
    message.author === 'jeffrey' && /^\s*approve(?:\s+(?:the\s+)?)?(?:workbench\s+)?preview[.!]?\s*$/i.test(message.body) ? index : latest, -1);
  const latestPreviewPromotionIndex = conversationMessages.reduce((latest, message, index) =>
    message.author === 'system' && message.status === 'completed' && /preview approved and promoted/i.test(message.body) ? index : latest, -1);
  const latestSuccessfulPromotion = latestPreviewPromotionIndex >= 0 ? conversationMessages[latestPreviewPromotionIndex] : null;
  const completionPromptAvailable = Boolean(
    latestSuccessfulPromotion
    && linkedWorkItem.data?.item
    && !linkedTaskCompleted
    && dismissedCompletionPromptPromotionId !== latestSuccessfulPromotion.id,
  );
  const approvalRequestOutstanding = latestPreviewApprovalRequestIndex > Math.max(latestCompletedAgentIndex, latestPreviewPromotionIndex);
  const taskHasSuccessfulAgentOutcome = linkedWorkItem.data?.item.agentOutcome === 'finished' || linkedWorkItem.data?.item.agentOutcome === 'follow_ups';
  const conversationNeedsPreviewApproval = taskHasSuccessfulAgentOutcome && latestCompletedAgentIndex > latestPreviewPromotionIndex;
  const previewApprovalAvailable = linkedWorkItem.data?.item.stack === 'workbench'
    && taskHasSuccessfulAgentOutcome
    && !approvalRequestOutstanding
    && (previewStatus.data?.pending || conversationNeedsPreviewApproval) && !promotionInFlight && !agentWorkInFlight;

  return (
    <main className={`shared-workspace ${railOpen ? 'rail-open' : ''}`}>
      <button type="button" className="rail-scrim" aria-label="Close conversation list" onClick={() => setRailOpen(false)} />
      <aside id="conversation-rail" className="conversation-rail" aria-label="Conversations">
        <header><span className="eyebrow">Conversations</span><div className="conversation-header-actions"><button className="icon-button" onClick={() => createConversation.mutate()} aria-label="New conversation"><Plus size={15} /></button></div></header>
        <div className="search-box">
          <Search size={15} />
          <input
            aria-label="Search conversations"
            value={conversationSearch}
            onChange={(event) => setConversationSearch(event.target.value)}
            placeholder="Search all conversations…"
          />
          {conversationSearch && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setConversationSearch('')}><X size={13} /></button>}
        </div>
        {debouncedConversationSearch ? (
          <div className="conversation-tabs">
            {conversationSearchResults.isLoading && <div className="page-state"><LoaderCircle className="spin" size={12} /> Searching…</div>}
            {conversationSearchResults.isError && <div className="page-state error-message">Search failed. <button className="button secondary compact" onClick={() => conversationSearchResults.refetch()}>Retry</button></div>}
            {!conversationSearchResults.isLoading && !conversationSearchResults.isError && (conversationSearchResults.data?.results.length ?? 0) === 0 && (
              <div className="page-state">No matches for “{debouncedConversationSearch}”.</div>
            )}
            {conversationSearchResults.data?.results.map((result) => (
              <div key={`${result.type}-${result.conversationId}-${result.messageId ?? 'title'}`} className="virtual-row" style={{ position: 'static' }}>
                <button
                  className={result.conversationId === conversationId ? 'active' : ''}
                  onClick={() => { setConversationId(result.conversationId); setPendingSelectedConversation({ id: result.conversationId, title: result.conversationTitle }); setConversationSearch(''); setRailOpen(false); }}
                >
                  <span className="conversation-tab-title"><strong>{result.conversationTitle}</strong></span>
                  <small>{parseSnippet(result.snippet).map((part, index) => part.highlighted ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</small>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="conversation-view-tabs"><button className={conversationView === 'active' ? 'active' : ''} onClick={() => { setConversationView('active'); setConversationId(null); }}>Active</button><button className={conversationView === 'archive' ? 'active' : ''} onClick={() => { setConversationView('archive'); setConversationId(null); }}>Archive</button></div>
            <div ref={conversationScrollRef} className="conversation-tabs">
              <div className="virtual-list" style={{ height: conversationVirtualizer.getTotalSize() }}>
                {displayedConversationRows.map((row) => { const conversation = conversationList[row.index]; const isActive = conversation.isActive || activeConversationIds.has(conversation.id); const isUnread = Boolean(conversation.isUnread && !locallyReadConversationIds.has(conversation.id) && conversation.id !== conversationId); const state = isActive ? 'working' : conversation.state ?? fallbackConversationStates.get(conversation.id) ?? null; const stateLabel = state === 'working' ? 'Working' : state === 'needs_attention' ? 'Failed or canceled' : state === 'waiting_approval' ? 'Review follow-ups' : state === 'finished' ? 'Finished' : null; return <div key={conversation.id} ref={conversationVirtualizer.measureElement} data-index={row.index} className="virtual-row" style={{ transform: `translateY(${row.start}px)` }}><button className={`${conversation.id === conversationId ? 'active' : ''} ${isUnread ? 'conversation-unread' : 'conversation-read'} ${state ? `conversation-${state}` : ''}`} onClick={() => { setConversationId(conversation.id); setRailOpen(false); }}><span className="conversation-tab-title"><strong>{conversation.title}</strong>{isUnread && <span className="conversation-unread-marker">New</span>}{stateLabel && <span className={`conversation-state conversation-state-${state}`}>{state === 'working' && <LoaderCircle className="spin" size={10} />}{stateLabel}</span>}</span><small className="conversation-tab-meta"><ConversationOriginBadge workItemId={conversation.workItemId} /><span>{state === 'working' ? 'Agent working…' : new Date(conversation.updatedAt).toLocaleDateString()}</span></small></button></div>; })}
              </div>
              {!conversations.isLoading && conversationList.length === 0 && <div className="page-state">No {conversationView} conversations.</div>}
              {conversations.isFetchingNextPage && <div className="page-state"><LoaderCircle className="spin" size={12} /> Loading more…</div>}
            </div>
          </>
        )}
      </aside>
      <section className="agent-console" aria-label="Shared agent workspace">
        <header className="agent-console-header"><button ref={railToggleRef} type="button" className="rail-toggle icon-button" aria-label="Show conversations" aria-controls="conversation-rail" aria-expanded={railOpen} onClick={() => setRailOpen(true)}><Menu size={16} /></button><div className="agent-console-title">{selectedConversation ? <ConversationOriginBadge workItemId={selectedConversation.workItemId} /> : <span className="eyebrow">Shared context</span>}<h2>{selectedConversation?.title ?? (pendingSelectedConversation?.id === conversationId ? pendingSelectedConversation.title : 'New conversation')}</h2>{linkedWorkItem.data?.item && onOpenTask && <button type="button" className="related-task-link" onClick={() => onOpenTask(linkedWorkItem.data!.item.id)}><ArrowLeft size={12} /> Back to task</button>}</div>{conversationId && selectedConversation && <div className="conversation-window-actions">{linkedWorkItem.data?.item && <button type="button" className="complete-task-button" disabled={linkedTaskCompleted || completeLinkedTask.isPending} onClick={() => completeLinkedTask.mutate()} aria-label={linkedTaskCompleted ? 'Task completed' : 'Complete linked task'}>{completeLinkedTask.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}<span>{completeLinkedTask.isPending ? 'Completing…' : linkedTaskCompleted ? 'Completed' : 'Complete task'}</span></button>}<button className="icon-button" onClick={() => forkConversation.mutate(conversationId)} aria-label="Fork conversation" title="Fork into a new conversation"><MessageSquarePlus size={14} /></button>{conversationView === 'active' ? <button className="icon-button" onClick={() => archiveConversation.mutate(conversationId)} aria-label="Archive conversation" title="Archive conversation"><Archive size={14} /></button> : <button className="icon-button" onClick={() => restoreConversation.mutate(conversationId)} aria-label="Restore conversation" title="Restore conversation"><RefreshCw size={14} /></button>}<span className={`conversation-delete-control ${selectedConversation.workItemId ? 'is-disabled' : ''}`} tabIndex={selectedConversation.workItemId ? 0 : undefined}><button className="icon-button delete-conversation-button" disabled={Boolean(selectedConversation.workItemId)} onClick={() => setDeleteConversationPromptOpen(true)} aria-label="Delete conversation" aria-describedby={selectedConversation.workItemId ? 'linked-conversation-delete-help' : undefined} title={selectedConversation.workItemId ? undefined : 'Delete permanently'}><Trash2 size={14} /></button>{selectedConversation.workItemId && <span id="linked-conversation-delete-help" className="action-tooltip" role="tooltip">Delete the related task to delete this conversation.</span>}</span></div>}</header>
        {linkedWorkItem.data?.item && <div className="thread-filter-bar"><TaskClassificationSelect itemId={linkedWorkItem.data.item.id} kind={linkedWorkItem.data.item.classificationKind} /></div>}
        <div className="shared-thread">
          {messages.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading room…</div>}
          {messages.error && <div className="list-state compact-state error-message">Could not load shared messages: {messages.error.message}</div>}
          {messages.data?.messages.length === 0 && <div className="list-state compact-state">No messages yet. Ask Codex or Claude to get started.</div>}
          {conversationMessages.map((message) => (
            <article className={`shared-message shared-${message.author}`} key={message.id}>
              <header><strong>{message.author === 'jeffrey' ? 'You' : message.author}</strong><time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                {message.author === 'jeffrey' && message.dispatchTarget !== 'none' && <span className="recipient-badge">To {message.dispatchTarget === 'both' ? 'Codex + Claude' : message.dispatchTarget === 'auto' ? 'an agent' : message.dispatchTarget[0].toUpperCase() + message.dispatchTarget.slice(1)}</span>}
                {message.model && <span className="model-badge" title={formatRunTelemetry(message)}>{message.executionProfile === 'routing' ? 'routing' : message.model} · {formatRunBadge(message)}</span>}
                {message.status === 'running' && <button onClick={() => cancelReply.mutate(message.id)} title="Cancel response"><X size={12} /></button>}
              </header>
              {message.status === 'running' && <p className="thinking"><LoaderCircle className="spin" size={13} /> Live · {message.body ? 'receiving activity' : 'starting agent'}</p>}
              {message.status === 'queued' && (
                <div className="queued-message">
                  <LoaderCircle size={13} /> Queued · starts after the current agent finishes
                  <button type="button" className="queued-message-action" onClick={() => interjectMessage.mutate(message.id)} disabled={interjectMessage.isPending} title="Interrupt the current agent and send this now">Interject now</button>
                  <button type="button" className="queued-message-action" onClick={() => cancelReply.mutate(message.id)} disabled={cancelReply.isPending} title="Cancel this queued message">Cancel</button>
                </div>
              )}
              {message.body && (message.author === 'codex' || message.author === 'claude'
                ? <AgentMessageBody body={message.body} running={message.status === 'running'} conversationId={message.conversationId} />
                : <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown></div>)}
              {message.status === 'canceled' && <p className="muted">Response canceled.</p>}
              {message.id === latestAgentMessageId && (message.status === 'failed' || message.status === 'canceled') && <div className="message-actions"><button onClick={() => retryReply.mutate(message)} disabled={retryReply.isPending}><RefreshCw size={12} /> Retry / continue</button></div>}
              {message.attachments.length > 0 && <div className="message-files">{message.attachments.map((file) => (
                <a key={file.path} href={`/api/artifacts/raw?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(message.conversationId)}`} target="_blank" rel="noreferrer" title={`${file.mimeType} · ${formatFileSize(file.size)}`}>
                  <Paperclip size={11} /> {file.name} <span className="message-file-meta">{formatFileSize(file.size)}</span>
                </a>
              ))}</div>}
              {message.error && <p className="error-message">{message.error}</p>}
              {message.status === 'completed' && message.author !== 'jeffrey' && message.author !== 'system' && selectedConversation?.workItemId && <div className="message-actions"><button onClick={() => createTasks.mutate({ messageId: message.id, conversationId: conversationId! })} disabled={createTasks.isPending && createTasks.variables?.conversationId === conversationId}>{createTasks.isPending && createTasks.variables?.messageId === message.id && createTasks.variables.conversationId === conversationId ? <><LoaderCircle className="spin" size={12} /> Extracting findings…</> : <><Plus size={12} /> Turn findings into tasks</>}</button></div>}
            </article>
          ))}
          {completionPromptAvailable && <div className="completion-prompt" role="status"><span><strong>Preview approved successfully.</strong><small>Complete the linked task?</small></span><div><button type="button" className="button secondary compact" onClick={() => setDismissedCompletionPromptPromotionId(latestSuccessfulPromotion!.id)}>Not yet</button><button type="button" className="button primary compact" onClick={() => completeLinkedTask.mutate()} disabled={completeLinkedTask.isPending}>{completeLinkedTask.isPending ? <><LoaderCircle className="spin" size={12} /> Completing…</> : <><Check size={12} /> Complete task</>}</button></div></div>}
          {previewApprovalAvailable && <div className="preview-approval"><span><strong>Workbench preview has unpublished changes</strong><small>Review them on port 5174, then promote this source snapshot to live.</small></span><button className="button primary compact" onClick={() => approvePreview.mutate()} disabled={approvePreview.isPending}>{approvePreview.isPending ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />} {approvePreview.isPending ? 'Approving…' : 'Approve preview'}</button></div>}
          {previewApprovalAvailable && approvePreview.error && <p className="error-message">Could not approve preview: {approvePreview.error.message}</p>}
          {proposedPlan && proposedPlanConversationId === conversationId && <article className="chat-plan"><span className="eyebrow">Proposed follow-up tasks</span><h3>{proposedPlan.summary}</h3><ol>{proposedPlan.tasks.map((task, index) => <li key={`${task.title}-${index}`}><label><input type="checkbox" checked={selectedPlanTaskIndexes.has(index)} onChange={() => setSelectedPlanTaskIndexes((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{task.title}</strong><p>{task.description}</p></span></label></li>)}</ol><div><button className="button secondary" onClick={() => resolvePlan.mutate({ resolution: 'rejected' })}>Reject</button><button className="button primary" disabled={selectedPlanTaskIndexes.size === 0 || resolvePlan.isPending} onClick={() => setPlanArchivePromptOpen(true)}><Check size={14} /> Add {selectedPlanTaskIndexes.size} to queue</button></div></article>}
          {createTasks.isPending && createTasks.variables?.conversationId === conversationId && <div className="finding-progress"><LoaderCircle className="spin" size={15} /><span><strong>Turning findings into tasks</strong><small>Reading the report and producing self-contained queue items…</small></span></div>}
          {createTasks.error && createTasks.variables?.conversationId === conversationId && <div className="finding-progress error-message"><X size={15} /><span><strong>Could not create tasks</strong><small>{createTasks.error.message}</small></span></div>}
          <div ref={endRef} />
        </div>
        {conversationView === 'archive' ? <div className="archived-composer-note"><Archive size={14} /> Archived conversation · restore or fork it to continue</div> : <form className="shared-composer" onSubmit={submit}>
          {files.length > 0 && <div className="pending-files">{files.map((file) => <button type="button" key={`${file.name}-${file.size}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><Paperclip size={11} /> {file.name} <X size={10} /></button>)}</div>}
          <MarkdownComposer conversationId={conversationId} value={body} onChange={updateBody} onSubmit={() => {
            if ((body.trim() || files.length) && conversationId && !send.isPending) {
              sentDraftRef.current = { conversationId, body };
              send.mutate();
            }
          }} disabled={send.isPending} />
          <div className="composer-toolbar">
            <input ref={fileRef} className="visually-hidden" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
            <button type="button" className="composer-tool attach-button" onClick={() => fileRef.current?.click()}><Paperclip size={14} /> Attach</button>
            <span className="composer-hint">Files, screenshots, or context</span>
            <ModelProfileSelect className="model-target" value={executionProfile} onChange={setExecutionProfile} />
            <select className="agent-target" value={dispatchTo} onChange={(event) => { const target = event.target.value as typeof dispatchTo; setDispatchTo(target); if (linkedWorkItemId && !linkedTaskIsSelfAssigned) updateConversationOwner.mutate(target); }} aria-label="Who should respond">
              <option value="codex">Ask Codex</option><option value="claude">Ask Claude</option><option value="both">Ask both</option>
            </select>
            <button className="composer-send" aria-label="Send message" disabled={(!body.trim() && files.length === 0) || !conversationId || send.isPending}>{send.isPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
          </div>
          {send.error && <p className="error-message">{send.error.message}</p>}
        </form>}
      </section>
      {planArchivePromptOpen && <FollowUpArchiveDialog count={selectedPlanTaskIndexes.size} pending={resolvePlan.isPending} onClose={() => setPlanArchivePromptOpen(false)} onChoose={(archiveParent) => resolvePlan.mutate({ resolution: 'accepted', archiveParent })} />}
      {deleteConversationPromptOpen && conversationId && <ConfirmationDialog title="Delete this conversation?" description="This permanently deletes the conversation and cannot be undone." confirmLabel="Delete conversation" pending={deleteConversation.isPending} onClose={() => setDeleteConversationPromptOpen(false)} onConfirm={() => deleteConversation.mutate(conversationId)} />}
    </main>
  );
}

export function TaskDetail({ id, onClose, onOpenConversation, onOpenTask, onCreated }: { id: string; onClose: () => void; onOpenConversation: (conversationId: string) => void; onOpenTask: (taskId: string) => void; onCreated: (item: WorkItem) => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['work-item', id],
    queryFn: () => api.getWorkItem(id),
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === 'queued' || run.status === 'running') ? 1_000 : false,
  });
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [deleteTaskPromptOpen, setDeleteTaskPromptOpen] = useState(false);
  const [editingField, setEditingField] = useState<'title' | 'project' | 'description' | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editProjectName, setEditProjectName] = useState('');
  const [followUpTitle, setFollowUpTitle] = useState('');
  const [followUpDescription, setFollowUpDescription] = useState('');
  const [showAddReference, setShowAddReference] = useState(false);
  const [referenceType, setReferenceType] = useState<WorkItemReferenceType>('other');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [referenceTitle, setReferenceTitle] = useState('');
  const [showAddTaskLink, setShowAddTaskLink] = useState(false);
  const [taskLinkQuery, setTaskLinkQuery] = useState('');
  const [showAddArtifactLink, setShowAddArtifactLink] = useState(false);
  const [artifactLinkQuery, setArtifactLinkQuery] = useState('');
  const [dependencyQuery, setDependencyQuery] = useState('');
  const normalizedDependencyQuery = dependencyQuery.trim();
  const normalizedTaskLinkQuery = taskLinkQuery.trim();
  const normalizedArtifactLinkQuery = artifactLinkQuery.trim();
  const [selectedExecutionTaskIndexes, setSelectedExecutionTaskIndexes] = useState<Set<number>>(new Set());
  const [executionPlanArchivePromptOpen, setExecutionPlanArchivePromptOpen] = useState(false);
  const [executionProfile, setExecutionProfileState] = useState<AgentRun['executionProfile']>(() => readTaskModelProfiles()[id] ?? null);
  const setExecutionProfile = (profile: AgentRun['executionProfile']) => {
    setExecutionProfileState(profile);
    writeTaskModelProfile(id, profile);
  };

  const initializedExecutionPlanSelectionId = useRef<string | null>(null);
  const update = useMutation({
    mutationFn: (input: UpdateWorkItemInput) => api.updateWorkItem(id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
      ]);
    },
  });
  const resolveProviderConflict = useMutation({
    mutationFn: ({ field, resolution }: { field: ProviderSyncConflict['field']; resolution: 'keep_local' | 'use_provider' }) => api.resolveProviderConflict(id, field, resolution),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
      ]);
    },
  });
  const dependencyCandidates = useQuery({
    queryKey: ['dependency-candidates', id, normalizedDependencyQuery],
    queryFn: () => api.listDependencyCandidates(id, normalizedDependencyQuery),
    enabled: detail.isSuccess && normalizedDependencyQuery.length > 0,
  });
  const taskLinkCandidateQuery = useQuery({
    queryKey: ['task-link-candidates', id, normalizedTaskLinkQuery],
    queryFn: () => api.listWorkItems('active', normalizedTaskLinkQuery),
    enabled: showAddTaskLink && normalizedTaskLinkQuery.length > 0,
  });
  const artifactLinkCandidateQuery = useQuery({
    queryKey: ['artifact-link-candidates'],
    queryFn: () => api.listArtifacts('published'),
    enabled: showAddArtifactLink,
  });
  const execute = useMutation({
    mutationFn: () => api.executeWorkItem(id, executionProfile),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['work-items'] });
      const previousLists = queryClient.getQueriesData<InfiniteData<WorkItemPage>>({ queryKey: ['work-items'] });
      const previousDetail = queryClient.getQueryData<WorkItemDetail>(['work-item', id]);
      queryClient.setQueriesData<InfiniteData<WorkItemPage>>({ queryKey: ['work-items'] }, (current) => current && ({
        ...current,
        pages: current.pages.map((page) => ({ ...page, items: page.items.map((entry) => entry.id === id ? { ...entry, status: 'in_progress' } : entry) })),
      }));
      queryClient.setQueryData<WorkItemDetail>(['work-item', id], (current) => current && ({ ...current, item: { ...current.item, status: 'in_progress' } }));
      return { previousLists, previousDetail };
    },
    onSuccess: ({ conversation, runs, classification, activity }) => {
      queryClient.setQueryData<WorkItemDetail>(['work-item', id], (current) => current && {
        ...current,
        runs: [...runs, ...current.runs.filter((run) => !runs.some((created) => created.id === run.id))],
        classification,
        conversations: current.conversations.some((entry) => entry.id === conversation.id) ? current.conversations : [conversation, ...current.conversations],
        activity: [activity, ...current.activity],
      });
      toast.success('Task executed', {
        description: detail.data?.item.title,
        duration: 8_000,
        action: () => onOpenConversation(conversation.id),
        actionLabel: 'Open conversation',
      });
      void queryClient.invalidateQueries({ queryKey: ['work-item', id] });
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
      void queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error, _variables, context) => {
      for (const [key, value] of context?.previousLists ?? []) queryClient.setQueryData(key, value);
      if (context?.previousDetail) queryClient.setQueryData(['work-item', id], context.previousDetail);
      toastError('Could not start the run.', error);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['work-items'] }),
  });
  const cancelRun = useMutation({
    mutationFn: api.cancelAgentRun,
    onSuccess: async ({ run }) => {
      queryClient.setQueryData<WorkItemDetail>(['work-item', id], (current) => current && {
        ...current,
        runs: current.runs.map((currentRun) => currentRun.id === run.id ? run : currentRun),
      });
      toast.success('Run canceled.');
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
    onError: (error) => toastError('Could not cancel the run.', error),
  });
  const retryRun = useMutation({
    mutationFn: api.retryAgentRun,
    onSuccess: async ({ run, conversation, activity }) => {
      queryClient.setQueryData<WorkItemDetail>(['work-item', id], (current) => current && ({
        ...current,
        item: { ...current.item, status: 'in_progress' },
        runs: current.runs.map((entry) => entry.id === run.id ? run : entry),
        conversations: current.conversations.some((entry) => entry.id === conversation.id) ? current.conversations : [conversation, ...current.conversations],
        activity: [activity, ...current.activity],
      }));
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['work-items'] }), queryClient.invalidateQueries({ queryKey: ['shared-conversations'] })]);
    },
    onError: (error) => toastError('Could not retry the run.', error),
  });
  const resolveExecutionPlan = useMutation({
    mutationFn: ({ resolution, archiveParent = false }: { resolution: 'accepted' | 'rejected'; archiveParent?: boolean }) =>
      api.resolveExecutionPlan(detail.data!.executionPlan!.id, resolution, resolution === 'accepted' ? [...selectedExecutionTaskIndexes] : undefined, archiveParent),
    onSuccess: async () => {
      setExecutionPlanArchivePromptOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
      ]);
    },
  });
  const lifecycleSuccessMessage: Record<'archive' | 'restore' | 'complete' | 'delete', string> = {
    archive: 'Task archived.', restore: 'Task restored.', complete: 'Task completed.', delete: 'Task deleted.',
  };
  const lifecycleErrorSummary: Record<'archive' | 'restore' | 'complete' | 'delete', string> = {
    archive: 'Could not archive the task.', restore: 'Could not restore the task.', complete: 'Could not complete the task.', delete: 'Could not delete the task.',
  };
  const lifecycle = useMutation({
    mutationFn: async (action: 'archive' | 'restore' | 'complete' | 'delete'): Promise<void> => {
      if (action === 'archive') await api.archiveWorkItem(id);
      else if (action === 'restore') await api.restoreWorkItem(id);
      else if (action === 'complete') await api.completeWorkItem(id);
      else await api.deleteWorkItem(id);
    },
    onSuccess: async (_data, action) => {
      if (action === 'delete') setDeleteTaskPromptOpen(false);
      onClose();
      toast.success(lifecycleSuccessMessage[action]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['archived-work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-messages'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item-counts'] }),
      ]);
    },
    onError: (error, action) => toastError(lifecycleErrorSummary[action], error),
  });
  const createFollowUp = useMutation({
    mutationFn: () => api.createFollowUp(id, followUpTitle, followUpDescription),
    onSuccess: async ({ item }) => {
      setFollowUpTitle(''); setFollowUpDescription(''); setShowFollowUp(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['work-items'] }), queryClient.invalidateQueries({ queryKey: ['work-item', id] })]);
      onCreated(item);
    },
  });
  const addReference = useMutation({
    mutationFn: () => api.addWorkItemReference(id, { type: referenceType, url: referenceUrl.trim(), title: referenceTitle.trim() }),
    onSuccess: async () => {
      setReferenceUrl(''); setReferenceTitle(''); setReferenceType('other'); setShowAddReference(false);
      await queryClient.invalidateQueries({ queryKey: ['work-item', id] });
    },
  });
  const removeReference = useMutation({
    mutationFn: (referenceId: string) => api.removeWorkItemReference(id, referenceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
  });
  const addTaskLink = useMutation({
    mutationFn: (linkedWorkItemId: string) => api.addTaskLink(id, linkedWorkItemId),
    onSuccess: async ({ item: linkedTask }) => {
      setTaskLinkQuery(''); setShowAddTaskLink(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', linkedTask.id] }),
      ]);
    },
  });
  const removeTaskLink = useMutation({
    mutationFn: (linkedWorkItemId: string) => api.removeTaskLink(id, linkedWorkItemId),
    onSuccess: async (_data, linkedWorkItemId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }),
      ]);
    },
  });
  const addArtifactLink = useMutation({
    mutationFn: (artifactId: string) => api.updateArtifact(artifactId, { workItemId: id }),
    onSuccess: async () => {
      setArtifactLinkQuery(''); setShowAddArtifactLink(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
    },
  });

  useEffect(() => {
    if (detail.data?.executionPlan && initializedExecutionPlanSelectionId.current !== detail.data.executionPlan.id) {
      initializedExecutionPlanSelectionId.current = detail.data.executionPlan.id;
      setSelectedExecutionTaskIndexes(new Set(detail.data.executionPlan.tasks.map((_, index) => index)));
    }
  }, [detail.data?.executionPlan]);
  useEffect(() => {
    if (!detail.data?.item || editingField) return;
    setEditTitle(detail.data.item.title);
    setEditDescription(detail.data.item.description);
    setEditProjectName(detail.data.item.projectName ?? '');
  }, [detail.data?.item, editingField]);

  if (detail.isLoading) return <div className="detail-empty"><LoaderCircle className="spin" /></div>;
  if (!detail.data) return <div className="detail-empty">Unable to load this item.</div>;
  const { item, activity } = detail.data;
  const decisionCount = activity.filter((entry) => agentDecisionKinds.has(entry.kind)).length;
  const dependencies = item.blockedBy ?? [];
  const openDependencies = dependencies.filter((dependency) => dependency.isOpen);
  const providerConflicts = detail.data.providerConflicts ?? [];
  const hasBeenExecuted = detail.data.runs.length > 0;
  // Jeffrey owning the task is exclusive: agents can neither be assigned nor dispatched.
  const selfAssigned = isSelfAssigned(item.assignees);
  // sourceUrl is task-owned provenance, not a removable user-created reference.
  // Project it here so source-only tasks show their origin in the same history.
  const references: Array<WorkItemReference & { source: boolean }> = item.sourceUrl && !detail.data.references.some((reference) => reference.url === item.sourceUrl)
    ? [{ id: `source:${item.id}`, workItemId: item.id, type: sourceReferenceType(item.sourceUrl), url: item.sourceUrl, title: sourceReferenceTitle(item.sourceUrl), createdAt: item.createdAt, source: true }, ...detail.data.references.map((reference) => ({ ...reference, source: false }))]
    : detail.data.references.map((reference) => ({ ...reference, source: false }));
  const linkedTasks = detail.data.linkedTasks ?? [];
  const linkedTaskIds = new Set(linkedTasks.map((linkedTask) => linkedTask.id));
  const taskLinkCandidates = (taskLinkCandidateQuery.data?.items ?? []).filter((candidate) => candidate.id !== item.id && !linkedTaskIds.has(candidate.id));
  const artifactLinkCandidates = (artifactLinkCandidateQuery.data?.artifacts ?? []).filter((artifact) =>
    !artifact.workItemId && artifact.title.toLowerCase().includes(normalizedArtifactLinkQuery.toLowerCase()));

  function toggleAssignee(assignee: Assignee) {
    // Claiming the task for Jeffrey drops any agent owners; while he holds it the
    // agent buttons stay disabled instead of silently ignoring the click.
    if (assignee === 'jeffrey') return update.mutate({ assignees: selfAssigned ? [] : ['jeffrey'] });
    if (selfAssigned) return;
    const next = item.assignees.includes(assignee)
      ? item.assignees.filter((value) => value !== assignee)
      : [...item.assignees, assignee];
    update.mutate({ assignees: next });
  }

  function setDependencies(blockedByIds: string[]) {
    update.mutate({ blockedByIds });
  }

  return (
    <section className={`detail-panel ${execute.isPending ? 'execution-starting' : ''}`} aria-busy={execute.isPending}>
      <div className="detail-topline">
        <div className="source-badge">
          {item.source === 'linear' ? <Cloud size={13} /> : <Command size={13} />}
          {item.sourceIdentifier ?? 'LOCAL'}
        </div>
        <div className="detail-links">
          {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">{sourceLinkLabel(item.sourceUrl)} <ArrowUpRight size={13} /></a>}
          <button className="mobile-detail-close icon-button" onClick={onClose} aria-label="Close details"><X size={16} /></button>
        </div>
      </div>
      {openDependencies.length > 0 && <div className="dependency-blocker-banner" role="status">
        <AlertTriangle size={16} />
        <span><strong>Execution blocked</strong><small>Complete {openDependencies.length === 1 ? 'this prerequisite' : 'these prerequisites'} before dispatching an agent: {openDependencies.map((dependency) => dependency.title).join(', ')}.</small></span>
      </div>}
      {providerConflicts.length > 0 && <section className="provider-conflicts" aria-label="Linear sync conflicts">
        <div><strong>Linear changes need a decision</strong><small>{providerConflicts.length} field{providerConflicts.length === 1 ? '' : 's'} kept local after Linear changed too.</small></div>
        {providerConflicts.map((conflict) => <div className="provider-conflict" key={conflict.field}>
          <strong>{conflict.field === 'projectName' ? 'Project' : conflict.field === 'dueDate' ? 'Due date' : conflict.field}</strong>
          <span><small>Local</small>{Array.isArray(conflict.localValue) ? conflict.localValue.join(', ') || 'None' : conflict.localValue || 'None'}</span>
          <span><small>Linear</small>{Array.isArray(conflict.providerValue) ? conflict.providerValue.join(', ') || 'None' : conflict.providerValue || 'None'}</span>
          <div className="provider-conflict-actions"><button className="button secondary compact" onClick={() => resolveProviderConflict.mutate({ field: conflict.field, resolution: 'keep_local' })}>Keep local</button><button className="button compact" onClick={() => resolveProviderConflict.mutate({ field: conflict.field, resolution: 'use_provider' })}>Use Linear</button></div>
        </div>)}
      </section>}
      <div className="task-lifecycle-actions">
        <button type="button" className="button secondary compact" onClick={() => setShowFollowUp((value) => !value)}><Plus size={14} /> Follow-up</button>
        {item.archivedAt ? <><span className={`archive-state ${item.completionStatus}`}>{item.completionStatus === 'completed' ? 'Completed & archived' : 'Archived incomplete'}</span><button type="button" className="button secondary compact" onClick={() => lifecycle.mutate('restore')} disabled={lifecycle.isPending}><Archive size={14} /> Restore</button></> : <>
          <button type="button" className="button secondary compact" onClick={() => lifecycle.mutate('archive')} disabled={lifecycle.isPending}><Archive size={14} /> Archive</button>
          <button type="button" className="button primary compact" onClick={() => lifecycle.mutate('complete')} disabled={lifecycle.isPending}><Check size={14} /> Complete</button>
        </>}
        <button type="button" className="button danger compact" onClick={() => setDeleteTaskPromptOpen(true)}><Trash2 size={14} /> Delete</button>
      </div>
      {showFollowUp && <form className="follow-up-form" onSubmit={(event) => { event.preventDefault(); if (followUpTitle.trim()) createFollowUp.mutate(); }}>
        <span className="section-label">New follow-up task</span>
        <input autoFocus value={followUpTitle} onChange={(event) => setFollowUpTitle(event.target.value)} placeholder="Follow-up title" />
        <textarea value={followUpDescription} onChange={(event) => setFollowUpDescription(event.target.value)} placeholder="Description and expected outcome" rows={4} />
        {createFollowUp.error && <p className="error-message">{createFollowUp.error.message}</p>}
        <div><button type="button" className="button secondary compact" onClick={() => setShowFollowUp(false)}>Cancel</button><button className="button primary compact" disabled={!followUpTitle.trim() || createFollowUp.isPending}>{createFollowUp.isPending ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} Create follow-up</button></div>
      </form>}
      <details className="task-collapsible task-overview" open={!hasBeenExecuted}>
        <summary><span>Task details</span><small>Description, project, and ownership</small></summary>
        <div className="task-collapsible-content">
      {editingField === 'title' ? <input className="inline-title-editor" autoFocus value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={300}
        onBlur={() => { const title = editTitle.trim(); if (title && title !== item.title) update.mutate({ title }); else setEditTitle(item.title); setEditingField(null); }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = item.title; setEditTitle(item.title); event.currentTarget.blur(); } }} />
        : <h1 className="inline-editable" onClick={() => setEditingField('title')} title="Click to edit title">{item.title}</h1>}
      {detail.data.parentItem && <button className="parent-task-link" onClick={() => onOpenTask(detail.data!.parentItem!.id)}><span>Follow-up to</span><strong>{detail.data.parentItem.title}</strong></button>}
      <div className="detail-controls">{editingField === 'project' ? <input className="inline-project-editor" autoFocus value={editProjectName} onChange={(event) => setEditProjectName(event.target.value)} maxLength={200} placeholder="No project"
        onBlur={() => { const projectName = editProjectName.trim() || null; if (projectName !== item.projectName) update.mutate({ projectName }); setEditingField(null); }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = item.projectName ?? ''; setEditProjectName(item.projectName ?? ''); event.currentTarget.blur(); } }} />
        : <button className={`project-pill inline-editable ${item.projectName ? '' : 'empty'}`} onClick={() => setEditingField('project')} title="Click to edit project">{item.projectName || 'Add project'}</button>}<TaskClassificationSelect itemId={item.id} kind={item.classificationKind} /></div>

      <div className="detail-section">
        <span className="section-label">Description</span>
        {editingField === 'description' ? <textarea className="inline-description-editor" autoFocus value={editDescription} onChange={(event) => setEditDescription(event.target.value)} rows={7} maxLength={20_000}
          onBlur={() => { if (editDescription !== item.description) update.mutate({ description: editDescription }); setEditingField(null); }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.value = item.description; setEditDescription(item.description); event.currentTarget.blur(); } }} />
          : <p className={`inline-editable ${item.description ? '' : 'muted'}`} onClick={() => setEditingField('description')} title="Click to edit description">{item.description || 'No description has been added yet.'}</p>}
      </div>
      {update.error && <p className="error-message">Could not save changes: {update.error.message}</p>}

      <div className="detail-section">
        <span className="section-label">Owners</span>
        <div className="assignee-picker">
          {(['jeffrey', 'codex', 'claude'] as const).map((assignee) => (
            <button
              key={assignee}
              className={item.assignees.includes(assignee) ? 'selected' : ''}
              disabled={selfAssigned && assignee !== 'jeffrey'}
              title={selfAssigned && assignee !== 'jeffrey' ? SELF_ASSIGNED_OWNER_MESSAGE : undefined}
              onClick={() => toggleAssignee(assignee)}
            >
              {assignee === 'jeffrey' ? <User size={14} /> : <Bot size={14} />}
              {assignee}
            </button>
          ))}
        </div>
        {selfAssigned && <p className="assignee-exclusive-note muted">{SELF_ASSIGNED_OWNER_MESSAGE}</p>}
      </div>

      <div className="detail-section">
        <span className="section-label">Prerequisites</span>
        <p className="dependency-help muted">Tasks that must reach done or canceled before an agent can be dispatched here.</p>
        {dependencies.length > 0 ? <ul className="dependency-list">
          {dependencies.map((dependency) => (
            <li key={dependency.id} className={dependency.isOpen ? 'open' : 'satisfied'}>
              <button type="button" className="dependency-open" onClick={() => onOpenTask(dependency.id)} title={`Open ${dependency.title}`}>
                {dependency.isOpen ? <AlertTriangle size={12} /> : <Check size={12} />}
                <span>{dependency.title}</span>
              </button>
              <span className="dependency-status">{dependency.isOpen ? dependency.status.replace('_', ' ') : 'satisfied'}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove prerequisite ${dependency.title}`}
                disabled={update.isPending}
                onClick={() => setDependencies(dependencies.filter((entry) => entry.id !== dependency.id).map((entry) => entry.id))}
              ><X size={13} /></button>
            </li>
          ))}
        </ul> : <p className="muted dependency-empty">No prerequisites. This task can be dispatched on its own.</p>}
        <div className="dependency-search">
          <Search size={13} />
          <input
            value={dependencyQuery}
            onChange={(event) => setDependencyQuery(event.target.value)}
            placeholder="Search tasks to add as a prerequisite"
            aria-label="Search tasks to add as a prerequisite"
          />
        </div>
        {/* The server rejects cycles, but filtering the obvious ones out here keeps
            Jeffrey from discovering the rule through an error message. */}
        {(() => {
          if (!normalizedDependencyQuery) return null;
          const chosen = new Set(dependencies.map((dependency) => dependency.id));
          const candidates = (dependencyCandidates.data?.items ?? []).filter((candidate) => !chosen.has(candidate.id)
            && !(candidate.blockedBy ?? []).some((edge) => edge.id === item.id));
          if (dependencyCandidates.isLoading) return <p className="muted dependency-empty">Loading tasks…</p>;
          if (!candidates.length) return <p className="muted dependency-empty">No other tasks match.</p>;
          return <ul className="dependency-candidates">
            {candidates.slice(0, 8).map((candidate) => (
              <li key={candidate.id}>
                <button type="button" disabled={update.isPending} onClick={() => {
                  setDependencies([...dependencies.map((entry) => entry.id), candidate.id]);
                  setDependencyQuery('');
                }}>
                  <Plus size={12} />
                  <span>{candidate.title}</span>
                  <small>{candidate.projectName ?? 'Personal'}</small>
                </button>
              </li>
            ))}
          </ul>;
        })()}
      </div>

        </div>
      </details>

      <details className="detail-section task-collapsible execution-section" open={!hasBeenExecuted}>
        <summary><span>Agent execution</span><small>{hasBeenExecuted ? 'Already executed' : 'Model and execution controls'}</small></summary>
        <div className="task-collapsible-content">
        {hasBeenExecuted && <div className="task-execution-locked"><Check size={13} /><span><strong>Already executed</strong><small>This task cannot be executed again.</small></span></div>}
        {selfAssigned && <div className="task-execution-locked blocked"><User size={13} /><span><strong>Assigned to you</strong><small>{SELF_ASSIGNED_EXECUTION_MESSAGE}</small></span></div>}
        {openDependencies.length > 0 && <div className="task-execution-locked blocked"><AlertTriangle size={13} /><span><strong>Blocked by {openDependencies.length} prerequisite{openDependencies.length === 1 ? '' : 's'}</strong><small>{openDependencies.map((dependency) => dependency.title).join(', ')}</small></span></div>}
        <p className="execution-copy">Workbench will classify the task, choose the right agent, and either execute it directly or return an approval-ready decomposition for complex work.</p>
        {execute.error && <p className="error-message">{execute.error.message}</p>}
        <label>Model <ModelProfileSelect value={executionProfile} onChange={setExecutionProfile} /></label>
        <button className="button primary execute-button" onClick={() => execute.mutate()} disabled={hasBeenExecuted || selfAssigned || openDependencies.length > 0 || execute.isPending}
          title={hasBeenExecuted ? 'This task has already been executed.' : selfAssigned ? SELF_ASSIGNED_EXECUTION_MESSAGE : openDependencies.length > 0 ? 'Complete this task\u2019s prerequisites before dispatching an agent.' : undefined}>
          {execute.isPending ? <LoaderCircle className="spin" size={16} /> : selfAssigned ? <User size={16} /> : openDependencies.length > 0 ? <AlertTriangle size={16} /> : <Sparkles size={16} />}
          {hasBeenExecuted ? 'Already executed' : selfAssigned ? 'Assigned to you' : openDependencies.length > 0 ? 'Blocked by prerequisites' : 'Execute'}
        </button>
      </div>
      </details>

      {detail.data.runs.length > 0 && (
        <details className="detail-section task-collapsible runs-section" open>
          <summary><span>Agent runs</span><small>{detail.data.runs.length} run{detail.data.runs.length === 1 ? '' : 's'}</small></summary>
          <div className="task-collapsible-content">
          {detail.data.runs.map((run, runIndex) => (
            <article className="run-card" key={run.id}>
              <header>
                <span className={`run-status run-${run.status}`}>{run.status === 'running' && <LoaderCircle className="spin" size={11} />}{run.status === 'queued' && run.attempt > 0 ? `Retrying (attempt ${run.attempt + 1} of ${run.maxAttempts})…` : run.status}</span>
                <strong>{run.agent} · {run.kind}</strong>
                <time>{new Date(run.createdAt).toLocaleString()}</time>
                {(run.status === 'queued' || run.status === 'running') && <button className="cancel-run" onClick={() => cancelRun.mutate(run.id)}><X size={11} /> Cancel</button>}
                {runIndex === 0 && (run.status === 'failed' || run.status === 'canceled') && <button className="retry-run" onClick={() => retryRun.mutate(run.id)} disabled={retryRun.isPending}><RefreshCw size={11} /> Retry / continue</button>}
              </header>
              {run.instructions && <p className="run-prompt">{run.instructions}</p>}
              {run.status === 'running' && !run.conversationId && <div className="live-output-label"><span /> Live activity & reasoning summaries</div>}
              {run.output && run.status !== 'completed' && !run.conversationId && <pre aria-live="polite">{humanizeRunOutput(run.output)}</pre>}
              {run.model && <span className="model-badge" title={formatRunTelemetry(run)}>{run.model} · {formatRunBadge(run)}</span>}
              {run.status === 'completed' && run.output && <div className="run-summary"><span className="section-label">Agent summary</span><AgentMessageBody body={run.output} running={false} workItemId={item.id} /></div>}
              {run.error && <p className="error-message">{run.error}</p>}
              {run.conversationId && <button className="open-run-chat" onClick={() => onOpenConversation(run.conversationId!)}><MessageCircle size={13} /> Open execution chat</button>}
            </article>
          ))}
          </div>
        </details>
      )}

      {detail.data.executionPlan && (
        <div className="detail-section execution-plan">
          <span className="section-label">Approval required</span>
          <h3>{detail.data.executionPlan.summary}</h3>
          <ol>
            {detail.data.executionPlan.tasks.map((task, index) => <li key={`${task.title}-${index}`}><label><input type="checkbox" checked={selectedExecutionTaskIndexes.has(index)} onChange={() => setSelectedExecutionTaskIndexes((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{task.title}</strong><p>{task.description}</p></span></label></li>)}
          </ol>
          <div className="dialog-actions">
            <button className="button secondary" onClick={() => resolveExecutionPlan.mutate({ resolution: 'rejected' })}>Reject plan</button>
            <button className="button primary" disabled={selectedExecutionTaskIndexes.size === 0 || resolveExecutionPlan.isPending} onClick={() => setExecutionPlanArchivePromptOpen(true)}><Check size={15} /> Create {selectedExecutionTaskIndexes.size} selected</button>
          </div>
        </div>
      )}

      {executionPlanArchivePromptOpen && <FollowUpArchiveDialog count={selectedExecutionTaskIndexes.size} pending={resolveExecutionPlan.isPending} onClose={() => setExecutionPlanArchivePromptOpen(false)} onChoose={(archiveParent) => resolveExecutionPlan.mutate({ resolution: 'accepted', archiveParent })} />}
      {deleteTaskPromptOpen && <ConfirmationDialog title={`Delete “${item.title}”?`} description="This permanently deletes the task and cannot be undone." confirmLabel="Delete task" pending={lifecycle.isPending} onClose={() => setDeleteTaskPromptOpen(false)} onConfirm={() => lifecycle.mutate('delete')} />}

      <details className="detail-section task-collapsible relationships-section">
        <summary><span>Linked items & history</span><small>{detail.data.children.length + linkedTasks.length + detail.data.conversations.length + detail.data.artifacts.length + references.length} linked</small></summary>
        <div className="task-collapsible-content">
        {detail.data.children.length > 0 && (
          <div className="relationship-group">
            <span className="relationship-group-label">Follow-ups</span>
            {detail.data.children.map((child) => (
              <button key={child.id} className="relationship-item" onClick={() => onOpenTask(child.id)}>
                <span>{child.title}</span>
                {child.archivedAt && <em className="relationship-tag">archived</em>}
              </button>
            ))}
          </div>
        )}
        <div className="relationship-group">
          <span className="relationship-group-label">Linked tasks</span>
          {linkedTasks.map((linkedTask) => (
            <div className="relationship-item reference-item" key={linkedTask.id}>
              <button type="button" className="relationship-task-link" onClick={() => onOpenTask(linkedTask.id)}><span>{linkedTask.title}</span></button>
              <button type="button" className="icon-button" aria-label={`Remove linked task ${linkedTask.title}`} disabled={removeTaskLink.isPending} onClick={() => removeTaskLink.mutate(linkedTask.id)}><X size={12} /></button>
            </div>
          ))}
          {showAddTaskLink ? (
            <div className="reference-form">
              <input autoFocus value={taskLinkQuery} onChange={(event) => setTaskLinkQuery(event.target.value)} placeholder="Search tasks to link" aria-label="Search tasks to link" />
              {addTaskLink.error && <p className="error-message">Could not link task: {addTaskLink.error.message}</p>}
              {normalizedTaskLinkQuery && (taskLinkCandidateQuery.isLoading ? <p className="muted">Loading tasks…</p> : taskLinkCandidates.length ? <ul className="dependency-candidates">{taskLinkCandidates.slice(0, 8).map((candidate) => <li key={candidate.id}><button type="button" disabled={addTaskLink.isPending} onClick={() => addTaskLink.mutate(candidate.id)}><Plus size={12} /><span>{candidate.title}</span><small>{candidate.projectName ?? 'Personal'}</small></button></li>)}</ul> : <p className="muted">No other tasks match.</p>)}
              <div><button type="button" className="button secondary compact" onClick={() => { setTaskLinkQuery(''); setShowAddTaskLink(false); }}>Cancel</button></div>
            </div>
          ) : <button type="button" className="button secondary compact" onClick={() => setShowAddTaskLink(true)}><Plus size={13} /> Link another task</button>}
        </div>
        {detail.data.conversations.length > 0 && (
          <div className="relationship-group">
            <span className="relationship-group-label">Conversations</span>
            {detail.data.conversations.map((conversation) => (
              <button key={conversation.id} className="relationship-item" onClick={() => onOpenConversation(conversation.id)}>
                <MessageCircle size={13} />
                <span>{conversation.title}</span>
                {conversation.forkedFromConversationId && <em className="relationship-tag">fork</em>}
                {conversation.archivedAt && <em className="relationship-tag">archived</em>}
              </button>
            ))}
          </div>
        )}
        {detail.data.artifacts.length > 0 && (
          <div className="relationship-group">
            <span className="relationship-group-label">Documents & artifacts</span>
            {detail.data.artifacts.map((artifact) => (
              <a key={artifact.id} className="relationship-item" href={artifact.url} target="_blank" rel="noreferrer">
                <FileText size={13} />
                <span>{artifact.title}</span>
                <em className="relationship-tag">v{artifact.version}</em>
                {artifact.openCommentCount > 0 && <em className="relationship-tag warn">{artifact.openCommentCount} feedback</em>}
                <ArrowUpRight size={12} />
              </a>
            ))}
          </div>
        )}
        <div className="relationship-group">
          <span className="relationship-group-label">Add artifact</span>
          {showAddArtifactLink ? (
            <div className="reference-form">
              <input autoFocus value={artifactLinkQuery} onChange={(event) => setArtifactLinkQuery(event.target.value)} placeholder="Search unlinked artifacts" aria-label="Search unlinked artifacts" />
              {addArtifactLink.error && <p className="error-message">Could not link artifact: {addArtifactLink.error.message}</p>}
              {artifactLinkCandidateQuery.isLoading ? <p className="muted">Loading artifacts…</p> : normalizedArtifactLinkQuery && (artifactLinkCandidates.length ? <ul className="dependency-candidates">{artifactLinkCandidates.slice(0, 8).map((artifact) => <li key={artifact.id}><button type="button" disabled={addArtifactLink.isPending} onClick={() => addArtifactLink.mutate(artifact.id)}><FileText size={12} /><span>{artifact.title}</span><small>v{artifact.version}</small></button></li>)}</ul> : <p className="muted">No unlinked artifacts match.</p>)}
              <div><button type="button" className="button secondary compact" onClick={() => { setArtifactLinkQuery(''); setShowAddArtifactLink(false); }}>Cancel</button></div>
            </div>
          ) : <button type="button" className="button secondary compact" onClick={() => setShowAddArtifactLink(true)}><Plus size={13} /> Link an artifact</button>}
        </div>
        <div className="relationship-group">
          <span className="relationship-group-label">Linked references</span>
          {references.length === 0 && !showAddReference && <p className="muted">No Linear issues, pull requests, Slack threads, or documents linked yet.</p>}
          {references.map((reference) => (
            <div className="relationship-item reference-item" key={reference.id}>
              <ReferenceTypeIcon type={reference.type} />
              <a href={reference.url} target="_blank" rel="noreferrer">{reference.title}</a>
              {reference.source ? <em className="relationship-tag">source</em> : <button type="button" className="icon-button" aria-label="Remove reference" onClick={() => removeReference.mutate(reference.id)}><X size={12} /></button>}
            </div>
          ))}
          {showAddReference ? (
            <form className="reference-form" onSubmit={(event) => { event.preventDefault(); if (referenceUrl.trim()) addReference.mutate(); }}>
              <select value={referenceType} onChange={(event) => setReferenceType(event.target.value as WorkItemReferenceType)}>
                <option value="linear_issue">Linear issue</option>
                <option value="pull_request">Pull request</option>
                <option value="slack_thread">Slack thread</option>
                <option value="document">Document</option>
                <option value="other">Other</option>
              </select>
              <input autoFocus value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="https://…" type="url" />
              <input value={referenceTitle} onChange={(event) => setReferenceTitle(event.target.value)} placeholder="Title (optional)" />
              {addReference.error && <p className="error-message">{addReference.error.message}</p>}
              <div><button type="button" className="button secondary compact" onClick={() => setShowAddReference(false)}>Cancel</button><button className="button primary compact" disabled={!referenceUrl.trim() || addReference.isPending}>{addReference.isPending ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} Link</button></div>
            </form>
          ) : (
            <button type="button" className="button secondary compact" onClick={() => setShowAddReference(true)}><Link2 size={13} /> Link Linear, PR, Slack, or a document</button>
          )}
        </div>
        </div>
      </details>

      <details className="detail-section task-collapsible activity-section">
        {/* The decision count is the reason to open this section: it says up front
            that the routing, model, and fallback choices are recorded in here. */}
        <summary><span>Activity</span><small>{activity.length} event{activity.length === 1 ? '' : 's'}{decisionCount > 0 && ` · ${decisionCount} agent decision${decisionCount === 1 ? '' : 's'}`}</small></summary>
        <div className="task-collapsible-content">
        {activity.length === 0 ? <p className="muted">No activity yet.</p> : activity.map((entry) => (
          <div className={`activity${agentDecisionKinds.has(entry.kind) ? ' decision' : ''}`} key={entry.id}>
            <span className="activity-dot" />
            <div>
              <strong>{entry.actor}</strong> <span className="activity-kind">{activityKindLabel(entry.kind)}</span>{' '}
              <span className="activity-body">{entry.body}</span>
              <time>{new Date(entry.createdAt).toLocaleString()}</time>
            </div>
          </div>
        ))}
        </div>
      </details>
    </section>
  );
}

function DiscoveryNav({ active, onClick }: { active: boolean; onClick: () => void }) {
  const inbox = useQuery({ queryKey: ['discovery', 'pending'], queryFn: () => api.getDiscoveryInbox('pending'), refetchInterval: 5_000 });
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}><Search size={16} /> Discoveries <span>{inbox.data?.pendingCount ?? '…'}</span></button>;
}

function DiscoveryInboxView({ onOpenTask, onOpenStack }: { onOpenTask: (id: string) => void; onOpenStack: () => void }) {
  const queryClient = useQueryClient();
  const [inboxView, setInboxView] = useState<'pending' | 'reviewed'>('pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inbox = useQuery({ queryKey: ['discovery', inboxView], queryFn: () => api.getDiscoveryInbox(inboxView), refetchInterval: 2_000 });
  const activeTasks = useQuery({ queryKey: ['discovery-merge-targets'], queryFn: () => api.listWorkItems('active', '') });
  const scan = useMutation({ mutationFn: api.scanDiscovery, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['discovery'] }) });
  const resolveCandidate = useMutation({
    mutationFn: ({ candidate, action }: { candidate: DiscoveryCandidate; action: 'convert' | 'dismiss' | 'snooze' }) => api.resolveDiscovery(candidate.id, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
      void queryClient.invalidateQueries({ queryKey: ['work-item-counts'] });
    },
  });
  const bulkResolve = useMutation({
    mutationFn: (action: 'convert' | 'dismiss' | 'snooze') => api.bulkResolveDiscovery([...selected], action),
    onSuccess: () => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
      void queryClient.invalidateQueries({ queryKey: ['work-item-counts'] });
    },
  });
  const restore = useMutation({ mutationFn: api.restoreDiscovery, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['discovery'] }); } });
  const lastRun = inbox.data?.lastRun;
  return <section className="discovery-workspace">
    <header className="discovery-header">
      <div><span className="eyebrow">Morning review</span><h2>Discovered overnight</h2><p>Nothing enters your stack until you approve it.</p></div>
      <button className="button secondary compact" onClick={() => scan.mutate()} disabled={inbox.data?.running || scan.isPending}>
        {inbox.data?.running ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} {inbox.data?.running ? 'Scanning sources…' : 'Scan now'}
      </button>
    </header>
    <div className="discovery-status">
      <strong>{inbox.data?.pendingCount ?? 0} to review</strong>
      <span>{lastRun?.completedAt ? `Last scan ${new Date(lastRun.completedAt).toLocaleString()}` : 'No completed scan yet'}</span>
      {lastRun?.errors.map((error) => <span className="error-message" key={error}>{error}</span>)}
    </div>
    {inbox.data?.queueProposal && <div className="morning-proposal"><span><Sparkles size={15} /><strong>Morning stack proposal ready</strong><small>{inbox.data.queueProposal.rationale}</small></span><button className="button primary compact" onClick={onOpenStack}>Review reorder</button></div>}
    <div className="discovery-tabs"><button className={inboxView === 'pending' ? 'active' : ''} onClick={() => { setInboxView('pending'); setSelected(new Set()); }}>Pending <span>{inbox.data?.pendingCount ?? '…'}</span></button><button className={inboxView === 'reviewed' ? 'active' : ''} onClick={() => { setInboxView('reviewed'); setSelected(new Set()); }}>Reviewed <span>{inbox.data?.reviewedCount ?? '…'}</span></button></div>
    {inboxView === 'pending' && !!inbox.data?.candidates.length && <div className="discovery-bulkbar">
      <label><input type="checkbox" checked={selected.size === inbox.data.candidates.length} onChange={(event) => setSelected(event.target.checked ? new Set(inbox.data!.candidates.map((candidate) => candidate.id)) : new Set())} /> Select all</label>
      <span>{selected.size ? `${selected.size} selected` : 'Select items for bulk review'}</span>
      <button disabled={!selected.size || bulkResolve.isPending} onClick={() => bulkResolve.mutate('snooze')}>Tomorrow</button>
      <button disabled={!selected.size || bulkResolve.isPending} onClick={() => bulkResolve.mutate('dismiss')}>Dismiss</button>
      <button className="accept" disabled={!selected.size || bulkResolve.isPending} onClick={() => bulkResolve.mutate('convert')}>Add / update</button>
    </div>}
    <div className="discovery-list">
      {inbox.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading discoveries…</div>}
      {!inbox.isLoading && !inbox.data?.candidates.length && <div className="discovery-empty"><Search size={26} /><h3>{inboxView === 'pending' ? 'Inbox clear' : 'No reviewed discoveries'}</h3><p>{inboxView === 'pending' ? 'The 5:00 AM scan will put new signals here for review.' : 'Decisions you make in the inbox will appear here.'}</p></div>}
      {inboxView === 'reviewed' ? inbox.data?.candidates.map((candidate) => <article className="discovery-card reviewed" key={candidate.id}><div className="discovery-source"><label><span>{candidate.provider}</span><em className={`decision-${candidate.status}`}>{candidate.status}</em></label><time>{new Date(candidate.updatedAt).toLocaleString()}</time></div><h3>{candidate.title}</h3>{candidate.description && <p>{candidate.description}</p>}<div className="discovery-actions">{candidate.sourceUrl && <a className="button secondary compact" href={candidate.sourceUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> Source</a>}{candidate.workItemId && <button className="button secondary compact" onClick={() => onOpenTask(candidate.workItemId!)}>Open task</button>}{(candidate.status === 'dismissed' || candidate.status === 'snoozed') && <button className="button primary compact" disabled={restore.isPending} onClick={() => restore.mutate(candidate.id)}><RefreshCw size={13} /> Restore to inbox</button>}</div></article>) : inbox.data?.candidates.map((candidate) => <DiscoveryCard key={candidate.id} candidate={candidate} selected={selected.has(candidate.id)} tasks={activeTasks.data?.items ?? []}
        onSelected={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(candidate.id); else next.delete(candidate.id); return next; })}
        onResolve={(action, workItemId) => action === 'merge' ? api.resolveDiscovery(candidate.id, action, workItemId).then(() => { void queryClient.invalidateQueries({ queryKey: ['discovery'] }); }) : resolveCandidate.mutate({ candidate, action })} />)}
    </div>
  </section>;
}

function DiscoveryCard({ candidate, selected, tasks, onSelected, onResolve }: { candidate: DiscoveryCandidate; selected: boolean; tasks: WorkItem[]; onSelected: (checked: boolean) => void; onResolve: (action: 'convert' | 'dismiss' | 'snooze' | 'merge', workItemId?: string) => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [description, setDescription] = useState(candidate.description);
  const [mergeTarget, setMergeTarget] = useState('');
  const suggestedTask = tasks.find((task) => task.id === candidate.suggestedWorkItemId);
  const update = useMutation({ mutationFn: () => api.updateDiscovery(candidate.id, { title: title.trim(), description }), onSuccess: () => { setEditing(false); void queryClient.invalidateQueries({ queryKey: ['discovery'] }); } });
  return <article className={`discovery-card ${selected ? 'selected' : ''}`}>
    <div className="discovery-source"><label><input type="checkbox" checked={selected} onChange={(event) => onSelected(event.target.checked)} /><span>{candidate.provider}</span>{candidate.relevance === 2 && <em>Focus</em>}</label><time>{new Date(candidate.occurredAt ?? candidate.discoveredAt).toLocaleString()}</time></div>
    {editing ? <div className="discovery-editor"><input value={title} onChange={(event) => setTitle(event.target.value)} /><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} /><div><button className="button secondary compact" onClick={() => { setTitle(candidate.title); setDescription(candidate.description); setEditing(false); }}>Cancel</button><button className="button primary compact" disabled={!title.trim() || update.isPending} onClick={() => update.mutate()}><Check size={13} /> Save</button></div></div> : <><button className="discovery-copy" onClick={() => setEditing(true)} title="Edit before adding"><h3>{candidate.title}</h3>{candidate.description && <p>{candidate.description}</p>}</button>
    <div className="discovery-actions">
      {candidate.sourceUrl && <a className="button secondary compact" href={candidate.sourceUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> Source</a>}
      {suggestedTask ? <span className="discovery-match"><small>Already tracked as</small><strong>{suggestedTask.title}</strong><button className="button primary compact" onClick={() => onResolve('merge', suggestedTask.id)}>Add update</button></span> : !!tasks.length && <span className="discovery-merge"><select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Merge into task…</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><button className="button secondary compact" disabled={!mergeTarget} onClick={() => onResolve('merge', mergeTarget)}>Merge</button></span>}
      <button className="button secondary compact" onClick={() => onResolve('snooze')}>Tomorrow</button>
      <button className="button secondary compact" onClick={() => onResolve('dismiss')}>Dismiss</button>
      <button className={`button ${suggestedTask ? 'secondary' : 'primary'} compact`} onClick={() => onResolve('convert')}>{suggestedTask ? 'Add separately' : 'Add to stack'}</button>
    </div></>}
  </article>;
}

export function App() {
  const queryClient = useQueryClient();
  const route = useRoute();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showProposalDetail, setShowProposalDetail] = useState(false);
  // A task URL names the task, never a stack, so a link keeps working after the
  // task moves. The queue shown behind an open task is resolved from the task.
  const [taskStack, setTaskStack] = useState<StackName>('active');
  const [resolvedTaskId, setResolvedTaskId] = useState<string | null>(null);
  const [conversationNavigationVersion, setConversationNavigationVersion] = useState(0);
  const [pendingTaskNavigation, setPendingTaskNavigation] = useState<string | null>(null);
  const selectedId = route.name === 'task' ? route.taskId : null;
  const agentConversationId = route.name === 'conversations' ? route.conversationId : null;
  const view = route.name === 'stack' ? route.stack : route.name === 'task' ? taskStack : route.name === 'conversations' ? 'context' : route.name;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isCompactNav, setIsCompactNav] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 820px)');
    const handleChange = (event: MediaQueryListEvent) => setIsCompactNav(event.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const queueView = view === 'archive' ? 'archive' : view === 'workbench' ? 'workbench' : 'active';
  const items = useInfiniteQuery({
    queryKey: ['work-items', queueView],
    queryFn: ({ pageParam }) => api.listWorkItems(queueView, '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: view === 'active' || view === 'workbench' || view === 'archive',
  });
  const workItemCounts = useQuery({ queryKey: ['work-item-counts'], queryFn: api.getWorkItemCounts, refetchInterval: 1_500 });
  const unreadConversationCount = useQuery({ queryKey: ['conversation-unread-count'], queryFn: api.getUnreadConversationCount, refetchInterval: 1_500 });
  const notificationConversations = useQuery({ queryKey: ['notification-conversations'], queryFn: () => api.listSharedConversations('active'), refetchInterval: 1_000 });
  const previousConversationStates = useRef<Map<string, SharedConversation['state']> | null>(null);
  const syncedConversationId = useRef<string | null>(route.name === 'conversations' ? route.conversationId : null);
  function openConversation(conversationId: string) {
    navigate({ name: 'conversations', conversationId });
  }
  function handleConversationSelected(conversationId: string | null) {
    syncedConversationId.current = conversationId;
    // Landing on the console picks a conversation for you; replacing that entry
    // keeps one back press enough to leave the console again.
    navigate({ name: 'conversations', conversationId }, { replace: route.name === 'conversations' && route.conversationId === null });
  }
  useEffect(() => {
    if (route.name !== 'conversations' || route.conversationId === syncedConversationId.current) return;
    // The address changed from outside the workspace — a link, a notification,
    // or the back button — so remount it on the conversation the URL names.
    syncedConversationId.current = route.conversationId;
    setConversationNavigationVersion((current) => current + 1);
  }, [route]);
  useEffect(() => {
    if (route.name === 'stack') setTaskStack(route.stack);
  }, [route]);
  useEffect(() => {
    if (route.name !== 'task' || resolvedTaskId === route.taskId) return;
    const taskId = route.taskId;
    let canceled = false;
    void queryClient.fetchQuery({ queryKey: ['work-item', taskId], queryFn: () => api.getWorkItem(taskId) })
      .then(({ item }) => {
        if (canceled) return;
        setTaskStack(item.archivedAt ? 'archive' : item.stack === 'workbench' ? 'workbench' : 'active');
        setResolvedTaskId(taskId);
      })
      .catch(() => {
        // A dead task link still renders the detail panel, which reports the
        // failure in place; this only stops the stack lookup from retrying.
        if (!canceled) setResolvedTaskId(taskId);
      });
    return () => { canceled = true; };
  }, [queryClient, resolvedTaskId, route]);
  useEffect(() => {
    const conversations = notificationConversations.data?.conversations;
    if (!conversations) return;
    const next = new Map(conversations.map((conversation) => [conversation.id, conversation.state]));
    const previous = previousConversationStates.current;
    previousConversationStates.current = next;
    if (!previous) return;
    for (const conversation of conversations) {
      if (previous.get(conversation.id) !== 'working' || conversation.state === 'working') continue;
      const conversationIsOpen = view === 'context' && agentConversationId === conversation.id;
      const linkedTaskIsOpen = (view === 'active' || view === 'workbench' || view === 'archive') && selectedId === conversation.workItemId;
      if (conversationIsOpen || linkedTaskIsOpen) continue;
      const openNotificationConversation = () => openConversation(conversation.id);
      if (conversation.state === 'needs_attention') {
        toast.error('Agent needs your attention', { description: conversation.title, duration: 0, action: openNotificationConversation, actionLabel: 'Open conversation' });
      } else if (conversation.state === 'waiting_approval') {
        toast.info('Agent has follow-ups for review', { description: conversation.title, duration: 0, action: openNotificationConversation, actionLabel: 'Review suggestions' });
      } else if (conversation.state === 'finished') {
        toast.success('Agent finished', { description: conversation.title, duration: 8_000, action: openNotificationConversation, actionLabel: 'Open conversation' });
      }
    }
  }, [agentConversationId, notificationConversations.data?.conversations, selectedId, view]);
  const queueAgentActivity = useQuery({ queryKey: ['shared-message-activity'], queryFn: () => api.listSharedMessages(), refetchInterval: 1_000 });
  const queueAgentStatusSignature = (queueAgentActivity.data?.messages ?? []).map((message) => `${message.id}:${message.status}`).join('|');
  useEffect(() => {
    if (queueAgentStatusSignature) void queryClient.invalidateQueries({ queryKey: ['work-items'] });
  }, [queryClient, queueAgentStatusSignature]);
  const reorder = useMutation({
    mutationFn: api.reorderQueue,
    onError: (error) => toastError('Could not save the new order. The list will reset.', error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['work-items'] }),
  });
  const resolveProposal = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: 'accepted' | 'rejected' }) => api.resolveQueueProposal(id, resolution),
    onSuccess: ({ proposal }, variables) => {
      navigate({ name: 'stack', stack: proposal.stack === 'workbench' ? 'workbench' : 'active' });
      toast.success(variables.resolution === 'accepted' ? 'Proposed stack accepted.' : 'Proposed stack rejected.');
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
    onError: (error) => toastError('Could not update the proposal.', error),
  });
  const planQueue = useMutation({
    mutationFn: (stack: 'attention' | 'workbench') => api.planQueue(stack),
    onSuccess: () => {
      toast.success('Stack reordered.');
      queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
    onError: (error) => toastError('Could not reorder the stack.', error),
  });
  const bulkUpdate = useMutation({
    mutationFn: api.bulkUpdateWorkItems,
    onSuccess: (result) => {
      const applied = new Set(result.appliedIds);
      const conflicts = result.conflicts;
      setSelectedIds((current) => new Set([...current].filter((id) => !applied.has(id))));
      if (conflicts.length) toast.error(`${conflicts.length} task${conflicts.length === 1 ? '' : 's'} could not be updated: ${conflicts.map((entry) => entry.reason.replace('_', ' ')).join(', ')}`);
      else toast.success(`${applied.size} task${applied.size === 1 ? '' : 's'} updated.`);
      void Promise.all([queryClient.invalidateQueries({ queryKey: ['work-items'] }), queryClient.invalidateQueries({ queryKey: ['work-item-counts'] })]);
    },
    onError: (error) => toastError('Could not update the selected tasks.', error),
  });
  const filtered = useMemo(() => items.data?.pages.flatMap((page) => page.items) ?? [], [items.data?.pages]);
  const { renderedItems, renderedRows } = useMemo(() => {
    const stackView = view === 'active' || view === 'workbench';
    const progress = stackView ? filtered.filter((item) => item.status === 'in_progress') : [];
    const attention = stackView ? filtered.filter((item) => item.status !== 'in_progress') : [];
    const taskRows = (section: 'progress' | 'attention' | 'archive', sectionItems: WorkItem[]) => sectionItems.map((item) => ({ type: 'item' as const, id: item.id, item, group: section }));
    return {
      renderedItems: stackView ? [...progress, ...attention] : filtered,
      renderedRows: stackView ? [
        { type: 'header' as const, id: 'in-progress-header', label: 'In progress', count: progress.length, group: 'progress' as const },
        ...taskRows('progress', progress),
        { type: 'header' as const, id: 'attention-header', label: 'Attention stack', count: attention.length, group: 'attention' as const },
        ...taskRows('attention', attention),
      ] : taskRows('archive', filtered),
    };
  }, [filtered, view]);
  useEffect(() => {
    if (route.name !== 'task' || !pendingTaskNavigation || pendingTaskNavigation !== route.taskId) return;
    // Wait until the stack behind the task is known: before that the queue can
    // still be listing another stack, where the task is legitimately missing.
    if (pendingTaskNavigation !== resolvedTaskId) return;
    const resolvedDetail = queryClient.getQueryData<WorkItemDetail>(['work-item', pendingTaskNavigation]);
    const resolvedStack = resolvedDetail?.item.archivedAt ? 'archive' : resolvedDetail?.item.stack === 'workbench' ? 'workbench' : 'active';
    // React can commit the detail lookup before the infinite query behind it has
    // switched stacks. Never judge membership against that stale list.
    if (resolvedDetail && queueView !== resolvedStack) return;
    const target = filtered.find((item) => item.id === pendingTaskNavigation);
    if (target) {
      window.requestAnimationFrame(() => {
        // The route transition renders the stack and its sortable cards in
        // separate commits. Wait for the next frame so this also works when a
        // task was opened from a conversation, artifact, or task relationship.
        window.requestAnimationFrame(() => {
          queueScrollRef.current
            ?.querySelector<HTMLElement>(`[data-work-item-id="${pendingTaskNavigation}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
      setPendingTaskNavigation(null);
      return;
    }
    if (items.hasNextPage) {
      if (!items.isFetchingNextPage) void items.fetchNextPage();
      return;
    }
    // The task detail endpoint is authoritative. A card can legitimately be
    // absent from the loaded list (filter changes, lifecycle transitions, or a
    // newly scored page); failing to center it must not turn successful task
    // navigation into an error.
    setPendingTaskNavigation(null);
  }, [filtered, items, pendingTaskNavigation, queryClient, queueView, resolvedTaskId, route]);
  useEffect(() => {
    // On tall mobile viewports the first page can be shorter than the
    // container, so it never becomes scrollable and onScroll-driven
    // pagination never fires, leaving a permanent blank gap below the list.
    const element = queueScrollRef.current;
    if (!element || !items.hasNextPage || items.isFetchingNextPage) return;
    if (element.scrollHeight <= element.clientHeight) void items.fetchNextPage();
  }, [renderedRows.length, items.hasNextPage, items.isFetchingNextPage, items]);

  function openTaskFromConversation(taskId: string) {
    setPendingTaskNavigation(taskId);
    navigate({ name: 'task', taskId });
  }

  function selectTaskInStack(taskId: string) {
    // The stack on screen already contains this task, so the URL can change
    // without waiting to be told which stack the task belongs to.
    setResolvedTaskId(taskId);
    setPendingTaskNavigation(taskId);
    navigate({ name: 'task', taskId });
  }

  function revealCreatedTask(item: WorkItem) {
    // Creation can place a task anywhere in the scored stack, including a page
    // that has not been loaded yet. The existing pending-navigation effect will
    // fetch forward until it can center the new card.
    setTaskStack(item.stack === 'workbench' ? 'workbench' : 'active');
    setResolvedTaskId(item.id);
    setPendingTaskNavigation(item.id);
    navigate({ name: 'task', taskId: item.id });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || items.isFetchingNextPage) return;
    const current = filtered;
    const activeItem = current.find((item) => item.id === active.id);
    const overItem = current.find((item) => item.id === over.id);
    if (!activeItem || !overItem || (activeItem.status === 'in_progress') !== (overItem.status === 'in_progress')) return;
    const progress = current.filter((item) => item.status === 'in_progress');
    const attention = current.filter((item) => item.status !== 'in_progress');
    const group = activeItem.status === 'in_progress' ? progress : attention;
    const oldIndex = group.findIndex((item) => item.id === active.id);
    const newIndex = group.findIndex((item) => item.id === over.id);
    const moved = arrayMove(group, oldIndex, newIndex);
    const next = moved[newIndex + 1];
    const previous = moved[newIndex - 1];
    if (next) reorder.mutate({ itemId: String(active.id), beforeId: next.id });
    else if (previous) reorder.mutate({ itemId: String(active.id), afterId: previous.id });
  }

  function handleQueueKeyDown(event: KeyboardEvent<HTMLDivElement>, itemId: string) {
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea, button, a, [contenteditable="true"]')) return;
    const visible = renderedRows.filter((row): row is Extract<typeof renderedRows[number], { type: 'item' }> => row.type === 'item').map((row) => row.item);
    const currentIndex = visible.findIndex((item) => item.id === itemId);
    if (event.key === 'Enter') { event.preventDefault(); selectTaskInStack(itemId); return; }
    if (event.key === ' ') { event.preventDefault(); setSelectedIds((current) => { const next = new Set(current); if (next.has(itemId)) next.delete(itemId); else if (next.size < 200) next.add(itemId); return next; }); return; }
    if (event.key === 'Escape') { setSelectedIds(new Set()); return; }
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : event.key === 'ArrowDown' ? currentIndex + 1 : event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex;
    if (nextIndex !== currentIndex && visible[nextIndex]) { event.preventDefault(); setFocusedId(visible[nextIndex].id); document.querySelector<HTMLElement>(`[data-work-item-id="${visible[nextIndex].id}"]`)?.focus(); }
  }

  return (
    <div className="app-shell">
      <Toaster />
      <aside
        id="primary-nav"
        className="sidebar"
      >
        <div className="brand">
          <span className="brand-mark">W</span>
          <span>Workbench</span>
        </div>
        <nav onClick={(event) => {
          // A pointer-clicked tab retains focus by default, which keeps the
          // :focus-within rail expanded after the pointer leaves it. Preserve
          // keyboard focus, but release pointer focus once navigation starts.
          if (event.detail > 0) (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.blur();
        }}>
          <button className={`nav-item ${view === 'active' ? 'active' : ''}`} onClick={() => { navigate({ name: 'stack', stack: 'active' }); setMobileNavOpen(false); }}><Command size={16} /> Attention stack <span>{workItemCounts.data?.active ?? '…'}</span></button>
          <button className={`nav-item ${view === 'workbench' ? 'active' : ''}`} onClick={() => { navigate({ name: 'stack', stack: 'workbench' }); setMobileNavOpen(false); }}><Wrench size={16} /> Workbench <span>{workItemCounts.data?.workbench ?? '…'}</span></button>
          <DiscoveryNav active={view === 'discovery'} onClick={() => { navigate({ name: 'discovery' }); setMobileNavOpen(false); }} />
          <button className={`nav-item ${view === 'context' ? 'active' : ''}`} onClick={() => { navigate({ name: 'conversations', conversationId: null }); setMobileNavOpen(false); }}><MessageCircle size={16} /> Agent console <span>{unreadConversationCount.data?.count ?? '…'}</span></button>
          <div id="mobile-nav-more" className="mobile-nav-secondary" aria-label="More destinations">
            <button className={`nav-item ${view === 'archive' ? 'active' : ''}`} onClick={() => { navigate({ name: 'stack', stack: 'archive' }); setMobileNavOpen(false); }}><Archive size={16} /> Archive <span>{workItemCounts.data?.archive ?? '…'}</span></button>
            <ArtifactNav active={view === 'artifacts'} onClick={() => { navigate({ name: 'artifacts' }); setMobileNavOpen(false); }} />
            <InsightsNav active={view === 'insights'} onClick={() => { navigate({ name: 'insights' }); setMobileNavOpen(false); }} />
            <button className="nav-item" onClick={() => { setShowSources(true); setMobileNavOpen(false); }}><Cloud size={16} /> Sources</button>
          </div>
          {isCompactNav && (
            <button className={`nav-item mobile-nav-more ${mobileNavOpen || ['archive', 'artifacts', 'insights'].includes(view) ? 'active' : ''}`} aria-controls="mobile-nav-more" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}><MoreHorizontal size={18} /> More</button>
          )}
        </nav>
      </aside>

      {view === 'context' ? <SharedWorkspace key={`conversation-${conversationNavigationVersion}`} initialConversationId={agentConversationId} onSelectConversation={handleConversationSelected} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} /> : view === 'artifacts' ? <ArtifactLibraryView onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenConversation={openConversation} /> : view === 'insights' ? <InsightsView /> : view === 'discovery' ? <DiscoveryInboxView onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenStack={() => navigate({ name: 'stack', stack: 'active' })} /> : <><main className="queue-panel">
        <header className="queue-header">
          <div><span className="eyebrow">{view === 'active' ? 'Focus' : view === 'workbench' ? 'Build' : 'History'}</span><h2>{view === 'active' ? 'Attention stack' : view === 'workbench' ? 'Workbench roadmap' : 'Archive'}</h2></div>
          <div className="header-actions">
            {(view === 'active' || view === 'workbench') && <>
            <button className="button secondary compact" onClick={() => planQueue.mutate(view === 'workbench' ? 'workbench' : 'attention')} disabled={planQueue.isPending}>
              {planQueue.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} {planQueue.isPending ? 'Reordering…' : 'Reorder stack'}
            </button>
            <button className="button primary compact" onClick={() => setShowCreate(true)}><Plus size={15} /> New</button>
            </>}
          </div>
        </header>
        {selectedIds.size > 0 && <div className="queue-bulkbar" role="toolbar" aria-label="Bulk task actions"><span>{selectedIds.size} selected</span><button onClick={() => bulkUpdate.mutate({ action: view === 'archive' ? 'restore' : 'archive', ids: [...selectedIds] })} disabled={bulkUpdate.isPending}>{view === 'archive' ? 'Restore' : 'Archive'}</button><button onClick={() => setSelectedIds(new Set())}>Clear</button>{(view === 'active' || view === 'workbench') && <small>Changing projects no longer moves tasks between Attention and Workbench.</small>}</div>}
        {items.data?.pages[0]?.proposal && (
          <div className="proposal-banner">
            <div className="proposal-copy"><Sparkles size={15} /><span><strong>Review proposed order</strong><small>{items.data.pages[0].proposal.rationale}</small></span></div>
            <div className="proposal-actions">
              <button onClick={() => setShowProposalDetail((current) => !current)}>{showProposalDetail ? 'Hide changes' : 'Show changes'}</button>
              <button className="proposal-revert" onClick={() => resolveProposal.mutate({ id: items.data!.pages[0].proposal!.id, resolution: 'rejected' })}>Revert</button>
              <button className="accept" onClick={() => resolveProposal.mutate({ id: items.data!.pages[0].proposal!.id, resolution: 'accepted' })}>Keep order</button>
            </div>
          </div>
        )}
        {showProposalDetail && items.data?.pages[0]?.proposal && (
          <div className="explain-panel">
            <QueueExplanationList explanations={items.data.pages[0].proposal.explanations} />
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div ref={queueScrollRef} className="queue-list" role="list" aria-label={view === 'archive' ? 'Archived tasks' : view === 'workbench' ? 'Workbench roadmap' : 'Work stacks'} onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 500 && items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
        }}>
          {items.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading queue…</div>}
          {items.isError && <div className="list-state error-message">Could not load work items. <button className="button secondary compact" onClick={() => items.refetch()}>Retry</button></div>}
          {!items.isLoading && !items.isError && filtered.length === 0 && <div className="list-state">{view === 'active' ? 'No work items yet. Add one or connect Linear.' : view === 'workbench' ? 'No Workbench roadmap tasks yet.' : 'No archived tasks.'}</div>}
          <SortableContext items={(view === 'active' || view === 'workbench') && !items.hasNextPage && selectedIds.size === 0 ? renderedItems.map((item) => item.id) : []} strategy={verticalListSortingStrategy}>
            <div className="queue-rows">
              {renderedRows.map((rendered, index) => rendered.type === 'header'
                ? <div key={rendered.id} className={`stack-header stack-header-${rendered.group}`}><span>{rendered.label}</span><strong>{rendered.count}</strong></div>
                : <div key={rendered.id} className={`task-group-row task-group-${rendered.group}`}><TaskQueueItem item={rendered.item} index={index} selected={selectedIds.has(rendered.item.id)} focused={(focusedId ?? renderedItems[0]?.id) === rendered.item.id} draggable={(view === 'active' || view === 'workbench') && !items.isFetchingNextPage && !items.hasNextPage && selectedIds.size === 0} onSelect={() => selectTaskInStack(rendered.item.id)} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onFocus={() => setFocusedId(rendered.item.id)} onKeyDown={(event) => handleQueueKeyDown(event, rendered.item.id)} /></div>)}
            </div>
          </SortableContext>
          {items.isFetchingNextPage && <div className="page-state"><LoaderCircle className="spin" size={14} /> Loading more…</div>}
          {!items.hasNextPage && filtered.length > 0 && <div className="page-state">All {items.data?.pages[0]?.totalCount ?? filtered.length} items loaded</div>}
        </div>
        </DndContext>
      </main>

      {selectedId ? <TaskDetail key={selectedId} id={selectedId} onClose={() => navigate({ name: 'stack', stack: taskStack })} onCreated={revealCreatedTask} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenConversation={openConversation} /> : <section className="detail-empty"><Sparkles /><h2>Choose your next move</h2><p>Select an item or add something new.</p></section>}</>}
      {showCreate && <CreateTask onClose={() => setShowCreate(false)} onCreated={revealCreatedTask} defaultProjectName={view === 'workbench' ? 'Workbench' : ''} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
    </div>
  );
}
