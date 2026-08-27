/* eslint-disable @typescript-eslint/no-unused-vars */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  ArrowUpRight,
  ArrowDown,
  ArrowLeft,
  AlertTriangle,
  Bot,
  Check,
  Archive,
  Clock,
  Cloud,
  Command,
  FileText,
  FileDiff,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  Link2,
  Link2Off,
  Paperclip,
  PanelTop,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
  SquarePen,
  Trash2,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { type CSSProperties, type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownComposer } from '../../markdown-composer.js';
import { MarkdownCode, MarkdownPre } from '../../markdown-code.js';
import { DEFAULT_ACCOUNT_PROFILE, isSelfAssigned, SELF_ASSIGNED_EXECUTION_MESSAGE, SELF_ASSIGNED_OWNER_MESSAGE } from '../../../shared/contracts';
import type { AgentRun, Assignee, ExecutionPlan, ProviderSyncConflict, SessionFeedbackRating, SharedConversation, SharedMessage, UpdateWorkItemInput, WorkItem, WorkItemDetail, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../../../shared/contracts';
import { api } from '../../api';
import { ArtifactLibraryView } from '../../artifacts';
import { ConfirmationDialog } from '../../confirmation-dialog';
import { InsightsView } from '../../insights';
import { navigate, parseRoute, routePath, useRoute, type StackName } from '../../router';
import { ConversationComposerSkeleton, ConversationRailSkeleton, ConversationSearchResultSkeleton, ConversationThreadSkeleton, Skeleton } from '../../skeleton';
import { Toaster } from '../../toast';
import { toast, toastError } from '../../toast-store';
import { Tabs } from '../../tabs';
import { SortableQueueItem as TaskQueueItem, TaskClassificationSelect } from '../../task-queue';
import { AgentMessageBody, LiveRunOutput, splitBodyAtInterjections, type AgentMessageInterjection } from '../../agent-message';
import { ConversationOriginBadge, ModelProfileSelect, ReferenceTypeIcon } from '../../badges';
import { CreateTask } from '../../create-task-dialog';
import { DiscoveryInboxView } from '../../discovery';
import { useNavigation } from '../../features/navigation/hooks';
import { NavigationView } from '../../features/navigation/view';
import { FollowUpArchiveDialog } from '../../follow-up-archive-dialog';
import { activityKindLabel, agentDecisionKinds, compactTokenCount, formatFileSize, formatRunBadge, formatRunTelemetry, sourceLinkLabel, sourceReferenceTitle, sourceReferenceType, taskDetailSaveFeedback } from '../../formatters';
import { clearSentConversationDraft, readConversationDrafts, readLastOpenedItem, readTaskModelProfiles, writeConversationDraft, writeLastOpenedItem, writeTaskModelProfile } from '../../preferences';
import { QueueExplanationList } from '../../queue-explanations';
import { RetrievedMemoryDialog } from '../../retrieved-memory-dialog';
import { ProjectColorDot, projectTheme } from '../../project-color';
import { InlineProjectEditor } from '../../project-field';
import { isWorkbenchProject, WORKBENCH_PROJECT_NAME } from '../../../shared/project-name';
import { SourcesDialog } from '../../sources-dialog';
import { createTaskStackViewModel } from '../../stack-view-model';
import { useRealtimeNotifications, type RealtimeNotification } from '../../realtime';
import { conversationData, conversationQueryKeys } from './data';
import { DecisionTreeVisualizer } from './decision-tree-visualizer';
import { celebrate } from '../../celebrate';
import { SessionFeedbackPrompt } from '../../session-feedback-prompt';
import { useConversationChangesAvailability, useDebouncedValue } from './hooks';
import { GitHubDiffView } from '../github-diff/view';
import { WorkspaceDiffView } from '../workspace-diff/view';
import type { WorkspaceDiffScope } from '../../data/source-client';
import { formatDiffFollowUpReference, type DiffFollowUpReference } from '../diff-confidence';

const CONVERSATION_ROW_GAP = 6;
// Stack cards and task cards share an 88px minimum height. Keeping the
// virtualizer's initial estimate in sync prevents a newly rendered group
// header from being positioned over a card before ResizeObserver measures it.
const CONVERSATION_CARD_ESTIMATE = 88;

type ConversationDispatchTarget = 'both' | 'codex' | 'claude';
type ComposerSelection = {
  executionProfile: Exclude<AgentRun['executionProfile'], 'routing'>;
  accountProfile: string;
  dispatchTarget: ConversationDispatchTarget;
};

const defaultComposerSelection = (): ComposerSelection => ({
  executionProfile: null,
  accountProfile: DEFAULT_ACCOUNT_PROFILE,
  dispatchTarget: 'both',
});

export function composerSelectionFromConversation(conversation: Pick<SharedConversation, 'preferredExecutionProfile' | 'preferredAccountProfile' | 'preferredDispatchTarget'>): ComposerSelection {
  return {
    executionProfile: conversation.preferredExecutionProfile ?? null,
    accountProfile: conversation.preferredAccountProfile ?? DEFAULT_ACCOUNT_PROFILE,
    dispatchTarget: conversation.preferredDispatchTarget ?? 'both',
  };
}

export function replyBadge(message: Pick<SharedMessage, 'author' | 'model' | 'accountProfile' | 'inputTokens' | 'outputTokens' | 'completedAt' | 'createdAt' | 'executionProfile' | 'fallbackFrom' | 'fallbackReason' | 'cacheReadInputTokens'>): string {
  const agent = message.author[0].toUpperCase() + message.author.slice(1);
  const tier = message.executionProfile && message.executionProfile !== 'routing' ? message.executionProfile : null;
  const model = `${message.model ?? 'model unavailable'}${tier ? ` (${tier})` : ''}`;
  const profile = message.accountProfile ?? DEFAULT_ACCOUNT_PROFILE;
  const usage = formatRunBadge(message);
  const cacheRead = message.cacheReadInputTokens && message.cacheReadInputTokens > 0 ? `${compactTokenCount(message.cacheReadInputTokens)} cached` : null;
  const durationMs = message.completedAt ? new Date(message.completedAt).getTime() - new Date(message.createdAt).getTime() : null;
  const duration = durationMs === null ? null : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  const fallback = message.fallbackFrom ? `fallback from ${message.fallbackFrom}${message.fallbackReason ? ` (${message.fallbackReason})` : ''}` : null;
  return [`${agent} · ${model} · ${profile} · ${usage}`, cacheRead, duration, fallback].filter(Boolean).join(' · ');
}

type ConversationTaskPickerProps = {
  tasks: WorkItem[];
  isLoading: boolean;
  isError: boolean;
  isPending: boolean;
  onRetry: () => void;
  onSelect: (workItemId: string) => void;
};

function ConversationTaskPicker({ tasks, isLoading, isError, isPending, onRetry, onSelect }: ConversationTaskPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const matchingTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizedQuery ? tasks.filter((task) => task.title.toLocaleLowerCase().includes(normalizedQuery)) : tasks;
  }, [query, tasks]);
  const listboxId = 'conversation-task-results';

  const selectTask = (task: WorkItem) => {
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
    onSelect(task.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0 && matchingTasks[activeIndex]) {
      event.preventDefault();
      selectTask(matchingTasks[activeIndex]);
      return;
    }
    if (!matchingTasks.length || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    setActiveIndex((current) => event.key === 'ArrowDown'
      ? Math.min(current + 1, matchingTasks.length - 1)
      : Math.max(current === -1 ? matchingTasks.length - 1 : current - 1, 0));
  };

  return (
    <div className="conversation-task-picker" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }}>
      <button type="button" className="icon-button" aria-label="Link conversation to task" aria-expanded={open} aria-controls={open ? listboxId : undefined} disabled={isLoading || isPending} title={isLoading ? 'Loading tasks…' : 'Link conversation to task'} onClick={() => setOpen((current) => !current)}>
        {isPending ? <LoaderCircle className="spin" size={14} /> : <Link2 size={14} />}
      </button>
      {open && <div className="conversation-task-popover">
        <label className="visually-hidden" htmlFor="conversation-task-search">Search tasks to link</label>
        <input id="conversation-task-search" autoFocus role="combobox" aria-autocomplete="list" aria-controls={listboxId} aria-activedescendant={activeIndex >= 0 ? `conversation-task-result-${activeIndex}` : undefined} aria-expanded placeholder="Search tasks…" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(-1); }} onFocus={() => setOpen(true)} onKeyDown={handleKeyDown} />
        <div id={listboxId} className="conversation-task-results" role="listbox" aria-busy={isLoading}>
          {isLoading && <div className="conversation-task-result-skeleton" aria-label="Loading tasks"><Skeleton width="100%" height="14px" /></div>}
          {isError && <div className="page-state error-message">Could not load tasks. <button type="button" className="button secondary compact" onClick={onRetry}>Retry</button></div>}
          {!isLoading && !isError && matchingTasks.length === 0 && <div className="page-state">No tasks match “{query.trim()}”.</div>}
          {!isLoading && !isError && matchingTasks.map((task, index) => <button key={task.id} id={`conversation-task-result-${index}`} type="button" className="conversation-task-result" role="option" aria-selected={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => selectTask(task)}>{task.title}</button>)}
        </div>
      </div>}
    </div>
  );
}

