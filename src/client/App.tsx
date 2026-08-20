import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowUpRight,
  ArrowLeft,
  AlertTriangle,
  Bot,
  Check,
  Archive,
  Cloud,
  Command,
  LoaderCircle,
  Menu,
  MessageCircle,
  MessageSquarePlus,
  GripVertical,
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
import { type CSSProperties, type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Assignee, BrokerConnection, BrokerSourceId, DiscoveryCandidate, ExecutionPlan, WorkItem, WorkItemDetail } from '../shared/contracts';
import { api } from './api';
import { hideWorkbenchControlBlocks, humanizeRunOutput } from './run-output';

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

function selectBalancedVisibleAgent(messages: Array<{ author: string }>): 'codex' | 'claude' {
  const codexCount = messages.filter((message) => message.author === 'codex').length;
  const claudeCount = messages.filter((message) => message.author === 'claude').length;
  return codexCount <= claudeCount ? 'codex' : 'claude';
}

function AssigneeIcon({ assignee }: { assignee: Assignee }) {
  const Icon = assignee === 'jeffrey' ? User : Bot;
  return (
    <span className={`assignee-chip assignee-${assignee}`} title={assignee}>
      <Icon size={12} /> {assignee}
    </span>
  );
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

function SortableQueueItem({ item, index, selected, draggable, onSelect }: { item: WorkItem; index: number; selected: boolean; draggable: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !draggable });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const isHumanOnly = !item.agentOutcome && item.assignees.length === 1 && item.assignees[0] === 'jeffrey';
  return <div ref={setNodeRef} style={style} role="listitem" tabIndex={0} className={`queue-item ${item.agentOutcome ? `outcome-${item.agentOutcome}` : ''} ${isHumanOnly ? 'human-only' : ''} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`} onClick={onSelect} onKeyDown={(event) => event.key === 'Enter' && onSelect()}>
    {draggable ? <button className="drag-handle" onClick={(event) => event.stopPropagation()} aria-label={`Reorder ${item.title}`} {...attributes} {...listeners}><GripVertical size={15} /></button> : <span className="rank">{String(index + 1).padStart(2, '0')}</span>}
    <span className="item-copy">
      <strong>{item.title}</strong>
      <span className="item-meta"><span>{item.sourceIdentifier ?? 'Manual'} · {item.projectName ?? 'Personal'}</span></span>
      {isHumanOnly && <span className="human-only-marker"><User size={11} /> Your task</span>}
      {item.agentOutcome && <span className={`agent-outcome agent-outcome-${item.agentOutcome}`}>
        {item.agentOutcome === 'needs_attention' ? <AlertTriangle size={11} /> : item.agentOutcome === 'follow_ups' ? <Sparkles size={11} /> : <Check size={11} />}
        {item.agentOutcome === 'needs_attention' ? 'Needs attention' : item.agentOutcome === 'follow_ups' ? 'Follow-ups recommended' : 'Finished'}
      </span>}
      {item.archivedAt && <span className={`archive-meta ${item.completionStatus}`}>{item.completionStatus === 'completed' ? 'Completed' : 'Incomplete'} · {new Date(item.archivedAt).toLocaleDateString()}</span>}
      {item.assignees.length > 0 && <span className="assignees">{item.assignees.map((assignee) => <AssigneeIcon key={assignee} assignee={assignee} />)}</span>}
    </span>
  </div>;
}