export function SharedWorkspace({ initialConversationId, initialStackOnly = false, onOpenTask, onSelectConversation, view, onViewChange }: { initialConversationId?: string | null; initialStackOnly?: boolean; onOpenTask?: (taskId: string) => void; onSelectConversation?: (conversationId: string | null) => void; view?: 'active' | 'archive'; onViewChange?: (view: 'active' | 'archive') => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(() => initialConversationId ? readConversationDrafts()[initialConversationId] ?? '' : '');
  const [composerSelection, setComposerSelection] = useState<ComposerSelection>(defaultComposerSelection);
  const [selectionHydratedFor, setSelectionHydratedFor] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null);
  const isCreatingConversationRef = useRef(false);
  const [locallyReadConversationIds, setLocallyReadConversationIds] = useState<Set<string>>(new Set());
  const [exitingMessageIds, setExitingMessageIds] = useState<Set<string>>(new Set());
  const conversationIdRef = useRef(conversationId);
  const sentDraftRef = useRef<{ conversationId: string; body: string } | null>(null);
  const preferenceMutationSequence = useRef(0);
  const updateConversationPreferences = useMutation({
    mutationFn: ({ conversationId, updates, sequence }: { conversationId: string; updates: Partial<ComposerSelection>; sequence: number }) => api.updateSharedConversationPreferences(conversationId, updates),
    onSuccess: async ({ conversation }, { conversationId: updatedConversationId, sequence }) => {
      // Several selectors may change before earlier requests return. Only the
      // newest response may hydrate this window, otherwise an older response
      // visibly snaps a picker back to a stale value.
      if (conversationIdRef.current === updatedConversationId && sequence === preferenceMutationSequence.current) {
        setComposerSelection(composerSelectionFromConversation(conversation));
        setSelectionHydratedFor(updatedConversationId);
      }
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
      await queryClient.invalidateQueries({ queryKey: conversationQueryKeys.detail(updatedConversationId) });
    },
    onError: (error, { conversationId: failedConversationId, sequence }) => {
      toastError('Could not save the composer preferences.', error);
      // Keep the last visible selection until the direct server refresh
      // resolves; never replace it with a value inferred from old messages.
      if (conversationIdRef.current === failedConversationId && sequence === preferenceMutationSequence.current) {
        setSelectionHydratedFor(null);
        void queryClient.invalidateQueries({ queryKey: conversationQueryKeys.detail(failedConversationId) });
      }
    },
  });
  const selectConversationRef = useRef(onSelectConversation);
  useEffect(() => { selectConversationRef.current = onSelectConversation; });
  useEffect(() => {
    conversationIdRef.current = conversationId;
    setBody(conversationId ? readConversationDrafts()[conversationId] ?? '' : '');
    setFiles([]);
    setComposerSelection(defaultComposerSelection());
    setSelectionHydratedFor(null);
  }, [conversationId]);
  useEffect(() => {
    if (conversationId) setShowingConversationStackOnly(false);
  }, [conversationId]);
  useEffect(() => {
    // The rail keeps owning the live selection; the address bar just follows it,
    // so an open conversation can be reloaded, shared, and stepped back out of.
    if (conversationId) writeLastOpenedItem('conversation', conversationId);
    selectConversationRef.current?.(conversationId);
  }, [conversationId]);
  function updateBody(nextBody: string) {
    setBody(nextBody);
    if (conversationId) writeConversationDraft(conversationId, nextBody);
  }
  function addDiffFollowUp(reference: DiffFollowUpReference) {
    const nextBody = [body.trim(), formatDiffFollowUpReference(reference)].filter(Boolean).join('\n\n');
    updateBody(nextBody);
    setActivePane('conversation');
  }
  function updateComposerPreferences(updates: Partial<ComposerSelection>) {
    if (!conversationId) return;
    const targetConversationId = conversationId;
    setComposerSelection((current) => ({ ...current, ...updates }));
    updateConversationPreferences.mutate({ conversationId: targetConversationId, updates, sequence: ++preferenceMutationSequence.current });
  }
  function setExecutionProfile(profile: ComposerSelection['executionProfile']) {
    updateComposerPreferences({ executionProfile: profile });
  }
  // The rail's Active/Archive selection is owned by the caller when it supplies
  // one, so it survives the workspace being remounted onto a conversation from
  // the address bar. Rendered on its own the workspace still keeps its own.
  const [ownConversationView, setOwnConversationView] = useState<'active' | 'archive'>('active');
  const conversationView = view ?? ownConversationView;
  const setConversationView = (next: 'active' | 'archive') => { setOwnConversationView(next); onViewChange?.(next); };
  const [deleteConversationPromptOpen, setDeleteConversationPromptOpen] = useState(false);
  const [retrievedMemoryMessageId, setRetrievedMemoryMessageId] = useState<string | null>(null);
  const [decisionTreeOpen, setDecisionTreeOpen] = useState(false);
  const [feedbackTarget, setFeedbackTarget] = useState<{ conversationId?: string | null; workItemId?: string | null } | null>(null);
  const [conversationSearch, setConversationSearch] = useState('');
  const [dismissedCompletionPromptPromotionId, setDismissedCompletionPromptPromotionId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<'conversation' | 'split' | 'changes'>('conversation');
  const debouncedConversationSearch = useDebouncedValue(conversationSearch.trim(), 300);
  const conversationSearchResults = useQuery({
    queryKey: conversationQueryKeys.search(debouncedConversationSearch),
    queryFn: () => conversationData.search(debouncedConversationSearch),
    enabled: debouncedConversationSearch.length > 0,
  });
  const agentStreamEvents = useQuery({
    queryKey: conversationQueryKeys.agentEvents(conversationId),
    queryFn: () => conversationData.listAgentEvents(conversationId!),
    enabled: decisionTreeOpen && Boolean(conversationId),
    refetchInterval: decisionTreeOpen ? 2_000 : false,
  });
  const [pendingSelectedConversation, setPendingSelectedConversation] = useState<{ id: string; title: string } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  // On mobile, railOpen means the conversation stack is showing instead of
  // the console — default to the stack unless a specific conversation was
  // requested, mirroring the task stack/detail pattern.
  const [railOpen, setRailOpen] = useState(() => !initialConversationId);
  // Closing a conversation is a navigation terminal, not an instruction to
  // choose another card. Keep the rail visible until Jeffrey explicitly picks
  // a conversation (or starts one) instead of falling through to its first
  // row, which may be a pinned task conversation.
  const [showingConversationStackOnly, setShowingConversationStackOnly] = useState(initialStackOnly);
  const [exitingConversationIds, setExitingConversationIds] = useState<Set<string>>(new Set());
  const [proposedPlan, setProposedPlan] = useState<ExecutionPlan | null>(null);
  const [proposedPlanConversationId, setProposedPlanConversationId] = useState<string | null>(null);
  const [selectedPlanTaskIndexes, setSelectedPlanTaskIndexes] = useState<Set<number>>(new Set());
  const [planArchivePromptOpen, setPlanArchivePromptOpen] = useState(false);
  const initializedPlanSelectionId = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const isNearThreadBottomRef = useRef(true);
  // Phone conversations open directly onto the thread; header and composer
  // start collapsed into small toggle buttons to keep the thread the
  // dominant surface, and expand on tap rather than on scroll direction.
  const [mobileHeaderOpen, setMobileHeaderOpen] = useState(false);
  const [mobileComposerOpen, setMobileComposerOpen] = useState(false);
  const THREAD_PAGE_SIZE = 5;
  const [threadVisibleCount, setThreadVisibleCount] = useState(THREAD_PAGE_SIZE);
  const [hasNewActivityBelow, setHasNewActivityBelow] = useState(false);
  const conversations = useInfiniteQuery({
    queryKey: conversationQueryKeys.rail(conversationView), queryFn: ({ pageParam }) => conversationData.list(conversationView, pageParam),
    initialPageParam: undefined as string | undefined, getNextPageParam: (page) => page.nextCursor ?? undefined, refetchInterval: 1_000,
  });
  const selectConversationView = (view: 'active' | 'archive') => {
    if (view === conversationView) {
      // Keep the open conversation intact. A repeat tap is a refresh, not a
      // request to blank the console behind the rail.
      void conversations.refetch();
      return;
    }
    setShowingConversationStackOnly(false);
    setConversationId(null);
    setConversationView(view);
  };
  const conversationList = useMemo(() => conversations.data?.pages.flatMap((page) => page.conversations) ?? [], [conversations.data?.pages]);
  const nextConversationIdAfterRemoval = (removedId: string, view: 'active' | 'archive' = conversationView) => {
    const cached = queryClient.getQueryData<{ pages: Array<{ conversations: SharedConversation[] }> }>(['shared-conversations', view]);
    return cached?.pages.flatMap((page) => page.conversations).find((conversation) => conversation.id !== removedId)?.id ?? null;
  };
  const removeConversationFromCachedRails = (removedId: string) => {
    // A conversation may be promoted while an archive/delete is in flight.
    // Preserve every cached row except the one we just removed; replacing the
    // whole paginated result with an out-of-order response can hide that newly
    // promoted row until another poll happens.
    queryClient.setQueriesData<{ pages: Array<{ conversations: SharedConversation[] }> }>({ queryKey: ['shared-conversations'] }, (current) => current && ({
      ...current,
      pages: current.pages.map((page) => ({ ...page, conversations: page.conversations.filter((conversation) => conversation.id !== removedId) })),
    }));
  };
  const conversationActivity = useQuery({ queryKey: ['shared-message-activity'], queryFn: () => api.listSharedMessages(), refetchInterval: 1_000 });
  const activeConversationIds = useMemo(() => new Set(conversationActivity.data?.messages.filter((message) => message.status === 'running').map((message) => message.conversationId) ?? []), [conversationActivity.data?.messages]);
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
  const conversationStackRows = useMemo(() => {
    const rows = conversationList.map((conversation) => {
      const isActive = conversation.isActive || activeConversationIds.has(conversation.id);
      const serverState = conversation.state ?? fallbackConversationStates.get(conversation.id) ?? null;
      const state = serverState === 'promoting' || serverState === 'waiting_promotion' ? serverState : isActive ? 'working' : serverState;
      return { type: 'conversation' as const, id: conversation.id, conversation, state };
    });
    if (conversationView === 'archive') return rows;

    const progress = rows.filter((row) => !row.conversation.pinned && !row.conversation.linkedWorkItemPinned && (row.state === 'working' || row.state === 'promoting' || row.state === 'waiting_promotion'));
    const pinned = rows.filter((row) => row.conversation.pinned || row.conversation.linkedWorkItemPinned);
    const attention = rows.filter((row) => !row.conversation.pinned && !row.conversation.linkedWorkItemPinned && row.state !== 'working' && row.state !== 'promoting' && row.state !== 'waiting_promotion');
    const groups = [
      { id: 'conversation-in-progress-header', label: 'In progress', group: 'progress' as const, rows: progress },
      { id: 'conversation-attention-header', label: 'Attention stack', group: 'attention' as const, rows: attention },
      { id: 'conversation-pinned-header', label: 'Pinned for you', group: 'pinned' as const, rows: pinned },
    ];
    return groups.flatMap((group) => group.rows.length === 0 && group.group !== 'pinned' ? [] : [
      { type: 'header' as const, id: group.id, label: group.label, count: group.rows.length, group: group.group },
      ...group.rows,
    ]);
  }, [activeConversationIds, conversationList, conversationView, fallbackConversationStates]);
  const conversationVirtualizer = useVirtualizer({ count: conversationStackRows.length, getScrollElement: () => conversationScrollRef.current, estimateSize: (index) => (conversationStackRows[index]?.type === 'header' ? 38 : CONVERSATION_CARD_ESTIMATE) + CONVERSATION_ROW_GAP, overscan: 5, initialRect: { width: 250, height: 600 } });
  const conversationRows = conversationVirtualizer.getVirtualItems();
  const displayedConversationRows = conversationRows.length ? conversationRows : conversationStackRows.map((row, index) => ({ index, start: conversationStackRows.slice(0, index).reduce((total, item) => total + (item.type === 'header' ? 38 : CONVERSATION_CARD_ESTIMATE) + CONVERSATION_ROW_GAP, 0) }));
  // The 1s conversation/activity polls hand back brand-new array references
  // every tick even when nothing visible changed, so keying this off
  // conversationStackRows itself forced a full remeasure (and a visible jump
  // under a mid-scroll finger) every second. Key off the row shape instead --
  // it only changes when a card actually moves between groups or a header
  // count changes.
  const conversationStackShape = conversationStackRows.map((row) => row.type === 'header' ? `h:${row.id}:${row.count}` : `i:${row.id}:${row.group}`).join('|');
  useEffect(() => {
    // Group headers change the virtual row geometry as conversations move
    // between stacks, so recalculate instead of waiting for a scroll event.
    conversationVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationStackShape, conversationVirtualizer]);
  useEffect(() => {
    const last = conversationRows.at(-1);
    if (last && last.index >= conversationStackRows.length - 5 && conversations.hasNextPage && !conversations.isFetchingNextPage) void conversations.fetchNextPage();
  }, [conversationStackRows.length, conversationRows, conversations]);
  const listedConversation = conversationList.find((conversation) => conversation.id === conversationId);
  // Deep links (e.g. archived or unpaginated conversations) aren't necessarily
  // in the currently loaded page of the active tab, so fall back to a direct
  // lookup rather than silently rendering "New conversation".
  const conversationDetail = useQuery({
    queryKey: conversationQueryKeys.detail(conversationId),
    queryFn: () => conversationData.get(conversationId!),
    // The rail is deliberately lightweight and can be stale. The picker
    // values belong to this exact conversation window, so always fetch its
    // canonical server record immediately on open.
    enabled: Boolean(conversationId),
    retry: false,
  });
  const selectedConversation = listedConversation ?? conversationDetail.data?.conversation;
  const selectedConversationMissing = Boolean(conversationId) && !listedConversation && conversationDetail.isError;
  useEffect(() => {
    // A conversation opened via search or a deep link may not belong to the
    // rail's current tab (e.g. an archived hit while on Active). Follow it,
    // or the rail keeps listing the wrong tab's contents while the header
    // silently shows the opened conversation as if it were on this tab.
    if (!selectedConversation || selectedConversation.id !== conversationId) return;
    const actualView = selectedConversation.archivedAt ? 'archive' : 'active';
    if (actualView !== conversationView) setConversationView(actualView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversation, conversationId]);
  const linkedWorkItemId = selectedConversation?.workItemId ?? null;
  const linkedWorkItem = useQuery({ queryKey: ['work-item', linkedWorkItemId], queryFn: () => api.getWorkItem(linkedWorkItemId!), enabled: Boolean(linkedWorkItemId), refetchInterval: 1_000 });
  // Changes belong to the conversation, not merely its linked task: Repo
  // Explorer can deliberately select any attached local repository.
  const workspaceDiffScope: WorkspaceDiffScope | null = conversationId ? { conversationId } : null;
  const conversationIsRunning = selectedConversation?.state === 'working';
  const changesAvailability = useConversationChangesAvailability(
    workspaceDiffScope,
    linkedWorkItem.data?.item?.sourceUrl ?? null,
    linkedWorkItem.data?.references ?? [],
    conversationIsRunning,
  );
  useEffect(() => { setActivePane('conversation'); }, [conversationId]);
  const linkableTasks = useQuery({
    queryKey: ['conversation-linkable-tasks'],
    queryFn: async () => {
      const [active, workbench] = await Promise.all([api.listWorkItems('active', ''), api.listWorkItems('workbench', '')]);
      const seen = new Set<string>();
      const items = [...active.items, ...workbench.items].filter((task) => (seen.has(task.id) ? false : (seen.add(task.id), true)));
      return { items };
    },
    staleTime: 30_000,
  });
  const retrievedMemoryDetail = useQuery({
    queryKey: ['retrieved-memory', retrievedMemoryMessageId],
    queryFn: () => api.getRetrievedMemory(retrievedMemoryMessageId!),
    enabled: Boolean(retrievedMemoryMessageId),
  });
  const linkedTaskCompleted = linkedWorkItem.data?.item?.completionStatus === 'completed';
  // A task Jeffrey has claimed keeps its owner: chatting here must not hand it to an agent.
  const linkedTaskIsSelfAssigned = isSelfAssigned(linkedWorkItem.data?.item?.assignees ?? []);
  const animateConversationExit = (id: string) => new Promise<void>((resolve) => {
    setExitingConversationIds((current) => new Set(current).add(id));
    window.setTimeout(resolve, 560);
  });
  // initialConversationId is navigation input, not a controlled selection.
  // Applying later prop changes here allowed a delayed Execute response to
  // steal focus after Jeffrey had already selected another conversation.
  // The workspace is remounted when it is opened from another view, so the
  // useState initializer above is the only synchronization we need.
  useEffect(() => {
    if (!conversationId && !showingConversationStackOnly && conversationList[0]) setConversationId(conversationList[0].id);
  }, [conversationId, conversationList, showingConversationStackOnly]);
  const showConversationStackOnly = () => {
    setShowingConversationStackOnly(true);
    setConversationId(null);
    setRailOpen(true);
  };
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
  const allConversationMessages = messages.data?.messages ?? [];
  const agentAccounts = useQuery({ queryKey: ['agent-accounts'], queryFn: api.listAgentAccounts, refetchInterval: 5_000 });
  const accountProfiles = useMemo(() => {
    const configured = agentAccounts.data?.accounts ?? [];
    return configured.some((account) => account.name === composerSelection.accountProfile)
      ? configured
      : [{ name: composerSelection.accountProfile }, ...configured];
  }, [composerSelection.accountProfile, agentAccounts.data?.accounts]);
  // Keep the thread bounded to a handful of recent messages instead of an
  // endless scroll; older history is revealed a page at a time on request.
  const hasEarlierMessages = allConversationMessages.length > threadVisibleCount;
  const conversationMessages = hasEarlierMessages
    ? allConversationMessages.slice(allConversationMessages.length - threadVisibleCount)
    : allConversationMessages;
  // Accepted interjections are durable events in their target agent's activity
  // timeline. Repeating their standalone Jeffrey bubble after completion makes
  // the same input appear twice and breaks that timeline.
  const renderedConversationMessages = conversationMessages.filter((message) => {
    const acceptedInterjection = message.author === 'jeffrey'
      && message.status === 'completed'
      && (message.queuePriority ?? 0) > 0;
    const canceledDraft = message.author === 'jeffrey' && message.status === 'canceled';
    return !acceptedInterjection && (!canceledDraft || exitingMessageIds.has(message.id));
  });
  // Consecutive codex+claude replies with no jeffrey message between them came
  // from the same "both" dispatch — render them as one side-by-side group
  // instead of two look-alike rows stacked on top of each other.
  const conversationRenderRows = useMemo(() => {
    const rows: ({ type: 'single'; message: SharedMessage } | { type: 'pair'; a: SharedMessage; b: SharedMessage })[] = [];
    for (let i = 0; i < renderedConversationMessages.length; i++) {
      const message = renderedConversationMessages[i];
      const next = renderedConversationMessages[i + 1];
      const isAgent = (m: SharedMessage) => m.author === 'codex' || m.author === 'claude';
      if (next && isAgent(message) && isAgent(next) && message.author !== next.author) {
        rows.push({ type: 'pair', a: message, b: next });
        i++;
      } else {
        rows.push({ type: 'single', message });
      }
    }
    return rows;
  }, [renderedConversationMessages]);
  // The visible thread is already capped to a handful of recent messages.
  // Keeping even completed rows in document flow removes the virtualizer's
  // cached-height transition: streamed Markdown can grow or settle at any
  // time without another bubble ever reusing its vertical space.
  useEffect(() => {
    if (!conversationId || selectionHydratedFor === conversationId || !conversationDetail.data?.conversation) return;
    setComposerSelection(composerSelectionFromConversation(conversationDetail.data.conversation));
    setSelectionHydratedFor(conversationId);
  }, [conversationId, conversationDetail.data?.conversation, selectionHydratedFor]);
  const send = useMutation({
    mutationFn: async ({ intent }: { intent: 'interject' | 'queue' }) => {
      const attachments = await Promise.all(files.map(async (file) => ({
        name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
        dataBase64: await new Promise<string>((resolveValue, reject) => {
          const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolveValue(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file);
        }),
      })));
      const created = await api.createSharedMessage(conversationId!, body, composerSelection.dispatchTarget, attachments, composerSelection.executionProfile, composerSelection.accountProfile);
      // A normal send can be dispatched synchronously by the create endpoint.
      // `replies` is definitive even if a stale API response labels the human
      // turn queued, so never try to interject a turn that is already claimed.
      if (intent !== 'interject' || created.replies.length > 0 || created.message.status !== 'queued') return { intent, pending: false };
      const interjection = await api.interjectSharedMessage(created.message.id);
      return { intent, pending: interjection.pending };
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
    onSuccess: async ({ intent, pending }) => {
      const sentDraft = sentDraftRef.current;
      if (sentDraft) {
        clearSentConversationDraft(sentDraft.conversationId, sentDraft.body);
        if (conversationIdRef.current === sentDraft.conversationId) setBody((current) => current === sentDraft.body ? '' : current);
      }
      sentDraftRef.current = null;
      setFiles([]);
      if (intent === 'interject') {
        toast.success(pending
          ? 'Interjecting. The current response will continue.'
          : 'Interjected. The current response will continue.');
      }
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
    onError: (error) => toastError('Could not approve the preview.', error),
  });
  const createConversation = useMutation({
    mutationFn: () => api.createSharedConversation(),
    onSuccess: async ({ conversation }) => {
      // A new conversation is always active; stay on the archive tab and it
      // silently disappears from the list you're looking at.
      if (conversationView !== 'active') setConversationView('active');
      setConversationId(conversation.id);
      // Selecting it is not enough on phone: the rail otherwise remains over
      // the console, making a successful creation look like a no-op.
      setRailOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not create a new conversation.', error),
    onSettled: () => { isCreatingConversationRef.current = false; },
  });
  function createNewConversation() {
    // React Query's pending state renders on the next paint. Keep this
    // synchronous guard too, so two rapid taps can never issue two creates.
    if (isCreatingConversationRef.current) return;
    isCreatingConversationRef.current = true;
    createConversation.mutate();
  }
  const setConversationTask = useMutation({
    mutationFn: (workItemId: string | null) => api.setSharedConversationTask(conversationId!, workItemId),
    onSuccess: async ({ conversation }) => {
      toast.success(conversation.workItemId ? 'Conversation linked to task.' : 'Conversation unlinked from task.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversation', conversation.id] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item'] }),
      ]);
    },
    onError: (error) => toastError('Could not update the conversation task link.', error),
  });
  const setConversationPinned = useMutation({
    mutationFn: (pinned: boolean) => api.setSharedConversationPinned(conversationId!, pinned),
    onSuccess: async ({ conversation }) => {
      toast.success(conversation.pinned ? 'Conversation pinned.' : 'Conversation unpinned.');
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
      queryClient.setQueryData(['shared-conversation', conversation.id], { conversation });
    },
    onError: (error) => toastError('Could not update the conversation pin.', error),
  });
  const deleteConversation = useMutation({
    mutationFn: async (id: string) => { setDeleteConversationPromptOpen(false); await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); await animateConversationExit(id); return api.deleteSharedConversation(id); },
    onSuccess: async (_result, deletedConversationId) => {
      setDeleteConversationPromptOpen(false);
      await queryClient.cancelQueries({ queryKey: ['shared-conversations'] });
      removeConversationFromCachedRails(deletedConversationId);
      // Do this only after the rail has the authoritative post-delete list.
      // Selecting null first lets its fallback effect select the stale cached
      // row again, leaving the console pointed at a just-deleted conversation.
      queryClient.removeQueries({ queryKey: ['shared-conversation', deletedConversationId] });
      queryClient.removeQueries({ queryKey: ['shared-messages', deletedConversationId] });
      const successorId = nextConversationIdAfterRemoval(deletedConversationId);
      setConversationId((current) => current === deletedConversationId ? successorId : current);
      toast.success('Conversation deleted.', { action: () => undeleteConversation.mutate(deletedConversationId), actionLabel: 'Undo', duration: 10_000 });
      void queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not delete the conversation.', error),
  });
  const undeleteConversation = useMutation({
    mutationFn: api.undeleteSharedConversation,
    onSuccess: async ({ conversation }) => {
      setConversationView(conversation.archivedAt ? 'archive' : 'active');
      setConversationId(conversation.id);
      setPendingSelectedConversation({ id: conversation.id, title: conversation.title });
      toast.success('Conversation restored.');
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not restore the conversation.', error),
  });
  const archiveConversation = useMutation({
    mutationFn: async (id: string) => { await animateConversationExit(id); return api.archiveSharedConversation(id); },
    onSuccess: async (_response, archivedConversationId) => {
      if (!linkedWorkItemId) setFeedbackTarget({ conversationId: archivedConversationId });
      if (!linkedWorkItemId) celebrate();
      toast.success(linkedWorkItemId ? 'Conversation and related task archived.' : 'Conversation archived.');
      await queryClient.cancelQueries({ queryKey: ['shared-conversations'] });
      removeConversationFromCachedRails(archivedConversationId);
      setConversationView('active');
      showConversationStackOnly();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item-counts'] }),
        linkedWorkItemId ? queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }) : Promise.resolve(),
      ]);
      void queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
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
      setFeedbackTarget({ conversationId, workItemId: item.id });
      celebrate();
      queryClient.setQueryData<WorkItemDetail>(['work-item', item.id], (current) => current && ({ ...current, item }));
      const completedConversationId = conversationId;
      toast.success('Task completed.', { description: item.title });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['archived-work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item-counts'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', item.id] }),
      ]);
      if (completedConversationId) {
        await queryClient.cancelQueries({ queryKey: ['shared-conversations'] });
        removeConversationFromCachedRails(completedConversationId);
      }
      setConversationView('active');
      showConversationStackOnly();
      void queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
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
  const cancelQueuedMessage = useMutation({
    mutationFn: api.cancelSharedReply,
    onMutate: (id: string) => {
      setExitingMessageIds((current) => new Set(current).add(id));
    },
    onSuccess: async (_result, id) => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 560));
      setExitingMessageIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] });
    },
    onError: (error, id) => {
      setExitingMessageIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      toastError('Could not cancel the queued message.', error);
    },
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
    onSuccess: ({ pending }) => {
      toast.success(pending
        ? 'Interjection queued. The current response will continue.'
        : 'Interjection sent. The current response will continue.');
      return queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] });
    },
    onError: (error) => toastError('Could not interject that message.', error),
  });
  // Rapid clicks on the agent-target select can fire several owner updates
  // before the first response lands. Serialize by sequence number so a
  // stale response never invalidates over a newer, still-in-flight change.
  const ownerMutationSeq = useRef(0);
  const updateConversationOwner = useMutation({
    mutationFn: async (target: 'both' | 'codex' | 'claude') => {
      const seq = ++ownerMutationSeq.current;
      const agents = target === 'both' ? ['codex' as const, 'claude' as const] : [target];
      const result = await api.updateWorkItem(linkedWorkItemId!, { assignees: agents });
      return { result, seq };
    },
    onSuccess: ({ seq }) => {
      if (seq !== ownerMutationSeq.current) return;
      void queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] });
    },
    onError: (error) => toastError('Could not update the conversation owner.', error),
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
    onError: (error) => toastError('Could not turn those findings into tasks.', error),
  });
  const resolvePlan = useMutation({
    mutationFn: ({ resolution, archiveParent = false }: { resolution: 'accepted' | 'rejected'; archiveParent?: boolean }) =>
      api.resolveExecutionPlan(proposedPlan!.id, resolution, resolution === 'accepted' ? [...selectedPlanTaskIndexes] : undefined, archiveParent),
    onSuccess: async (result, { resolution }) => {
      const archivedConversationId = resolution === 'accepted' && result.parentArchived ? conversationId : null;
      setProposedPlan(null);
      setProposedPlanConversationId(null);
      setPlanArchivePromptOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }),
      ]);
      if (archivedConversationId) {
        await queryClient.cancelQueries({ queryKey: ['shared-conversations'] });
        removeConversationFromCachedRails(archivedConversationId);
        setConversationView('active');
        showConversationStackOnly();
      }
      void queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not resolve the plan.', error),
  });
  const latestMessage = messages.data?.messages.at(-1);
  const latestMessageLength = latestMessage?.body.length ?? 0;
  const scrollThreadToLatest = (behavior: ScrollBehavior) => {
    const container = threadScrollRef.current;
    if (!container) return;
    // scrollIntoView also scrolls hidden ancestors. In the conversation layout
    // that moved the console header and view switch above the viewport.
    if (typeof container.scrollTo === 'function') container.scrollTo({ top: container.scrollHeight, behavior });
    else container.scrollTop = container.scrollHeight;
  };
  useEffect(() => {
    // Re-marking read on every streamed token (via latestMessageLength) fired
    // this call as often as every 750ms for the whole duration of a run — by
    // far the single most frequent API call in the activity log. A message
    // only becomes newly-unread when it's appended or finishes, so key off
    // count + status instead of the constantly-growing streamed body length.
    if (!conversationId) return;
    setLocallyReadConversationIds((current) => current.has(conversationId) ? current : new Set(current).add(conversationId));
    void api.markSharedConversationRead(conversationId)
      .then(() => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation-unread-count'] }),
      ]))
      .catch(() => undefined);
  }, [conversationId, messages.data?.messages.length, latestMessage?.status, queryClient]);
  useEffect(() => {
    // Only follow new streaming output while the user is already near the
    // bottom; once they scroll up to read history, stop yanking them back
    // and instead flag that new activity is waiting below the fold.
    if (isNearThreadBottomRef.current) scrollThreadToLatest('smooth');
    else setHasNewActivityBelow(true);
  }, [messages.data?.messages.length, latestMessageLength, proposedPlan]);
  useEffect(() => {
    // Switching conversations always lands the reader at the newest message.
    isNearThreadBottomRef.current = true;
    setThreadVisibleCount(THREAD_PAGE_SIZE);
    setHasNewActivityBelow(false);
    setMobileHeaderOpen(false);
    setMobileComposerOpen(false);
  }, [conversationId]);
  useEffect(() => {
    const container = threadScrollRef.current;
    if (!container) return;
    const nearBottomThreshold = 120;
    const updateNearBottom = () => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= nearBottomThreshold;
      isNearThreadBottomRef.current = nearBottom;
      if (nearBottom) setHasNewActivityBelow(false);
    };
    updateNearBottom();
    container.addEventListener('scroll', updateNearBottom, { passive: true });
    return () => container.removeEventListener('scroll', updateNearBottom);
  }, [conversationId]);
  const jumpToLatest = () => {
    isNearThreadBottomRef.current = true;
    setHasNewActivityBelow(false);
    scrollThreadToLatest('smooth');
  };
  // Sending before the agent target / conversation state has finished
  // initializing for this conversation can dispatch to the wrong agent.
  const conversationReadyToSend = Boolean(conversationId) && selectionHydratedFor === conversationId && !messages.isLoading;

  function submit(event: FormEvent) {
    event.preventDefault();
    if ((body.trim() || files.length) && conversationId && !send.isPending && conversationReadyToSend) {
      sentDraftRef.current = { conversationId, body };
      send.mutate({ intent: 'queue' });
    }
  }

  const previewStatus = useQuery({ queryKey: ['runtime-preview-status'], queryFn: api.getRuntimePreviewStatus, refetchInterval: 2_000 });
  const promotionInFlight = conversationMessages.some((message) =>
    message.author === 'system' && message.status === 'running' && /approval received|promot/i.test(message.body));
  const agentWorkInFlight = conversationMessages.some((message) =>
    (message.author === 'codex' || message.author === 'claude') && (message.status === 'queued' || message.status === 'running'));
  const latestCompletedAgentIndex = conversationMessages.reduce((latest, message, index) =>
    (message.author === 'codex' || message.author === 'claude') && message.status === 'completed' ? index : latest, -1);
  const latestPreviewApprovalRequestIndex = conversationMessages.reduce((latest, message, index) =>
    message.author === 'jeffrey' && /^\s*approve(?:\s+(?:the\s+)?)?(?:workbench\s+)?preview[.!]?\s*$/i.test(message.body) ? index : latest, -1);
  // A successful promotion can either be the worker's own completion or a
  // queued approval that was folded into that same release. Both are durable
  // completed promotion records. Do not infer this workflow state from the
  // display copy. The text fallback is only for records written before the
  // promotion dispatch target existed.
  const latestPreviewPromotionIndex = conversationMessages.reduce((latest, message, index) =>
    message.author === 'system' && message.status === 'completed'
      && (String(message.dispatchTarget) === 'promotion' || /preview approved and promoted/i.test(message.body)) ? index : latest, -1);
  const latestSuccessfulPromotion = latestPreviewPromotionIndex >= 0 ? conversationMessages[latestPreviewPromotionIndex] : null;
  const completionPromptAvailable = Boolean(
    latestSuccessfulPromotion
    && linkedWorkItem.data?.item
    && !linkedTaskCompleted
    && dismissedCompletionPromptPromotionId !== latestSuccessfulPromotion.id,
  );
  const approvalRequestOutstanding = latestPreviewApprovalRequestIndex > Math.max(latestCompletedAgentIndex, latestPreviewPromotionIndex);
  const previewApprovalAvailable = !approvalRequestOutstanding
    // The source fingerprint is authoritative. Conversation history only
    // prevents duplicate requests; an old completed reply must not recreate
    // the banner after its source snapshot was promoted.
    // A pending fingerprint is global to the editable Workbench tree. It must
    // not turn every newly opened, empty conversation into a release prompt.
    // Only the conversation that has actually produced completed agent work is
    // a useful place to offer approval.
    && latestCompletedAgentIndex >= 0
    && Boolean(previewStatus.data?.pending) && !promotionInFlight && !agentWorkInFlight;

  return (
    <main className={`shared-workspace ${railOpen ? 'rail-open' : ''} ${showingConversationStackOnly ? 'stack-only' : ''}`}>
      <aside id="conversation-rail" className="conversation-rail" aria-label="Conversations">
        <header className="stack-toolbar"><div className="stack-toolbar-copy"><span className="eyebrow">Conversations</span><h2>Conversations</h2></div><div className="conversation-header-actions"><button className="icon-button" onClick={createNewConversation} disabled={createConversation.isPending} aria-label="New conversation" title={createConversation.isPending ? 'Creating conversation…' : 'New conversation'}><Plus size={15} /></button></div></header>
        <div className="search-box">
          <Search size={15} />
          <input
            aria-label="Search conversations"
            value={conversationSearch}
            onChange={(event) => setConversationSearch(event.target.value)}
            placeholder="Search conversations…"
          />
          {conversationSearch && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setConversationSearch('')}><X size={13} /></button>}
        </div>
        {debouncedConversationSearch ? (
          <div className="conversation-tabs">
            {conversationSearchResults.isLoading && <ConversationSearchResultSkeleton />}
            {conversationSearchResults.isError && <div className="page-state error-message">Search failed. <button className="button secondary compact" onClick={() => conversationSearchResults.refetch()}>Retry</button></div>}
            {!conversationSearchResults.isLoading && !conversationSearchResults.isError && (conversationSearchResults.data?.results.length ?? 0) === 0 && (
              <div className="page-state">No matches for “{debouncedConversationSearch}”.</div>
            )}
            {conversationSearchResults.data?.results.map((result) => (
              <div key={`${result.type}-${result.messageId ?? result.conversationId}`} className="virtual-row" style={{ position: 'static' }}>
                <button
                  className={result.conversationId === conversationId ? 'active' : ''}
                  onClick={() => {
                    setShowingConversationStackOnly(false);
                    setConversationId(result.conversationId);
                    setPendingSelectedConversation({ id: result.conversationId, title: result.conversationTitle });
                    setConversationSearch('');
                    setRailOpen(false);
                  }}
                >
                  <span className="conversation-tab-title"><strong>{result.conversationTitle || 'Untitled conversation'}</strong></span>
                  <small>{result.snippet}</small>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <>
            <Tabs ariaLabel="Conversation view" className="conversation-view-tabs" panelClassName="conversation-tab-panel" selected={conversationView} onSelect={selectConversationView} items={[
              { value: 'active', label: 'Active' },
              { value: 'archive', label: 'Archive' },
            ]}>
            <div ref={conversationScrollRef} className="conversation-tabs">
              <div className="virtual-list" style={{ height: conversationVirtualizer.getTotalSize() }}>
                {displayedConversationRows.map((virtualRow) => {
                  const row = conversationStackRows[virtualRow.index];
                  if (!row) return null;
                  if (row.type === 'header') return <div key={row.id} ref={conversationVirtualizer.measureElement} data-index={virtualRow.index} className="virtual-row" style={{ transform: `translateY(${virtualRow.start}px)` }}><div className={`stack-header conversation-stack-header stack-header-${row.group}`}><span>{row.label}</span><strong>{row.count}</strong></div></div>;

                  const { conversation, state } = row;
                  const isUnread = Boolean(conversation.isUnread && !locallyReadConversationIds.has(conversation.id) && conversation.id !== conversationId);
                  const stateLabel = state === 'working' ? 'Working' : state === 'needs_attention' ? 'Failed or canceled' : state === 'waiting_approval' ? 'Review follow-ups' : state === 'promoting' ? 'Approved · promoting preview' : state === 'waiting_promotion' ? 'Approved and waiting promotion' : state === 'finished' ? 'Awaiting' : null;
                  const stateClass = state;
                  const color = conversation.linkedProjectName ? projectTheme(conversation.linkedProjectName) : null;
                  const cardStyle = color ? { '--task-accent': color.accent, '--task-tint': color.tint, '--task-border': color.border } as CSSProperties : undefined;
                  return <div key={conversation.id} ref={conversationVirtualizer.measureElement} data-index={virtualRow.index} className="virtual-row" style={{ transform: `translateY(${virtualRow.start}px)` }}><button style={cardStyle} className={`stack-card ${conversation.id === conversationId ? 'active' : ''} ${isUnread ? 'conversation-unread' : 'conversation-read'} ${conversation.linkedProjectName ? 'project-colored' : ''} ${stateClass ? `conversation-${stateClass}` : ''} ${exitingConversationIds.has(conversation.id) ? 'conversation-exiting' : ''}`} onClick={() => { setShowingConversationStackOnly(false); setConversationId(conversation.id); setRailOpen(false); }}><span className="conversation-tab-title">{conversation.linkedProjectName && <ProjectColorDot projectName={conversation.linkedProjectName} labelled />}<strong>{conversation.title}</strong>{(conversation.pinned || conversation.linkedWorkItemPinned) && <span className="conversation-pinned-marker" aria-label={conversation.pinned ? 'Pinned conversation' : 'Pinned task'} title={conversation.pinned ? 'Pinned conversation' : 'Pinned task'}><Pin size={10} fill="currentColor" aria-hidden="true" /></span>}{isUnread && <span className="conversation-unread-marker">New</span>}{stateLabel && <span className={`conversation-state conversation-state-${state}`}>{(state === 'working' || state === 'promoting') && <LoaderCircle className="spin" size={10} />}{state === 'waiting_promotion' && <Clock size={10} />}{stateLabel}</span>}</span><small className="conversation-tab-meta"><ConversationOriginBadge workItemId={conversation.workItemId} /><span>{state === 'working' ? 'Agent working…' : state === 'promoting' ? 'Promoting preview…' : state === 'waiting_promotion' ? 'Waiting to promote…' : new Date(conversation.updatedAt).toLocaleDateString()}</span></small></button></div>;
                })}
              </div>
              {conversations.isLoading && <ConversationRailSkeleton count={6} />}
              {conversations.isError && conversationList.length === 0 && (
                <div className="page-state error-message">Could not load conversations. <button type="button" className="button secondary compact" onClick={() => conversations.refetch()}>Retry</button></div>
              )}
              {!conversations.isLoading && !conversations.isError && conversationList.length === 0 && <div className="page-state">No {conversationView} conversations.</div>}
              {conversations.isFetchingNextPage && <ConversationRailSkeleton count={2} />}
            </div>
            </Tabs>
          </>
        )}
      </aside>
      <section className="agent-console" aria-label="Shared agent workspace">
        <header id="conversation-header" className={`agent-console-header${mobileHeaderOpen ? '' : ' is-mobile-header-collapsed'}`}><button type="button" className="mobile-detail-close icon-button" aria-label="Close conversation" onClick={() => setRailOpen(true)}><X size={16} /></button><div className="agent-console-title">{selectedConversation ? <ConversationOriginBadge workItemId={selectedConversation.workItemId} /> : <span className="eyebrow">Shared context</span>}<h2>{selectedConversation?.title
              ?? (pendingSelectedConversation?.id === conversationId ? pendingSelectedConversation.title
                  : conversationDetail.isLoading ? <span className="conversation-title-skeleton"><Skeleton width="240px" height="19px" /></span>
                  : selectedConversationMissing ? 'Conversation not found'
                  : 'New conversation')}</h2>{linkedWorkItem.data?.item && onOpenTask && <button type="button" className="related-task-link" onClick={() => onOpenTask(linkedWorkItem.data!.item.id)}><ArrowLeft size={12} /> Back to task</button>}</div>{conversationId && selectedConversation && <div className="conversation-window-actions"><button type="button" className="icon-button" onClick={() => setDecisionTreeOpen(true)} aria-label="Open agent decision tree" title="Open agent decision tree"><GitBranch size={14} /></button>{!selectedConversation.workItemId && <ConversationTaskPicker tasks={linkableTasks.data?.items ?? []} isLoading={linkableTasks.isLoading} isError={linkableTasks.isError} isPending={setConversationTask.isPending} onRetry={() => void linkableTasks.refetch()} onSelect={(workItemId) => setConversationTask.mutate(workItemId)} />}{selectedConversation.workItemId && <button type="button" className="icon-button conversation-unlink-task" onClick={() => setConversationTask.mutate(null)} disabled={setConversationTask.isPending} aria-label="Unlink task" title="Unlink task"><Link2Off size={14} /></button>}{linkedWorkItem.data?.item && <button type="button" className="icon-button complete-task-button" disabled={linkedTaskCompleted || completeLinkedTask.isPending} onClick={() => completeLinkedTask.mutate()} aria-label={linkedTaskCompleted ? 'Task completed' : 'Complete linked task'} title={linkedTaskCompleted ? 'Task completed' : 'Complete linked task'}>{completeLinkedTask.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}</button>}<button className="icon-button" onClick={() => forkConversation.mutate(conversationId)} aria-label="Fork conversation" title="Fork into a new conversation"><MessageSquarePlus size={14} /></button>{conversationView === 'active' ? <button className="icon-button" onClick={() => archiveConversation.mutate(conversationId)} aria-label="Archive conversation" title="Archive conversation"><Archive size={14} /></button> : <button className="icon-button" onClick={() => restoreConversation.mutate(conversationId)} aria-label="Restore conversation" title="Restore conversation"><RefreshCw size={14} /></button>}<span className={`conversation-delete-control ${selectedConversation.workItemId ? 'is-disabled' : ''}`} tabIndex={selectedConversation.workItemId ? 0 : undefined}><button className="icon-button delete-conversation-button" disabled={Boolean(selectedConversation.workItemId)} onClick={() => setDeleteConversationPromptOpen(true)} aria-label="Delete conversation" aria-describedby={selectedConversation.workItemId ? 'linked-conversation-delete-help' : undefined} title={selectedConversation.workItemId ? undefined : 'Delete permanently'}><Trash2 size={14} /></button>{selectedConversation.workItemId && <span id="linked-conversation-delete-help" className="action-tooltip" role="tooltip">Delete the related task to delete this conversation.</span>}</span></div>}</header>
        <div className="mobile-chrome-controls"><button type="button" className={`mobile-chrome-toggle icon-button${mobileHeaderOpen ? ' icon-button-active' : ''}`} onClick={() => setMobileHeaderOpen((open) => !open)} aria-label={mobileHeaderOpen ? 'Collapse conversation header' : 'Expand conversation header'} title={mobileHeaderOpen ? 'Collapse conversation header' : 'Expand conversation header'}><PanelTop size={16} /></button><button type="button" className={`mobile-chrome-toggle icon-button${mobileComposerOpen ? ' icon-button-active' : ''}`} onClick={() => setMobileComposerOpen((open) => !open)} aria-label={mobileComposerOpen ? 'Collapse composer' : 'Expand composer'} title={mobileComposerOpen ? 'Collapse composer' : 'Expand composer'}><SquarePen size={16} /></button></div>
        {conversationId && <div className="thread-filter-bar"><div className="conversation-surface-tabs" role="group" aria-label="Conversation review layout"><button type="button" aria-pressed={activePane === 'conversation'} onClick={() => setActivePane('conversation')}>Conversation</button><button type="button" aria-pressed={activePane === 'split'} onClick={() => setActivePane('split')} disabled={!changesAvailability.hasChanges && !changesAvailability.isError} title={changesAvailability.hasChanges ? 'Review changes alongside the conversation' : 'No changes to review'}><FileDiff size={13} /> Split</button><button type="button" aria-pressed={activePane === 'changes'} onClick={() => setActivePane('changes')} disabled={!changesAvailability.hasChanges && !changesAvailability.isError} title={changesAvailability.hasChanges ? 'Review changes' : changesAvailability.isError ? 'Could not check for changes' : changesAvailability.isLoading ? 'Checking for changes…' : 'No changes to review'}><FileDiff size={13} /> Changes</button></div>{changesAvailability.isError && <button type="button" className="button secondary compact" onClick={() => void changesAvailability.retry()} disabled={changesAvailability.isLoading}>Retry</button>}{selectedConversation && <button type="button" className={`icon-button${selectedConversation.pinned ? ' icon-button-active' : ''}`} onClick={() => setConversationPinned.mutate(!selectedConversation.pinned)} disabled={setConversationPinned.isPending} aria-pressed={Boolean(selectedConversation.pinned)} aria-label={selectedConversation.pinned ? 'Unpin conversation' : 'Pin conversation'} title={selectedConversation.pinned ? 'Unpin conversation' : 'Pin conversation'}><Pin size={13} fill={selectedConversation.pinned ? 'currentColor' : 'none'} /></button>}{linkedWorkItem.data?.item && <TaskClassificationSelect itemId={linkedWorkItem.data.item.id} kind={linkedWorkItem.data.item.classificationKind} disclosure />}</div>}
        <div className={`conversation-review-layout layout-${activePane}`}>
        <div className="conversation-thread-pane">
        <div className="shared-thread" ref={threadScrollRef}>
          {conversationDetail.isLoading && <ConversationThreadSkeleton />}
          {selectedConversationMissing && (
            <div className="list-state compact-state error-message">
              This conversation could not be found. It may have been deleted.
              <button type="button" className="button secondary compact" onClick={() => conversationDetail.refetch()}>Retry</button>
            </div>
          )}
          {!conversationDetail.isLoading && messages.isLoading && <ConversationThreadSkeleton />}
          {messages.error && <div className="list-state compact-state error-message">Could not load shared messages: {messages.error.message} <button type="button" className="button secondary compact" onClick={() => messages.refetch()}>Retry</button></div>}
          {!messages.isLoading && !messages.error && !selectedConversationMissing && messages.data?.messages.length === 0 && <div className="list-state compact-state">No messages yet. Ask Codex or Claude to get started.</div>}
          {hasEarlierMessages && (
            <button
              type="button"
              className="show-more-history-button"
              onClick={() => {
                isNearThreadBottomRef.current = false;
                setThreadVisibleCount((current) => current + THREAD_PAGE_SIZE);
              }}
            >
              Show earlier messages ({allConversationMessages.length - threadVisibleCount} more)
            </button>
          )}
          <div className="thread-virtualizer thread-live-flow">
          {conversationRenderRows.map((row) => {
            const renderMessage = (message: SharedMessage, inGroup: boolean) => {
              const isAgentMessage = message.author === 'codex' || message.author === 'claude';
              const isQueuedMessage = message.status === 'queued';
              // Interjections are live input to a specific running provider.
              // Repeat Jeffrey's text in that provider's stream so the result
              // is visible where the interruption happened, not only as a
              // status label on his separate message bubble.
              const liveInterjections: AgentMessageInterjection[] = isAgentMessage
                ? conversationMessages
                  .filter((candidate) => candidate.author === 'jeffrey'
                    && (candidate.queuePriority ?? 0) > 0
                    && (candidate.status === 'queued' || candidate.status === 'completed')
                    && candidate.createdAt >= message.createdAt
                    && (candidate.dispatchTarget === 'auto' || candidate.dispatchTarget === 'both' || candidate.dispatchTarget === message.author))
                  .map((candidate) => ({ id: candidate.id, body: candidate.body, pending: candidate.status === 'queued', streamOffset: candidate.interjectionStreamOffset }))
                : [];
              // A completed reply that absorbed an interjection mid-stream should
              // read as separate before/after bubbles, not one answer that quietly
              // swallowed Jeffrey's input. Only split once the interjection has a
              // server-recorded boundary — a still-queued one has nowhere to land yet.
              const segments = isAgentMessage && message.status !== 'running' && message.body
                ? splitBodyAtInterjections(message.body, liveInterjections)
                : null;
              const splitIntoBubbles = (segments?.length ?? 0) > 1;

              const renderHeader = (showSummaryBadges: boolean) => (
                <header><strong>{message.author === 'jeffrey' ? 'You' : message.author}</strong><time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                  {message.author === 'jeffrey' && message.dispatchTarget !== 'none' && <span className="recipient-badge">To {message.dispatchTarget === 'both' ? 'Codex + Claude' : message.dispatchTarget === 'auto' ? 'an agent' : message.dispatchTarget[0].toUpperCase() + message.dispatchTarget.slice(1)}</span>}
                  {showSummaryBadges && isAgentMessage && <button
                    type="button"
                    className={`memory-badge${typeof message.retrievedMemoryCount === 'number' ? '' : ' memory-badge-not-run'}`}
                    disabled={typeof message.retrievedMemoryCount !== 'number'}
                    onClick={() => setRetrievedMemoryMessageId(message.id)}
                    title={typeof message.retrievedMemoryCount === 'number'
                      ? message.retrievedMemoryCount > 0
                        ? `Retrieved ${message.retrievedMemoryCount} memory match${message.retrievedMemoryCount === 1 ? '' : 'es'} from RAG for this reply — click to view`
                        : 'RAG memory search ran but found no matches'
                      : 'RAG memory retrieval did not run for this message'}
                  >
                    <Search size={11} /> {typeof message.retrievedMemoryCount === 'number' ? message.retrievedMemoryCount : '—'}
                  </button>}
                  {showSummaryBadges && <span className="header-badge-row">
                    {message.model && <span className="model-badge" title={formatRunTelemetry(message)}>{replyBadge(message)}</span>}
                  </span>}
                  {showSummaryBadges && isAgentMessage && liveInterjections.length > 0 && <span className={`interjection-badge${liveInterjections.some((interjection) => interjection.pending) ? ' pending' : ''}`}>{liveInterjections.some((interjection) => interjection.pending) ? 'Interjecting' : 'Interjected'}</span>}
                  {message.status === 'running' && <button type="button" className="cancel-response" onClick={() => cancelReply.mutate(message.id)} disabled={cancelReply.isPending} aria-label="Cancel response" title="Cancel response"><X size={12} /></button>}
                </header>
              );

              const renderFooter = () => (<>
                {isQueuedMessage && (
                  <div className="queued-message">
                    <span className="queued-message-status"><LoaderCircle size={13} /> {message.queuePriority ? 'Starting now · current response continues' : 'Queued · starts after the current agent finishes'}</span>
                    {message.author !== 'system' && <span className="queued-message-actions">
                    <button type="button" className="icon-button queued-message-action" onClick={() => interjectMessage.mutate(message.id)} disabled={interjectMessage.isPending} aria-label="Interject now without stopping the current agent" title="Interject now without stopping the current agent"><ArrowUpRight size={14} /></button>
                      <button type="button" className="icon-button queued-message-action danger" onClick={() => message.author === 'jeffrey' ? cancelQueuedMessage.mutate(message.id) : cancelReply.mutate(message.id)} disabled={cancelQueuedMessage.isPending || cancelReply.isPending} aria-label="Cancel queued message" title="Cancel this queued message"><X size={14} /></button>
                    </span>}
                  </div>
                )}
                {message.status === 'canceled' && <p className="muted">Response canceled.</p>}
                {(message.author === 'codex' || message.author === 'claude') && (message.status === 'failed' || message.status === 'canceled') && <div className="message-actions"><button onClick={() => retryReply.mutate(message)} disabled={retryReply.isPending}><RefreshCw size={12} /> Retry / continue</button></div>}
                {message.attachments.length > 0 && <div className="message-files">{message.attachments.map((file) => (
                  <a key={file.path} href={`/api/artifacts/raw?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(message.conversationId)}`} target="_blank" rel="noreferrer" title={`${file.mimeType} · ${formatFileSize(file.size)}`}>
                    <Paperclip size={11} /> {file.name} <span className="message-file-meta">{formatFileSize(file.size)}</span>
                  </a>
                ))}</div>}
                {message.error && <p className="error-message">{message.error}</p>}
                {message.status === 'completed' && message.author !== 'jeffrey' && (message.author !== 'system' || message.body.startsWith('Synthesis:')) && <div className="message-actions"><button onClick={() => createTasks.mutate({ messageId: message.id, conversationId: conversationId! })} disabled={createTasks.isPending && createTasks.variables?.conversationId === conversationId}>{createTasks.isPending && createTasks.variables?.messageId === message.id && createTasks.variables.conversationId === conversationId ? <><LoaderCircle className="spin" size={12} /> Extracting findings…</> : <><Plus size={12} /> Turn findings into tasks</>}</button></div>}
              </>);

              if (splitIntoBubbles && segments) {
                return <div key={message.id} className={`thread-virtual-row thread-segmented-message${inGroup ? ' reply-group-message' : ''}`}>
                  {segments.map((segment, index) => {
                    const isLast = index === segments.length - 1;
                    return <div key={`${message.id}-segment-${index}`} className="shared-message-segment-group">
                      {segment.precedingInterjection && (
                        <article className="shared-message shared-jeffrey shared-message-interjection">
                          <header><strong>You</strong><span className="interjection-badge">Interjected</span></header>
                          <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode, pre: MarkdownPre }}>{segment.precedingInterjection.body}</ReactMarkdown></div>
                        </article>
                      )}
                      <article className={`shared-message shared-${message.author}${exitingMessageIds.has(message.id) ? ' shared-message-exiting' : ''}`}>
                        {renderHeader(isLast)}
                        <AgentMessageBody body={segment.body} running={false} conversationId={message.conversationId} interjections={[]} detailForSingle />
                        {isLast && renderFooter()}
                      </article>
                    </div>;
                  })}
                </div>;
              }

              return <div key={message.id} className={`thread-virtual-row${inGroup ? ' reply-group-message' : ''}`}>
              <article className={`shared-message shared-${message.author}${message.author === 'system' && message.status === 'queued' ? ' shared-system-queued' : ''}${exitingMessageIds.has(message.id) ? ' shared-message-exiting' : ''}`}>
                {renderHeader(true)}
                {message.status === 'running' && <p className="thinking">Live activity · {message.body ? 'receiving updates' : 'starting agent'}</p>}
                {(message.body || liveInterjections.length > 0 || (isAgentMessage && message.status === 'running')) && (isAgentMessage || message.author === 'system'
                  ? <AgentMessageBody body={message.body} running={message.status === 'running'} conversationId={message.conversationId} interjections={liveInterjections} detailForSingle={message.status !== 'running'} typewriteOnCompletion={message.author === 'system' && message.body.startsWith('Synthesis:')} />
                  : <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode, pre: MarkdownPre }}>{message.body}</ReactMarkdown></div>)}
                {renderFooter()}
              </article>
              </div>;
            };
            if (row.type === 'single') return renderMessage(row.message, false);
            const runningCount = [row.a, row.b].filter((message) => message.status === 'running').length;
            return <div key={`${row.a.id}-${row.b.id}`} className="thread-virtual-row reply-group">
              <div className="reply-group-header">{runningCount > 0 ? `${runningCount} agent${runningCount > 1 ? 's' : ''} responding` : 'Codex + Claude replied'}</div>
              <div className="reply-group-columns">
                {renderMessage(row.a, true)}
                {renderMessage(row.b, true)}
              </div>
            </div>;
          })}
          </div>
          {completionPromptAvailable && <div className="completion-prompt" role="status"><span><strong>Preview approved successfully.</strong><small>Complete the linked task?</small>{completeLinkedTask.error && <small className="completion-prompt-error">Could not complete the task. Try again.</small>}</span><div><button type="button" className="button secondary compact" onClick={() => setDismissedCompletionPromptPromotionId(latestSuccessfulPromotion!.id)}>Not yet</button><button type="button" className="button primary compact" onClick={() => completeLinkedTask.mutate()} disabled={completeLinkedTask.isPending}>{completeLinkedTask.isPending ? <><LoaderCircle className="spin" size={12} /> Completing…</> : <><Check size={12} /> Complete task</>}</button></div></div>}
          {previewApprovalAvailable && <div className="preview-approval"><span><strong>Workbench preview has unpublished changes</strong><small>Review them on port 5181, then promote this source snapshot to live.</small></span><button className="button primary compact" onClick={() => approvePreview.mutate()} disabled={approvePreview.isPending}>{approvePreview.isPending ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />} {approvePreview.isPending ? 'Approving…' : 'Approve preview'}</button></div>}
          {previewApprovalAvailable && approvePreview.error && <p className="error-message">Could not approve preview: {approvePreview.error.message}</p>}
          {proposedPlan && proposedPlanConversationId === conversationId && <article className="chat-plan"><span className="eyebrow">Proposed follow-up tasks</span><h3>{proposedPlan.summary}</h3><ol>{proposedPlan.tasks.map((task, index) => <li key={`${task.title}-${index}`}><label><input type="checkbox" checked={selectedPlanTaskIndexes.has(index)} onChange={() => setSelectedPlanTaskIndexes((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{task.title}</strong><p>{task.description}</p></span></label></li>)}</ol><div><button className="button secondary" onClick={() => resolvePlan.mutate({ resolution: 'rejected' })}>Reject</button><button className="button primary" disabled={selectedPlanTaskIndexes.size === 0 || resolvePlan.isPending} onClick={() => setPlanArchivePromptOpen(true)}><Check size={14} /> Add {selectedPlanTaskIndexes.size} to queue</button></div></article>}
          {createTasks.isPending && createTasks.variables?.conversationId === conversationId && <div className="finding-progress"><LoaderCircle className="spin" size={15} /><span><strong>Turning findings into tasks</strong><small>Reading the report and producing self-contained queue items…</small></span></div>}
          {createTasks.error && createTasks.variables?.conversationId === conversationId && <div className="finding-progress error-message"><X size={15} /><span><strong>Could not create tasks</strong><small>{createTasks.error.message}</small></span></div>}
          <div ref={endRef} />
          {hasNewActivityBelow && <button type="button" className="jump-to-latest-button" onClick={jumpToLatest}><ArrowDown size={13} /> New activity · Jump to latest</button>}
        </div>
        {conversationDetail.isLoading ? <ConversationComposerSkeleton /> : conversationView === 'archive' ? <div className="archived-composer-note"><Archive size={14} /> Archived conversation · restore or fork it to continue</div> : <form id="conversation-composer" className={`shared-composer${mobileComposerOpen ? '' : ' is-mobile-composer-collapsed'}`} onSubmit={submit}>
          {files.length > 0 && <div className="pending-files">{files.map((file) => <button type="button" key={`${file.name}-${file.size}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><Paperclip size={11} /> {file.name} <X size={10} /></button>)}</div>}
          <MarkdownComposer conversationId={conversationId} value={body} onChange={updateBody} placeholder="Message Codex or Claude…" ariaLabel="Message Codex or Claude" onSubmit={() => {
            if ((body.trim() || files.length) && conversationId && !send.isPending && conversationReadyToSend) {
              sentDraftRef.current = { conversationId, body };
              send.mutate({ intent: 'queue' });
            }
          }} disabled={send.isPending} />
          <div className="composer-toolbar">
            <input ref={fileRef} className="visually-hidden" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
            <button type="button" className="composer-tool attach-button" onClick={() => fileRef.current?.click()} aria-label="Attach files" title="Attach files"><Paperclip size={14} /></button>
            <span className="composer-hint">Files, screenshots, or context</span>
            <ModelProfileSelect className="model-target" value={composerSelection.executionProfile} onChange={setExecutionProfile} disabled={selectionHydratedFor !== conversationId} />
            <select className="agent-target account-target" value={composerSelection.accountProfile} onChange={(event) => updateComposerPreferences({ accountProfile: event.target.value })} aria-label="Account profile" disabled={agentAccounts.isLoading || selectionHydratedFor !== conversationId}>
              {accountProfiles.map((account) => <option key={account.name} value={account.name}>{account.name === 'default' ? 'Default' : account.name}</option>)}
            </select>
            <select className="agent-target dispatch-target" value={composerSelection.dispatchTarget} onChange={(event) => { const target = event.target.value as ConversationDispatchTarget; updateComposerPreferences({ dispatchTarget: target }); if (linkedWorkItemId && !linkedTaskIsSelfAssigned) updateConversationOwner.mutate(target); }} aria-label="Who should respond" disabled={selectionHydratedFor !== conversationId}>
              <option value="codex">Codex</option><option value="claude">Claude</option><option value="both">Both</option>
            </select>
            <button className="icon-button primary composer-send" aria-label="Send message" title="Send message" disabled={(!body.trim() && files.length === 0) || !conversationId || send.isPending || !conversationReadyToSend}>{send.isPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
          </div>
          {send.error && <p className="error-message">{send.error.message}</p>}
        </form>}
        </div>
        {(activePane === 'changes' || activePane === 'split') && workspaceDiffScope && <div className="conversation-changes" aria-label="Conversation changes"><WorkspaceDiffView scope={workspaceDiffScope} isRunning={linkedWorkItem.data?.runs.some((run) => run.status === 'queued' || run.status === 'running') ?? false} defaultCommitMessage={`chore: ${selectedConversation?.title ?? 'update'}`} onFollowUp={addDiffFollowUp} />{linkedWorkItem.data?.item && <GitHubDiffView sourceUrl={linkedWorkItem.data.item.sourceUrl} references={linkedWorkItem.data.references} onFollowUp={addDiffFollowUp} />}</div>}
        </div>
      </section>
      {planArchivePromptOpen && <FollowUpArchiveDialog count={selectedPlanTaskIndexes.size} pending={resolvePlan.isPending} onClose={() => setPlanArchivePromptOpen(false)} onChoose={(archiveParent) => resolvePlan.mutate({ resolution: 'accepted', archiveParent })} />}
      {deleteConversationPromptOpen && conversationId && <ConfirmationDialog title="Delete this conversation?" description="This permanently deletes the conversation and cannot be undone." confirmLabel="Delete conversation" pending={deleteConversation.isPending} onClose={() => setDeleteConversationPromptOpen(false)} onConfirm={() => deleteConversation.mutate(conversationId)} />}
      {retrievedMemoryMessageId && <RetrievedMemoryDialog detail={retrievedMemoryDetail.data?.detail} loading={retrievedMemoryDetail.isLoading} onClose={() => setRetrievedMemoryMessageId(null)} />}
      {decisionTreeOpen && <DecisionTreeVisualizer messages={allConversationMessages} events={agentStreamEvents.data?.events ?? []} isLoadingEvents={agentStreamEvents.isLoading} onClose={() => setDecisionTreeOpen(false)} />}
      {feedbackTarget && <SessionFeedbackPrompt onSubmit={async (rating: SessionFeedbackRating) => { await api.createSessionFeedback({ ...feedbackTarget, rating }); setFeedbackTarget(null); await queryClient.invalidateQueries({ queryKey: ['session-feedback'] }); }} />}
    </main>
  );
}