function CreateTask({ onClose, defaultProjectName = '' }: { onClose: () => void; defaultProjectName?: string }) {
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
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
  const disconnect = useMutation({
    mutationFn: () => api.disconnectSource(provider === 'atlassian' ? 'confluence' : 'github'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-connections'] }),
  });
  const mcpConnect = useMutation({
    mutationFn: async () => {
      const popup = window.open('about:blank', `workbench-${provider}-oauth`, 'popup,width=720,height=760');
      if (!popup) throw new Error('Popup blocked. Allow popups for Workbench and try again.');
      popup.document.write('<title>Connecting MCP</title><body style="margin:0;background:#10100f;color:#ddd;font:16px system-ui;display:grid;place-items:center;min-height:100vh">Preparing secure MCP authorization…</body>');
      try { const { url } = await api.startMcpOAuth('confluence'); popup.location.replace(url); } catch (error) {
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
  const disabled = connection.state === 'disabled';
  const canAuthorize = provider === 'atlassian';
  return <div className={`connection-card ${connected ? 'connected' : ''} ${disabled ? 'unavailable' : ''}`}>
    <div className="connection-summary"><span><strong>{connection.name}</strong><small>{connection.detail}</small></span>
      {canAuthorize && connected ? <button className="button secondary compact" onClick={() => disconnect.mutate()}>Disconnect</button> : canAuthorize ? <button className="button secondary compact" onClick={() => setOpen((value) => !value)}>{open ? 'Cancel' : 'Connect MCP'}</button> : <span className="mcp-required">{disabled ? 'Awaiting IT approval' : connected ? 'Connected' : 'Not connected'}</span>}
    </div>
    <div className="connection-meta">{connection.host === 'workbench' ? 'Workbench' : 'Managed connector'}<span>·</span>{connection.capabilities.map((capability) => capability.replace('_', ' ')).join(' · ') || 'Unavailable'}</div>
    {connection.lastError && <p className="error-message">{connection.lastError}</p>}
    {open && canAuthorize && <div className="connection-form mcp-connection-form">
      <button className="button primary" onClick={() => mcpConnect.mutate()} disabled={mcpConnect.isPending}>{mcpConnect.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Authorize MCP</button>
      {mcpConnect.error && <p className="error-message">Connection failed: {mcpConnect.error.message}</p>}
    </div>}
  </div>;
}

function SourcesDialog({ onClose }: { onClose: () => void }) {
  const connections = useQuery({ queryKey: ['source-connections'], queryFn: api.listSourceConnections });
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

export function SharedWorkspace({ initialConversationId, onOpenTask }: { initialConversationId?: string | null; onOpenTask?: (taskId: string) => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [dispatchTo, setDispatchTo] = useState<'both' | 'codex' | 'claude'>('codex');
  const dispatchInitializedConversationId = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null);
  const [conversationView, setConversationView] = useState<'active' | 'archive'>('active');
  const [files, setFiles] = useState<File[]>([]);
  const [railOpen, setRailOpen] = useState(false);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const [proposedPlan, setProposedPlan] = useState<ExecutionPlan | null>(null);
  const [proposedPlanConversationId, setProposedPlanConversationId] = useState<string | null>(null);
  const [selectedPlanTaskIndexes, setSelectedPlanTaskIndexes] = useState<Set<number>>(new Set());
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
  const selectedConversation = conversationList.find((conversation) => conversation.id === conversationId);
  const linkedWorkItemId = selectedConversation?.workItemId ?? null;
  const linkedWorkItem = useQuery({ queryKey: ['work-item', linkedWorkItemId], queryFn: () => api.getWorkItem(linkedWorkItemId!), enabled: Boolean(linkedWorkItemId), refetchInterval: 1_000 });
  useEffect(() => {
    if (initialConversationId) setConversationId(initialConversationId);
  }, [initialConversationId]);
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
      return api.createSharedMessage(conversationId!, body, dispatchTo, attachments);
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
      setBody(''); setFiles([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        linkedWorkItemId ? queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }) : Promise.resolve(),
      ]);
    },
    onError: (_error, _variables, context) => {
      if (linkedWorkItemId && context?.previous) queryClient.setQueryData(['work-item', linkedWorkItemId], context.previous);
    },
  });
  const createConversation = useMutation({
    mutationFn: () => api.createSharedConversation(),
    onSuccess: async ({ conversation }) => { setConversationId(conversation.id); await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }); },
  });
  const deleteConversation = useMutation({
    mutationFn: api.deleteSharedConversation,
    onSuccess: async () => { setConversationId(null); await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }); },
  });
  const archiveConversation = useMutation({
    mutationFn: api.archiveSharedConversation,
    onSuccess: async () => { setConversationId(null); await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }); },
  });
  const restoreConversation = useMutation({
    mutationFn: api.restoreSharedConversation,
    onSuccess: async () => { setConversationId(null); await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }); },
  });
  const forkConversation = useMutation({
    mutationFn: api.forkSharedConversation,
    onSuccess: async ({ conversation }) => { setConversationView('active'); setConversationId(conversation.id); await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }); },
  });
  const cancelReply = useMutation({
    mutationFn: api.cancelSharedReply,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] }),
  });
  const updateConversationOwner = useMutation({
    mutationFn: (target: 'both' | 'codex' | 'claude') => {
      const keepJeffrey = linkedWorkItem.data?.item.assignees.includes('jeffrey') ? ['jeffrey' as const] : [];
      const agents = target === 'both' ? ['codex' as const, 'claude' as const] : [target];
      return api.updateWorkItem(linkedWorkItemId!, { assignees: [...keepJeffrey, ...agents] });
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
    mutationFn: (resolution: 'accepted' | 'rejected') => api.resolveExecutionPlan(proposedPlan!.id, resolution, resolution === 'accepted' ? [...selectedPlanTaskIndexes] : undefined),
    onSuccess: async () => { setProposedPlan(null); setProposedPlanConversationId(null); await Promise.all([queryClient.invalidateQueries({ queryKey: ['work-items'] }), queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] })]); },
  });
  const latestMessageLength = messages.data?.messages.at(-1)?.body.length ?? 0;
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
    if ((body.trim() || files.length) && conversationId && !send.isPending) send.mutate();
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if ((body.trim() || files.length) && conversationId && !send.isPending) send.mutate();
  }

  return (
    <main className={`shared-workspace ${railOpen ? 'rail-open' : ''}`}>
      <button type="button" className="rail-scrim" aria-label="Close conversation list" onClick={() => setRailOpen(false)} />
      <aside id="conversation-rail" className="conversation-rail" aria-label="Conversations">
        <header><span className="eyebrow">Conversations</span><div className="conversation-header-actions"><button className="icon-button" onClick={() => createConversation.mutate()} aria-label="New conversation"><Plus size={15} /></button></div></header>
        <div className="conversation-view-tabs"><button className={conversationView === 'active' ? 'active' : ''} onClick={() => { setConversationView('active'); setConversationId(null); }}>Active</button><button className={conversationView === 'archive' ? 'active' : ''} onClick={() => { setConversationView('archive'); setConversationId(null); }}>Archive</button></div>
        <div ref={conversationScrollRef} className="conversation-tabs">
          <div className="virtual-list" style={{ height: conversationVirtualizer.getTotalSize() }}>
            {displayedConversationRows.map((row) => { const conversation = conversationList[row.index]; const isActive = conversation.isActive || activeConversationIds.has(conversation.id); return <div key={conversation.id} ref={conversationVirtualizer.measureElement} data-index={row.index} className="virtual-row" style={{ transform: `translateY(${row.start}px)` }}><button className={conversation.id === conversationId ? 'active' : ''} onClick={() => { setConversationId(conversation.id); setRailOpen(false); }}><span className="conversation-tab-title"><strong>{conversation.title}</strong>{isActive && <LoaderCircle className="spin conversation-tab-spinner" size={12} aria-label="Agent working" />}</span><small>{isActive ? 'Agent working…' : new Date(conversation.updatedAt).toLocaleDateString()}</small></button></div>; })}
          </div>
          {!conversations.isLoading && conversationList.length === 0 && <div className="page-state">No {conversationView} conversations.</div>}
          {conversations.isFetchingNextPage && <div className="page-state"><LoaderCircle className="spin" size={12} /> Loading more…</div>}
        </div>
      </aside>
      <section className="agent-console" aria-label="Shared agent workspace">
        <header className="agent-console-header"><button ref={railToggleRef} type="button" className="rail-toggle icon-button" aria-label="Show conversations" aria-controls="conversation-rail" aria-expanded={railOpen} onClick={() => setRailOpen(true)}><Menu size={16} /></button><div className="agent-console-title"><span className="eyebrow">Shared context</span><h2>{selectedConversation?.title ?? 'New conversation'}</h2>{linkedWorkItem.data?.item && onOpenTask && <button type="button" className="related-task-link" onClick={() => onOpenTask(linkedWorkItem.data!.item.id)}><ArrowLeft size={12} /> Back to task</button>}</div>{conversationId && selectedConversation && <div className="conversation-window-actions"><button className="icon-button" onClick={() => forkConversation.mutate(conversationId)} aria-label="Fork conversation" title="Fork into a new conversation"><MessageSquarePlus size={14} /></button>{conversationView === 'active' ? <button className="icon-button" onClick={() => archiveConversation.mutate(conversationId)} aria-label="Archive conversation" title="Archive conversation"><Archive size={14} /></button> : <button className="icon-button" onClick={() => restoreConversation.mutate(conversationId)} aria-label="Restore conversation" title="Restore conversation"><RefreshCw size={14} /></button>}<button className="icon-button delete-conversation-button" onClick={() => window.confirm('Permanently delete this conversation?') && deleteConversation.mutate(conversationId)} aria-label="Delete conversation" title="Delete permanently"><Trash2 size={14} /></button></div>}</header>
        <div className="shared-thread">
          {messages.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading room…</div>}
          {messages.error && <div className="list-state compact-state error-message">Could not load shared messages: {messages.error.message}</div>}
          {messages.data?.messages.length === 0 && <div className="list-state compact-state">No messages yet. Ask Codex or Claude to get started.</div>}
          {messages.data?.messages.map((message) => (
            <article className={`shared-message shared-${message.author}`} key={message.id}>
              <header><strong>{message.author === 'jeffrey' ? 'You' : message.author}</strong><time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                {message.model && <span className="model-badge">{message.executionProfile === 'routing' ? 'routing' : message.model}</span>}
                {message.status === 'running' && <button onClick={() => cancelReply.mutate(message.id)} title="Cancel response"><X size={12} /></button>}
              </header>
              {message.status === 'running' && <p className="thinking"><LoaderCircle className="spin" size={13} /> Live · {message.body ? 'receiving activity' : 'starting agent'}</p>}
              {message.status === 'queued' && <p className="queued-message"><LoaderCircle size={13} /> Queued · starts after the current agent finishes</p>}
              {message.body && (message.author === 'codex' || message.author === 'claude'
                ? <AgentMessageBody body={message.body} running={message.status === 'running'} conversationId={message.conversationId} />
                : <p>{message.body}</p>)}
              {message.status === 'canceled' && <p className="muted">Response canceled.</p>}
              {message.attachments.length > 0 && <div className="message-files">{message.attachments.map((file) => <span key={file.path}><Paperclip size={11} /> {file.name}</span>)}</div>}
              {message.error && <p className="error-message">{message.error}</p>}
              {message.status === 'completed' && message.author !== 'jeffrey' && message.author !== 'system' && selectedConversation?.workItemId && <div className="message-actions"><button onClick={() => createTasks.mutate({ messageId: message.id, conversationId: conversationId! })} disabled={createTasks.isPending && createTasks.variables?.conversationId === conversationId}>{createTasks.isPending && createTasks.variables?.messageId === message.id && createTasks.variables.conversationId === conversationId ? <><LoaderCircle className="spin" size={12} /> Extracting findings…</> : <><Plus size={12} /> Turn findings into tasks</>}</button></div>}
            </article>
          ))}
          {proposedPlan && proposedPlanConversationId === conversationId && <article className="chat-plan"><span className="eyebrow">Proposed follow-up tasks</span><h3>{proposedPlan.summary}</h3><ol>{proposedPlan.tasks.map((task, index) => <li key={`${task.title}-${index}`}><label><input type="checkbox" checked={selectedPlanTaskIndexes.has(index)} onChange={() => setSelectedPlanTaskIndexes((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{task.title}</strong><p>{task.description}</p></span></label></li>)}</ol><div><button className="button secondary" onClick={() => resolvePlan.mutate('rejected')}>Reject</button><button className="button primary" disabled={selectedPlanTaskIndexes.size === 0 || resolvePlan.isPending} onClick={() => resolvePlan.mutate('accepted')}><Check size={14} /> Add {selectedPlanTaskIndexes.size} to queue</button></div></article>}
          {createTasks.isPending && createTasks.variables?.conversationId === conversationId && <div className="finding-progress"><LoaderCircle className="spin" size={15} /><span><strong>Turning findings into tasks</strong><small>Reading the report and producing self-contained queue items…</small></span></div>}
          {createTasks.error && createTasks.variables?.conversationId === conversationId && <div className="finding-progress error-message"><X size={15} /><span><strong>Could not create tasks</strong><small>{createTasks.error.message}</small></span></div>}
          <div ref={endRef} />
        </div>
        {conversationView === 'archive' ? <div className="archived-composer-note"><Archive size={14} /> Archived conversation · restore or fork it to continue</div> : <form className="shared-composer" onSubmit={submit}>
          {files.length > 0 && <div className="pending-files">{files.map((file) => <button type="button" key={`${file.name}-${file.size}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><Paperclip size={11} /> {file.name} <X size={10} /></button>)}</div>}
          <textarea value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={submitOnEnter} placeholder="Message Codex or Claude…" rows={4} />
          <div className="composer-toolbar">
            <input ref={fileRef} className="visually-hidden" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
            <button type="button" className="composer-tool attach-button" onClick={() => fileRef.current?.click()}><Paperclip size={14} /> Attach</button>
            <span className="composer-hint">Files, screenshots, or context</span>
            <select className="agent-target" value={dispatchTo} onChange={(event) => { const target = event.target.value as typeof dispatchTo; setDispatchTo(target); if (linkedWorkItemId) updateConversationOwner.mutate(target); }} aria-label="Who should respond">
              <option value="codex">Ask Codex</option><option value="claude">Ask Claude</option><option value="both">Ask both</option>
            </select>
            <button className="composer-send" aria-label="Send message" disabled={(!body.trim() && files.length === 0) || !conversationId || send.isPending}>{send.isPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
          </div>
          {send.error && <p className="error-message">{send.error.message}</p>}
        </form>}
      </section>
    </main>
  );
}

function TaskDetail({ id, onClose, onOpenConversation, onOpenTask }: { id: string; onClose: () => void; onOpenConversation: (conversationId: string) => void; onOpenTask: (taskId: string) => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['work-item', id],
    queryFn: () => api.getWorkItem(id),
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === 'queued' || run.status === 'running') ? 1_000 : false,
  });
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [editingField, setEditingField] = useState<'title' | 'project' | 'description' | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editProjectName, setEditProjectName] = useState('');
  const [followUpTitle, setFollowUpTitle] = useState('');
  const [followUpDescription, setFollowUpDescription] = useState('');
  const [selectedExecutionTaskIndexes, setSelectedExecutionTaskIndexes] = useState<Set<number>>(new Set());
  const initializedExecutionPlanSelectionId = useRef<string | null>(null);
  const update = useMutation({
    mutationFn: (input: Partial<WorkItem>) => api.updateWorkItem(id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
      ]);
    },
  });
  const execute = useMutation({
    mutationFn: () => api.executeWorkItem(id),
    onSuccess: async ({ conversation }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
      ]);
      onOpenConversation(conversation.id);
    },
  });
  const cancelRun = useMutation({
    mutationFn: api.cancelAgentRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
  });
  const resolveExecutionPlan = useMutation({
    mutationFn: (resolution: 'accepted' | 'rejected') => api.resolveExecutionPlan(detail.data!.executionPlan!.id, resolution, resolution === 'accepted' ? [...selectedExecutionTaskIndexes] : undefined),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
      ]);
    },
  });
  const lifecycle = useMutation({
    mutationFn: async (action: 'archive' | 'restore' | 'complete' | 'delete'): Promise<void> => {
      if (action === 'archive') await api.archiveWorkItem(id);
      else if (action === 'restore') await api.restoreWorkItem(id);
      else if (action === 'complete') await api.completeWorkItem(id);
      else await api.deleteWorkItem(id);
    },
    onSuccess: async () => {
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['archived-work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-messages'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item-counts'] }),
      ]);
    },
  });
  const createFollowUp = useMutation({
    mutationFn: () => api.createFollowUp(id, followUpTitle, followUpDescription),
    onSuccess: async () => {
      setFollowUpTitle(''); setFollowUpDescription(''); setShowFollowUp(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['work-items'] }), queryClient.invalidateQueries({ queryKey: ['work-item', id] })]);
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

  function toggleAssignee(assignee: Assignee) {
    const next = item.assignees.includes(assignee)
      ? item.assignees.filter((value) => value !== assignee)
      : [...item.assignees, assignee];
    update.mutate({ assignees: next });
  }

  return (
    <section className="detail-panel">
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
      <div className="task-lifecycle-actions">
        <button type="button" className="button secondary compact" onClick={() => setShowFollowUp((value) => !value)}><Plus size={14} /> Follow-up</button>
        {item.archivedAt ? <><span className={`archive-state ${item.completionStatus}`}>{item.completionStatus === 'completed' ? 'Completed & archived' : 'Archived incomplete'}</span><button type="button" className="button secondary compact" onClick={() => lifecycle.mutate('restore')} disabled={lifecycle.isPending}><Archive size={14} /> Restore</button></> : <>
          <button type="button" className="button secondary compact" onClick={() => lifecycle.mutate('archive')}><Archive size={14} /> Archive</button>
          <button type="button" className="button primary compact" onClick={() => lifecycle.mutate('complete')}><Check size={14} /> Complete</button>
        </>}
        <button type="button" className="button danger compact" onClick={() => window.confirm(`Permanently delete “${item.title}”?`) && lifecycle.mutate('delete')}><Trash2 size={14} /> Delete</button>
      </div>
      {showFollowUp && <form className="follow-up-form" onSubmit={(event) => { event.preventDefault(); if (followUpTitle.trim()) createFollowUp.mutate(); }}>
        <span className="section-label">New follow-up task</span>
        <input autoFocus value={followUpTitle} onChange={(event) => setFollowUpTitle(event.target.value)} placeholder="Follow-up title" />
        <textarea value={followUpDescription} onChange={(event) => setFollowUpDescription(event.target.value)} placeholder="Description and expected outcome" rows={4} />
        {createFollowUp.error && <p className="error-message">{createFollowUp.error.message}</p>}
        <div><button type="button" className="button secondary compact" onClick={() => setShowFollowUp(false)}>Cancel</button><button className="button primary compact" disabled={!followUpTitle.trim() || createFollowUp.isPending}>{createFollowUp.isPending ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} Create follow-up</button></div>
      </form>}
      {editingField === 'title' ? <input className="inline-title-editor" autoFocus value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={300}
        onBlur={() => { const title = editTitle.trim(); if (title && title !== item.title) update.mutate({ title }); else setEditTitle(item.title); setEditingField(null); }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = item.title; setEditTitle(item.title); event.currentTarget.blur(); } }} />
        : <h1 className="inline-editable" onClick={() => setEditingField('title')} title="Click to edit title">{item.title}</h1>}
      {detail.data.parentItem && <button className="parent-task-link" onClick={() => onOpenTask(detail.data!.parentItem!.id)}><span>Follow-up to</span><strong>{detail.data.parentItem.title}</strong></button>}
      <div className="detail-controls">{editingField === 'project' ? <input className="inline-project-editor" autoFocus value={editProjectName} onChange={(event) => setEditProjectName(event.target.value)} maxLength={200} placeholder="No project"
        onBlur={() => { const projectName = editProjectName.trim() || null; if (projectName !== item.projectName) update.mutate({ projectName }); setEditingField(null); }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = item.projectName ?? ''; setEditProjectName(item.projectName ?? ''); event.currentTarget.blur(); } }} />
        : <button className={`project-pill inline-editable ${item.projectName ? '' : 'empty'}`} onClick={() => setEditingField('project')} title="Click to edit project">{item.projectName || 'Add project'}</button>}</div>

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
              onClick={() => toggleAssignee(assignee)}
            >
              {assignee === 'jeffrey' ? <User size={14} /> : <Bot size={14} />}
              {assignee}
            </button>
          ))}
        </div>
      </div>

      <div className="detail-section execution-section">
        <div className="section-heading">
          <span className="section-label">Agent execution</span>
          <Bot size={14} />
        </div>
        <p className="execution-copy">Workbench will classify the task, choose the right agent, and either execute it directly or return an approval-ready decomposition for complex work.</p>
        {execute.error && <p className="error-message">{execute.error.message}</p>}
        <button className="button primary execute-button" onClick={() => execute.mutate()} disabled={execute.isPending || detail.data.runs.some((run) => run.status === 'queued' || run.status === 'running')}>
          {execute.isPending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
          Execute
        </button>
      </div>

      {detail.data.runs.length > 0 && (
        <div className="detail-section runs-section">
          <span className="section-label">Agent runs</span>
          {detail.data.runs.map((run) => (
            <article className="run-card" key={run.id}>
              <header>
                <span className={`run-status run-${run.status}`}>{run.status === 'running' && <LoaderCircle className="spin" size={11} />}{run.status}</span>
                <strong>{run.agent} · {run.kind}</strong>
                <time>{new Date(run.createdAt).toLocaleString()}</time>
                {(run.status === 'queued' || run.status === 'running') && <button className="cancel-run" onClick={() => cancelRun.mutate(run.id)}><X size={11} /> Cancel</button>}
              </header>
              {run.instructions && <p className="run-prompt">{run.instructions}</p>}
              {run.status === 'running' && !run.conversationId && <div className="live-output-label"><span /> Live activity & reasoning summaries</div>}
              {run.output && run.status !== 'completed' && !run.conversationId && <pre aria-live="polite">{humanizeRunOutput(run.output)}</pre>}
              {run.model && <span className="model-badge">{run.model} · {run.executionProfile}</span>}
              {run.status === 'completed' && run.output && <div className="run-summary"><span className="section-label">Agent summary</span><AgentMessageBody body={run.output} running={false} workItemId={item.id} /></div>}
              {run.error && <p className="error-message">{run.error}</p>}
              {run.conversationId && <button className="open-run-chat" onClick={() => onOpenConversation(run.conversationId!)}><MessageCircle size={13} /> Open execution chat</button>}
            </article>
          ))}
        </div>
      )}

      {detail.data.executionPlan && (
        <div className="detail-section execution-plan">
          <span className="section-label">Approval required</span>
          <h3>{detail.data.executionPlan.summary}</h3>
          <ol>
            {detail.data.executionPlan.tasks.map((task, index) => <li key={`${task.title}-${index}`}><label><input type="checkbox" checked={selectedExecutionTaskIndexes.has(index)} onChange={() => setSelectedExecutionTaskIndexes((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{task.title}</strong><p>{task.description}</p></span></label></li>)}
          </ol>
          <div className="dialog-actions">
            <button className="button secondary" onClick={() => resolveExecutionPlan.mutate('rejected')}>Reject plan</button>
            <button className="button primary" disabled={selectedExecutionTaskIndexes.size === 0 || resolveExecutionPlan.isPending} onClick={() => resolveExecutionPlan.mutate('accepted')}><Check size={15} /> Create {selectedExecutionTaskIndexes.size} selected</button>
          </div>
        </div>
      )}

      <div className="detail-section activity-section">
        <span className="section-label">Activity</span>
        {activity.length === 0 ? <p className="muted">No activity yet.</p> : activity.map((entry) => (
          <div className="activity" key={entry.id}>
            <span className="activity-dot" />
            <div><strong>{entry.actor}</strong> <span>{entry.body}</span><time>{new Date(entry.createdAt).toLocaleString()}</time></div>
          </div>
        ))}
      </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [view, setView] = useState<'active' | 'workbench' | 'archive' | 'discovery' | 'context'>('active');
  const [agentConversationId, setAgentConversationId] = useState<string | null>(null);
  const [pendingTaskNavigation, setPendingTaskNavigation] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const selectedInitialItem = useRef(false);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [search]);
  const items = useInfiniteQuery({
    queryKey: ['work-items', view === 'archive' ? 'archive' : view === 'workbench' ? 'workbench' : 'active', debouncedSearch],
    queryFn: ({ pageParam }) => api.listWorkItems(view === 'archive' ? 'archive' : view === 'workbench' ? 'workbench' : 'active', debouncedSearch, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: view === 'active' || view === 'workbench' || view === 'archive',
  });
  const workItemCounts = useQuery({ queryKey: ['work-item-counts'], queryFn: api.getWorkItemCounts, refetchInterval: 1_500 });
  const queueAgentActivity = useQuery({ queryKey: ['shared-message-activity'], queryFn: () => api.listSharedMessages(), refetchInterval: 1_000 });
  const queueAgentStatusSignature = (queueAgentActivity.data?.messages ?? []).map((message) => `${message.id}:${message.status}`).join('|');
  useEffect(() => {
    if (queueAgentStatusSignature) void queryClient.invalidateQueries({ queryKey: ['work-items'] });
  }, [queryClient, queueAgentStatusSignature]);
  const sync = useMutation({
    mutationFn: api.syncLinear,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['work-items'] }); void queryClient.invalidateQueries({ queryKey: ['work-item-counts'] }); },
  });
  const reorder = useMutation({
    mutationFn: api.reorderQueue,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['work-items'] }),
  });
  const resolveProposal = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: 'accepted' | 'rejected' }) => api.resolveQueueProposal(id, resolution),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-items'] }),
  });
  const planQueue = useMutation({
    mutationFn: api.planQueue,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-items'] }),
  });
  const filtered = useMemo(() => items.data?.pages.flatMap((page) => page.items) ?? [], [items.data?.pages]);
  const { renderedItems, renderedRows } = useMemo(() => {
    const stackView = view === 'active' || view === 'workbench';
    const progress = stackView ? filtered.filter((item) => item.status === 'in_progress') : [];
    const attention = stackView ? filtered.filter((item) => item.status !== 'in_progress') : [];
    return {
      renderedItems: stackView ? [...progress, ...attention] : filtered,
      renderedRows: stackView ? [
        { type: 'header' as const, id: 'in-progress-header', label: 'In progress', count: progress.length, group: 'progress' as const },
        ...progress.map((item) => ({ type: 'item' as const, id: item.id, item, group: 'progress' as const })),
        { type: 'header' as const, id: 'attention-header', label: 'Attention stack', count: attention.length, group: 'attention' as const },
        ...attention.map((item) => ({ type: 'item' as const, id: item.id, item, group: 'attention' as const })),
      ] : filtered.map((item) => ({ type: 'item' as const, id: item.id, item, group: 'archive' as const })),
    };
  }, [filtered, view]);
  useEffect(() => {
    if (!selectedInitialItem.current && filtered[0]) {
      selectedInitialItem.current = true;
      setSelectedId(filtered[0].id);
    }
  }, [filtered]);
  useEffect(() => {
    if (view === 'context' || view === 'discovery' || !pendingTaskNavigation) return;
    setSelectedId(pendingTaskNavigation);
    setPendingTaskNavigation(null);
  }, [pendingTaskNavigation, view]);

  async function openTaskFromConversation(taskId: string) {
    const { item } = await queryClient.fetchQuery({ queryKey: ['work-item', taskId], queryFn: () => api.getWorkItem(taskId) });
    setSearch('');
    setDebouncedSearch('');
    setPendingTaskNavigation(taskId);
    setView(item.archivedAt ? 'archive' : item.projectName?.toLowerCase() === 'workbench' ? 'workbench' : 'active');
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || debouncedSearch || items.isFetchingNextPage) return;
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">W</span><span>Workbench</span></div>
        <nav>
          <button className={`nav-item ${view === 'active' ? 'active' : ''}`} onClick={() => { setView('active'); setSelectedId(null); }}><Command size={16} /> Attention stack <span>{workItemCounts.data?.active ?? '…'}</span></button>
          <button className={`nav-item ${view === 'workbench' ? 'active' : ''}`} onClick={() => { setView('workbench'); setSelectedId(null); }}><Wrench size={16} /> Workbench <span>{workItemCounts.data?.workbench ?? '…'}</span></button>
          <button className={`nav-item ${view === 'archive' ? 'active' : ''}`} onClick={() => { setView('archive'); setSelectedId(null); }}><Archive size={16} /> Archive <span>{workItemCounts.data?.archive ?? '…'}</span></button>
          <DiscoveryNav active={view === 'discovery'} onClick={() => { setView('discovery'); setSelectedId(null); }} />
          <button className={`nav-item ${view === 'context' ? 'active' : ''}`} onClick={() => { setView('context'); setSelectedId(null); setAgentConversationId(null); }}><MessageCircle size={16} /> Agent console</button>
          <button className="nav-item" onClick={() => setShowSources(true)}><Cloud size={16} /> Sources</button>
        </nav>
      </aside>

      {view === 'context' ? <SharedWorkspace initialConversationId={agentConversationId} onOpenTask={(taskId) => { void openTaskFromConversation(taskId); }} /> : view === 'discovery' ? <DiscoveryInboxView onOpenTask={(taskId) => { void openTaskFromConversation(taskId); }} onOpenStack={() => { setSelectedId(null); setView('active'); }} /> : <><main className="queue-panel">
        <header className="queue-header">
          <div><span className="eyebrow">{view === 'active' ? 'Focus' : view === 'workbench' ? 'Build' : 'History'}</span><h2>{view === 'active' ? 'Attention stack' : view === 'workbench' ? 'Workbench roadmap' : 'Archive'}</h2></div>
          <div className="header-actions">
            {(view === 'active' || view === 'workbench') && <>
            {view === 'active' && <>
            <button className="button secondary compact" onClick={() => planQueue.mutate()} disabled={planQueue.isPending}>
              {planQueue.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} {planQueue.isPending ? 'Reordering…' : 'Reorder stack'}
            </button>
            <button className="icon-button" onClick={() => sync.mutate()} aria-label="Refresh Linear catalog" title="Refresh Linear catalog">
              <RefreshCw size={16} className={sync.isPending ? 'spin' : ''} />
            </button>
            </>}
            <button className="button primary compact" onClick={() => setShowCreate(true)}><Plus size={15} /> New</button>
            </>}
          </div>
        </header>
        <div className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search work…" /></div>
        {sync.error && <div className="inline-error">{sync.error.message}</div>}
        {planQueue.error && <div className="inline-error">{planQueue.error.message}</div>}
        {items.data?.pages[0]?.proposal && (
          <div className="proposal-banner">
            <div><Sparkles size={15} /><span><strong>Proposed stack applied</strong><small>{items.data.pages[0].proposal.rationale}</small></span></div>
            <div>
              <button onClick={() => resolveProposal.mutate({ id: items.data!.pages[0].proposal!.id, resolution: 'rejected' })}>Reject & restore</button>
              <button className="accept" onClick={() => resolveProposal.mutate({ id: items.data!.pages[0].proposal!.id, resolution: 'accepted' })}>Accept</button>
            </div>
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div ref={queueScrollRef} className="queue-list" role="list" aria-label={view === 'archive' ? 'Archived tasks' : view === 'workbench' ? 'Workbench roadmap' : 'Work stacks'} onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 500 && items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
        }}>
          {items.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading queue…</div>}
          {items.isError && <div className="list-state error-message">Could not load work items. <button className="button secondary compact" onClick={() => items.refetch()}>Retry</button></div>}
          {!items.isLoading && !items.isError && filtered.length === 0 && <div className="list-state">{debouncedSearch ? 'No matching work items.' : view === 'active' ? 'No work items yet. Add one or connect Linear.' : view === 'workbench' ? 'No Workbench roadmap tasks yet.' : 'No archived tasks.'}</div>}
          <SortableContext items={(view === 'active' || view === 'workbench') && !debouncedSearch ? renderedItems.map((item) => item.id) : []} strategy={verticalListSortingStrategy}>
            <div className="queue-rows">
              {renderedRows.map((rendered, index) => rendered.type === 'header'
                ? <div key={rendered.id} className={`stack-header stack-header-${rendered.group}`}><span>{rendered.label}</span><strong>{rendered.count}</strong></div>
                : <div key={rendered.id} className={`task-group-row task-group-${rendered.group}`}><SortableQueueItem item={rendered.item} index={index} selected={selectedId === rendered.item.id} draggable={(view === 'active' || view === 'workbench') && !debouncedSearch && !items.isFetchingNextPage} onSelect={() => setSelectedId(rendered.item.id)} /></div>)}
            </div>
          </SortableContext>
          {items.isFetchingNextPage && <div className="page-state"><LoaderCircle className="spin" size={14} /> Loading more…</div>}
          {!items.hasNextPage && filtered.length > 0 && <div className="page-state">All {items.data?.pages[0]?.totalCount ?? filtered.length} items loaded</div>}
        </div>
        </DndContext>
      </main>

      {selectedId ? <TaskDetail id={selectedId} onClose={() => setSelectedId(null)} onOpenTask={setSelectedId} onOpenConversation={(conversationId) => { setAgentConversationId(conversationId); setView('context'); }} /> : <section className="detail-empty"><Sparkles /><h2>Choose your next move</h2><p>Select an item or add something new.</p></section>}</>}
      {showCreate && <CreateTask onClose={() => setShowCreate(false)} defaultProjectName={view === 'workbench' ? 'Workbench' : ''} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
    </div>
  );
}
