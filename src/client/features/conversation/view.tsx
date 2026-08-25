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
  LoaderCircle,
  Menu,
  MessageCircle,
  MessageSquarePlus,
  Link2,
  Link2Off,
  Paperclip,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
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
import type { AgentRun, Assignee, ExecutionPlan, ProviderSyncConflict, SharedConversation, SharedMessage, UpdateWorkItemInput, WorkItem, WorkItemDetail, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../../../shared/contracts';
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
import { AgentMessageBody, LiveRunOutput } from '../../agent-message';
import { ConversationOriginBadge, ModelProfileSelect, ReferenceTypeIcon } from '../../badges';
import { CreateTask } from '../../create-task-dialog';
import { DiscoveryInboxView } from '../../discovery';
import { useNavigation } from '../../features/navigation/hooks';
import { NavigationView } from '../../features/navigation/view';
import { FollowUpArchiveDialog } from '../../follow-up-archive-dialog';
import { activityKindLabel, agentDecisionKinds, formatCostUsd, formatFileSize, formatRunTelemetry, sourceLinkLabel, sourceReferenceTitle, sourceReferenceType, taskDetailSaveFeedback } from '../../formatters';
import { clearSentConversationDraft, readConversationDrafts, readConversationModelProfiles, readLastOpenedItem, readTaskModelProfiles, writeConversationDraft, writeConversationModelProfiles, writeLastOpenedItem, writeTaskModelProfile } from '../../preferences';
import { QueueExplanationList } from '../../queue-explanations';
import { ProjectColorDot, projectTheme } from '../../project-color';
import { InlineProjectEditor } from '../../project-field';
import { isWorkbenchProject, WORKBENCH_PROJECT_NAME } from '../../../shared/project-name';
import { SourcesDialog } from '../../sources-dialog';
import { createTaskStackViewModel } from '../../stack-view-model';
import { useRealtimeNotifications, type RealtimeNotification } from '../../realtime';
import { conversationData, conversationQueryKeys } from './data';
import { celebrate } from '../../celebrate';
import { useDebouncedValue } from './hooks';

const CONVERSATION_ROW_GAP = 6;
// Stack cards and task cards share an 88px minimum height. Keeping the
// virtualizer's initial estimate in sync prevents a newly rendered group
// header from being positioned over a card before ResizeObserver measures it.
const CONVERSATION_CARD_ESTIMATE = 88;

type ConversationDispatchTarget = 'both' | 'codex' | 'claude';

/**
 * The composer is a continuation control. A routed Jeffrey message records
 * the choice he made; an agent reply is the useful legacy fallback for older
 * messages that predate dispatch_target. Empty conversations deliberately
 * start collaborative rather than inheriting a choice from another thread.
 */
function dispatchTargetForConversation(messages: SharedMessage[]): ConversationDispatchTarget {
  for (const message of [...messages].reverse()) {
    if (message.author === 'jeffrey' && (message.dispatchTarget === 'both' || message.dispatchTarget === 'codex' || message.dispatchTarget === 'claude')) return message.dispatchTarget;
    if (message.author === 'codex' || message.author === 'claude') return message.author;
  }
  return 'both';
}

function executionProfileForConversation(messages: SharedMessage[]): Exclude<AgentRun['executionProfile'], 'routing'> {
  for (const message of [...messages].reverse()) {
    if (message.author === 'codex' || message.author === 'claude' || (message.author === 'jeffrey' && message.dispatchTarget !== 'none')) return message.executionProfile === 'routing' ? null : message.executionProfile ?? null;
  }
  return null;
}

function accountProfileForConversation(messages: SharedMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.accountProfile) return message.accountProfile;
  }
  return DEFAULT_ACCOUNT_PROFILE;
}

function replyBadge(message: SharedMessage): string {
  const agent = message.author[0].toUpperCase() + message.author.slice(1);
  const profile = message.accountProfile ?? 'profile unavailable';
  const cost = message.estimatedCostUsd === null ? 'cost —' : formatCostUsd(message.estimatedCostUsd);
  return `${agent} · ${profile} · ${cost}`;
}

export function SharedWorkspace({ initialConversationId, onOpenTask, onSelectConversation, view, onViewChange }: { initialConversationId?: string | null; onOpenTask?: (taskId: string) => void; onSelectConversation?: (conversationId: string | null) => void; view?: 'active' | 'archive'; onViewChange?: (view: 'active' | 'archive') => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(() => initialConversationId ? readConversationDrafts()[initialConversationId] ?? '' : '');
  const [dispatchTo, setDispatchTo] = useState<ConversationDispatchTarget>('both');
  const [accountProfile, setAccountProfile] = useState(DEFAULT_ACCOUNT_PROFILE);
  const [conversationModelProfiles, setConversationModelProfiles] = useState(readConversationModelProfiles);
  const dispatchInitializedConversationId = useRef<string | null>(null);
  // Mirrors dispatchInitializedConversationId as render-visible state: the ref
  // alone doesn't trigger a re-render, so the send button could stay
  // (in)correctly disabled until some unrelated state change happened to
  // re-render the component.
  const [dispatchInitializedFor, setDispatchInitializedFor] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null);
  const [locallyReadConversationIds, setLocallyReadConversationIds] = useState<Set<string>>(new Set());
  const conversationIdRef = useRef(conversationId);
  const sentDraftRef = useRef<{ conversationId: string; body: string } | null>(null);
  const updateConversationPreferences = useMutation({
    mutationFn: ({ conversationId, profile }: { conversationId: string; profile: AgentRun['executionProfile'] }) => api.updateSharedConversationPreferences(conversationId, profile),
    onMutate: ({ conversationId }) => ({ conversationId, previousProfile: conversationModelProfiles[conversationId] ?? null }),
    onSuccess: async ({ conversation }) => {
      setConversationModelProfiles((current) => {
        const next = { ...current };
        if (conversation.preferredExecutionProfile) next[conversation.id] = conversation.preferredExecutionProfile;
        else delete next[conversation.id];
        writeConversationModelProfiles(next);
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    // The optimistic write in setExecutionProfile can outlive a failed save —
    // roll it back to what the server actually has, or the UI keeps showing a
    // choice that was never persisted and reappears every time it desyncs.
    onError: (error, { conversationId }, context) => {
      toastError('Could not save the model choice.', error);
      setConversationModelProfiles((current) => {
        const next = { ...current };
        if (context?.previousProfile) next[conversationId] = context.previousProfile;
        else delete next[conversationId];
        writeConversationModelProfiles(next);
        return next;
      });
    },
  });
  const selectConversationRef = useRef(onSelectConversation);
  useEffect(() => { selectConversationRef.current = onSelectConversation; });
  useEffect(() => {
    conversationIdRef.current = conversationId;
    setBody(conversationId ? readConversationDrafts()[conversationId] ?? '' : '');
    setFiles([]);
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
  function setExecutionProfile(profile: AgentRun['executionProfile']) {
    if (!conversationId) return;
    const targetConversationId = conversationId;
    setConversationModelProfiles((current) => {
      const next = { ...current };
      if (profile) next[targetConversationId] = profile;
      else delete next[targetConversationId];
      writeConversationModelProfiles(next);
      return next;
    });
    updateConversationPreferences.mutate({ conversationId: targetConversationId, profile });
  }
  // The rail's Active/Archive selection is owned by the caller when it supplies
  // one, so it survives the workspace being remounted onto a conversation from
  // the address bar. Rendered on its own the workspace still keeps its own.
  const [ownConversationView, setOwnConversationView] = useState<'active' | 'archive'>('active');
  const conversationView = view ?? ownConversationView;
  const setConversationView = (next: 'active' | 'archive') => { setOwnConversationView(next); onViewChange?.(next); };
  const [deleteConversationPromptOpen, setDeleteConversationPromptOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [dismissedCompletionPromptPromotionId, setDismissedCompletionPromptPromotionId] = useState<string | null>(null);
  const debouncedConversationSearch = useDebouncedValue(conversationSearch.trim(), 300);
  const conversationSearchResults = useQuery({
    queryKey: conversationQueryKeys.search(debouncedConversationSearch),
    queryFn: () => conversationData.search(debouncedConversationSearch),
    enabled: debouncedConversationSearch.length > 0,
  });
  const [pendingSelectedConversation, setPendingSelectedConversation] = useState<{ id: string; title: string } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [railOpen, setRailOpen] = useState(false);
  const [exitingConversationIds, setExitingConversationIds] = useState<Set<string>>(new Set());
  const railToggleRef = useRef<HTMLButtonElement>(null);
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

    const progress = rows.filter((row) => !row.conversation.linkedWorkItemPinned && (row.state === 'working' || row.state === 'promoting' || row.state === 'waiting_promotion'));
    const pinned = rows.filter((row) => row.conversation.linkedWorkItemPinned);
    const attention = rows.filter((row) => !row.conversation.linkedWorkItemPinned && row.state !== 'working' && row.state !== 'promoting' && row.state !== 'waiting_promotion');
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
  useEffect(() => {
    // Group headers change the virtual row geometry as conversations move
    // between stacks, so recalculate instead of waiting for a scroll event.
    conversationVirtualizer.measure();
  }, [conversationStackRows, conversationVirtualizer]);
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
    enabled: Boolean(conversationId) && !listedConversation && !conversations.isLoading,
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
  useEffect(() => {
    // Seed the local cache from the server's saved preference the first time
    // a conversation is opened. Once a choice exists locally (picked here, or
    // seeded already), it wins over background list refetches — the server
    // list polls every second and racing that against an in-flight save was
    // the "model choice keeps reverting" bug.
    if (!selectedConversation || selectedConversation.id in conversationModelProfiles) return;
    const profile = selectedConversation.preferredExecutionProfile;
    if (!profile) return;
    setConversationModelProfiles((current) => {
      if (selectedConversation.id in current) return current;
      const next = { ...current, [selectedConversation.id]: profile };
      writeConversationModelProfiles(next);
      return next;
    });
  }, [selectedConversation, conversationModelProfiles]);
  const linkedWorkItemId = selectedConversation?.workItemId ?? null;
  const linkedWorkItem = useQuery({ queryKey: ['work-item', linkedWorkItemId], queryFn: () => api.getWorkItem(linkedWorkItemId!), enabled: Boolean(linkedWorkItemId), refetchInterval: 1_000 });
  const linkableTasks = useQuery({ queryKey: ['conversation-linkable-tasks'], queryFn: () => api.listWorkItems('active', ''), staleTime: 30_000 });
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
  const allConversationMessages = messages.data?.messages ?? [];
  const agentAccounts = useQuery({ queryKey: ['agent-accounts'], queryFn: api.listAgentAccounts, refetchInterval: 5_000 });
  const accountProfiles = useMemo(() => {
    const configured = agentAccounts.data?.accounts ?? [];
    return configured.some((account) => account.name === accountProfile)
      ? configured
      : [{ name: accountProfile }, ...configured];
  }, [accountProfile, agentAccounts.data?.accounts]);
  // Conversation preferences are canonical once saved. Message history fills
  // in older conversations whose last model choice predates that preference.
  const executionProfile = conversationId
    ? conversationModelProfiles[conversationId] ?? selectedConversation?.preferredExecutionProfile ?? executionProfileForConversation(allConversationMessages)
    : null;
  // Keep the thread bounded to a handful of recent messages instead of an
  // endless scroll; older history is revealed a page at a time on request.
  const hasEarlierMessages = allConversationMessages.length > threadVisibleCount;
  const conversationMessages = hasEarlierMessages
    ? allConversationMessages.slice(allConversationMessages.length - threadVisibleCount)
    : allConversationMessages;
  // Message cards are variable-height markdown, often with substantial agent
  // output. Rendering all of them makes the composer re-render painfully slow
  // on long threads, so measure only the visible cards and a small buffer.
  const threadVirtualizer = useVirtualizer({
    count: conversationMessages.length,
    getScrollElement: () => threadScrollRef.current,
    estimateSize: () => 220,
    getItemKey: (index) => conversationMessages[index]?.id ?? index,
    overscan: 4,
    initialRect: { width: 900, height: 700 },
  });
  // A typewriter changes a message's rendered height independently of the
  // server-polled message body. Virtual row transforms can therefore be a
  // frame behind a growing live card on mobile. Keep the bounded, paged live
  // thread in normal document flow until streaming finishes: later messages
  // then follow the growing card by construction rather than relying on a
  // height-cache invalidation race.
  const hasRunningMessage = conversationMessages.some((message) => message.status === 'running');
  const threadRows = threadVirtualizer.getVirtualItems();
  const displayedThreadRows = hasRunningMessage
    ? conversationMessages.map((_, index) => ({ index, start: 0 }))
    : threadRows.length
    ? threadRows
    : conversationMessages.map((_, index) => ({ index, start: index * 220 }));
  // The final agent report can replace a small live update with a multi-section
  // response in one polling tick. Its row key does not change, so relying only
  // on ResizeObserver can leave the virtualizer positioned with the old height
  // until a full reload. Clear its measurement cache for every visible content
  // or lifecycle transition before the next paint.
  const threadLayoutSignature = conversationMessages.map((message) => `${message.id}:${message.status}:${message.body}`).join('\u0000');
  useEffect(() => {
    threadVirtualizer.measure();
  }, [threadLayoutSignature, threadVirtualizer]);
  useEffect(() => {
    if (!conversationId || dispatchInitializedConversationId.current === conversationId || !messages.data) return;
    setDispatchTo(dispatchTargetForConversation(messages.data.messages));
    setAccountProfile(accountProfileForConversation(messages.data.messages));
    dispatchInitializedConversationId.current = conversationId;
    setDispatchInitializedFor(conversationId);
  }, [conversationId, messages.data]);
  const send = useMutation({
    mutationFn: async () => {
      const attachments = await Promise.all(files.map(async (file) => ({
        name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
        dataBase64: await new Promise<string>((resolveValue, reject) => {
          const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolveValue(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file);
        }),
      })));
      return api.createSharedMessage(conversationId!, body, dispatchTo, attachments, executionProfile, accountProfile);
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
    onSuccess: async ({ conversation }) => {
      // A new conversation is always active; stay on the archive tab and it
      // silently disappears from the list you're looking at.
      if (conversationView !== 'active') setConversationView('active');
      setConversationId(conversation.id);
      await queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
  });
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
  const toggleLinkedTaskPin = useMutation({
    mutationFn: () => api.updateWorkItem(linkedWorkItemId!, { status: linkedWorkItem.data?.item.status === 'pinned' ? 'ready' : 'pinned' }),
    onSuccess: async () => {
      toast.success(linkedWorkItem.data?.item.status === 'pinned' ? 'Task brought back to Ready.' : 'Task pinned for later.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
      ]);
    },
    onError: (error) => toastError('Could not update the linked task.', error),
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
      if (!linkedWorkItemId) celebrate();
      toast.success(linkedWorkItemId ? 'Conversation and related task archived.' : 'Conversation archived.');
      await queryClient.cancelQueries({ queryKey: ['shared-conversations'] });
      removeConversationFromCachedRails(archivedConversationId);
      const successorId = nextConversationIdAfterRemoval(archivedConversationId, 'active');
      setConversationView('active');
      setConversationId((current) => current === archivedConversationId ? successorId : current);
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
      const successorId = completedConversationId ? nextConversationIdAfterRemoval(completedConversationId, 'active') : null;
      setConversationId((current) => current === completedConversationId ? successorId : current);
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
    onMutate: () => ({ previousDispatchTo: dispatchTo }),
    onSuccess: ({ seq }) => {
      if (seq !== ownerMutationSeq.current) return;
      void queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] });
    },
    onError: (error, _target, context) => {
      if (context?.previousDispatchTo) setDispatchTo(context.previousDispatchTo);
      toastError('Could not update the conversation owner.', error);
    },
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
        const successorId = nextConversationIdAfterRemoval(archivedConversationId, 'active');
        setConversationId((current) => current === archivedConversationId ? successorId : current);
      }
      void queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
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

  // Sending before the agent target / conversation state has finished
  // initializing for this conversation can dispatch to the wrong agent.
  const conversationReadyToSend = Boolean(conversationId) && dispatchInitializedFor === conversationId && !messages.isLoading;

  function submit(event: FormEvent) {
    event.preventDefault();
    if ((body.trim() || files.length) && conversationId && !send.isPending && conversationReadyToSend) {
      sentDraftRef.current = { conversationId, body };
      send.mutate();
    }
  }

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
    <main className={`shared-workspace ${railOpen ? 'rail-open' : ''}`}>
      <button type="button" className="rail-scrim" aria-label="Close conversation list" onClick={() => setRailOpen(false)} />
      <aside id="conversation-rail" className="conversation-rail" aria-label="Conversations">
        <header className="stack-toolbar"><div className="stack-toolbar-copy"><span className="eyebrow">Conversations</span><h2>Conversations</h2></div><div className="conversation-header-actions"><button className="icon-button" onClick={() => createConversation.mutate()} aria-label="New conversation"><Plus size={15} /></button></div></header>
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
            <Tabs ariaLabel="Conversation view" className="conversation-view-tabs" selected={conversationView} onSelect={selectConversationView} items={[
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
                  return <div key={conversation.id} ref={conversationVirtualizer.measureElement} data-index={virtualRow.index} className="virtual-row" style={{ transform: `translateY(${virtualRow.start}px)` }}><button style={cardStyle} className={`stack-card ${conversation.id === conversationId ? 'active' : ''} ${isUnread ? 'conversation-unread' : 'conversation-read'} ${conversation.linkedProjectName ? 'project-colored' : ''} ${stateClass ? `conversation-${stateClass}` : ''} ${exitingConversationIds.has(conversation.id) ? 'conversation-exiting' : ''}`} onClick={() => { setConversationId(conversation.id); setRailOpen(false); }}><span className="conversation-tab-title">{conversation.linkedProjectName && <ProjectColorDot projectName={conversation.linkedProjectName} labelled />}<strong>{conversation.title}</strong>{conversation.linkedWorkItemPinned && <span className="conversation-pinned-marker" aria-label="Pinned task" title="Pinned task"><Pin size={10} fill="currentColor" aria-hidden="true" /></span>}{isUnread && <span className="conversation-unread-marker">New</span>}{stateLabel && <span className={`conversation-state conversation-state-${state}`}>{(state === 'working' || state === 'promoting') && <LoaderCircle className="spin" size={10} />}{state === 'waiting_promotion' && <Clock size={10} />}{stateLabel}</span>}</span><small className="conversation-tab-meta"><ConversationOriginBadge workItemId={conversation.workItemId} /><span>{state === 'working' ? 'Agent working…' : state === 'promoting' ? 'Promoting preview…' : state === 'waiting_promotion' ? 'Waiting to promote…' : new Date(conversation.updatedAt).toLocaleDateString()}</span></small></button></div>;
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
        <header className="agent-console-header"><button ref={railToggleRef} type="button" className="rail-toggle icon-button" aria-label="Show conversations" aria-controls="conversation-rail" aria-expanded={railOpen} onClick={() => setRailOpen(true)}><Menu size={16} /></button><div className="agent-console-title">{selectedConversation ? <ConversationOriginBadge workItemId={selectedConversation.workItemId} /> : <span className="eyebrow">Shared context</span>}<h2>{selectedConversation?.title
              ?? (pendingSelectedConversation?.id === conversationId ? pendingSelectedConversation.title
                  : conversationDetail.isLoading ? <span className="conversation-title-skeleton"><Skeleton width="240px" height="19px" /></span>
                  : selectedConversationMissing ? 'Conversation not found'
                    : 'New conversation')}</h2>{linkedWorkItem.data?.item && onOpenTask && <button type="button" className="related-task-link" onClick={() => onOpenTask(linkedWorkItem.data!.item.id)}><ArrowLeft size={12} /> Back to task</button>}</div>{conversationId && selectedConversation && <div className="conversation-window-actions">{!selectedConversation.workItemId && <label className="conversation-task-picker" title="Link this conversation to a task"><Link2 size={13} /><select aria-label="Link conversation to task" defaultValue="" disabled={linkableTasks.isLoading || setConversationTask.isPending} onChange={(event) => { if (event.target.value) setConversationTask.mutate(event.target.value); event.currentTarget.value = ''; }}><option value="">Link task…</option>{(linkableTasks.data?.items ?? []).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}{selectedConversation.workItemId && <button type="button" className="icon-button conversation-unlink-task" onClick={() => setConversationTask.mutate(null)} disabled={setConversationTask.isPending} aria-label="Unlink task" title="Unlink task"><Link2Off size={14} /></button>}{linkedWorkItem.data?.item && <button type="button" className="icon-button complete-task-button" disabled={linkedTaskCompleted || completeLinkedTask.isPending} onClick={() => completeLinkedTask.mutate()} aria-label={linkedTaskCompleted ? 'Task completed' : 'Complete linked task'} title={linkedTaskCompleted ? 'Task completed' : 'Complete linked task'}>{completeLinkedTask.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}</button>}<button className="icon-button" onClick={() => forkConversation.mutate(conversationId)} aria-label="Fork conversation" title="Fork into a new conversation"><MessageSquarePlus size={14} /></button>{conversationView === 'active' ? <button className="icon-button" onClick={() => archiveConversation.mutate(conversationId)} aria-label="Archive conversation" title="Archive conversation"><Archive size={14} /></button> : <button className="icon-button" onClick={() => restoreConversation.mutate(conversationId)} aria-label="Restore conversation" title="Restore conversation"><RefreshCw size={14} /></button>}<span className={`conversation-delete-control ${selectedConversation.workItemId ? 'is-disabled' : ''}`} tabIndex={selectedConversation.workItemId ? 0 : undefined}><button className="icon-button delete-conversation-button" disabled={Boolean(selectedConversation.workItemId)} onClick={() => setDeleteConversationPromptOpen(true)} aria-label="Delete conversation" aria-describedby={selectedConversation.workItemId ? 'linked-conversation-delete-help' : undefined} title={selectedConversation.workItemId ? undefined : 'Delete permanently'}><Trash2 size={14} /></button>{selectedConversation.workItemId && <span id="linked-conversation-delete-help" className="action-tooltip" role="tooltip">Delete the related task to delete this conversation.</span>}</span></div>}</header>
        {linkedWorkItem.data?.item && <div className="thread-filter-bar"><TaskClassificationSelect itemId={linkedWorkItem.data.item.id} kind={linkedWorkItem.data.item.classificationKind} /><button type="button" className={`icon-button${linkedWorkItem.data.item.status === 'pinned' ? ' icon-button-active' : ''}`} onClick={() => toggleLinkedTaskPin.mutate()} disabled={toggleLinkedTaskPin.isPending} aria-pressed={linkedWorkItem.data.item.status === 'pinned'} aria-label={linkedWorkItem.data.item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'} title={linkedWorkItem.data.item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'}><Pin size={13} fill={linkedWorkItem.data.item.status === 'pinned' ? 'currentColor' : 'none'} /></button></div>}
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
          <div className={`thread-virtualizer${hasRunningMessage ? ' thread-live-flow' : ''}`} style={hasRunningMessage ? undefined : { height: threadVirtualizer.getTotalSize() }}>
          {displayedThreadRows.map((row) => {
            const message = conversationMessages[row.index];
            if (!message) return null;
            return <div key={message.id} ref={hasRunningMessage ? undefined : threadVirtualizer.measureElement} data-index={row.index} className="thread-virtual-row" style={hasRunningMessage ? undefined : { transform: `translateY(${row.start}px)` }}>
            <article className={`shared-message shared-${message.author}`}>
              <header><strong>{message.author === 'jeffrey' ? 'You' : message.author}</strong><time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                {message.author === 'jeffrey' && message.dispatchTarget !== 'none' && <span className="recipient-badge">To {message.dispatchTarget === 'both' ? 'Codex + Claude' : message.dispatchTarget === 'auto' ? 'an agent' : message.dispatchTarget[0].toUpperCase() + message.dispatchTarget.slice(1)}</span>}
                {message.model && <span className="model-badge" title={formatRunTelemetry(message)}>{replyBadge(message)}</span>}
                {typeof message.retrievedMemoryCount === 'number' && (
                  <span
                    className="memory-badge"
                    title={message.retrievedMemoryCount > 0
                      ? `Retrieved ${message.retrievedMemoryCount} memory match${message.retrievedMemoryCount === 1 ? '' : 'es'} from RAG for this reply`
                      : 'RAG memory search ran but found no matches'}
                  >
                    <Search size={11} /> {message.retrievedMemoryCount}
                  </span>
                )}
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
                : <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode, pre: MarkdownPre }}>{message.body}</ReactMarkdown></div>)}
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
            </div>;
          })}
          </div>
          {completionPromptAvailable && <div className="completion-prompt" role="status"><span><strong>Preview approved successfully.</strong><small>Complete the linked task?</small></span><div><button type="button" className="button secondary compact" onClick={() => setDismissedCompletionPromptPromotionId(latestSuccessfulPromotion!.id)}>Not yet</button><button type="button" className="button primary compact" onClick={() => completeLinkedTask.mutate()} disabled={completeLinkedTask.isPending}>{completeLinkedTask.isPending ? <><LoaderCircle className="spin" size={12} /> Completing…</> : <><Check size={12} /> Complete task</>}</button></div></div>}
          {previewApprovalAvailable && <div className="preview-approval"><span><strong>Workbench preview has unpublished changes</strong><small>Review them on port 5181, then promote this source snapshot to live.</small></span><button className="button primary compact" onClick={() => approvePreview.mutate()} disabled={approvePreview.isPending}>{approvePreview.isPending ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />} {approvePreview.isPending ? 'Approving…' : 'Approve preview'}</button></div>}
          {previewApprovalAvailable && approvePreview.error && <p className="error-message">Could not approve preview: {approvePreview.error.message}</p>}
          {proposedPlan && proposedPlanConversationId === conversationId && <article className="chat-plan"><span className="eyebrow">Proposed follow-up tasks</span><h3>{proposedPlan.summary}</h3><ol>{proposedPlan.tasks.map((task, index) => <li key={`${task.title}-${index}`}><label><input type="checkbox" checked={selectedPlanTaskIndexes.has(index)} onChange={() => setSelectedPlanTaskIndexes((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{task.title}</strong><p>{task.description}</p></span></label></li>)}</ol><div><button className="button secondary" onClick={() => resolvePlan.mutate({ resolution: 'rejected' })}>Reject</button><button className="button primary" disabled={selectedPlanTaskIndexes.size === 0 || resolvePlan.isPending} onClick={() => setPlanArchivePromptOpen(true)}><Check size={14} /> Add {selectedPlanTaskIndexes.size} to queue</button></div></article>}
          {createTasks.isPending && createTasks.variables?.conversationId === conversationId && <div className="finding-progress"><LoaderCircle className="spin" size={15} /><span><strong>Turning findings into tasks</strong><small>Reading the report and producing self-contained queue items…</small></span></div>}
          {createTasks.error && createTasks.variables?.conversationId === conversationId && <div className="finding-progress error-message"><X size={15} /><span><strong>Could not create tasks</strong><small>{createTasks.error.message}</small></span></div>}
          <div ref={endRef} />
          {hasNewActivityBelow && <button type="button" className="jump-to-latest-button" onClick={jumpToLatest}><ArrowDown size={13} /> New activity · Jump to latest</button>}
        </div>
        {conversationDetail.isLoading ? <ConversationComposerSkeleton /> : conversationView === 'archive' ? <div className="archived-composer-note"><Archive size={14} /> Archived conversation · restore or fork it to continue</div> : <form className="shared-composer" onSubmit={submit}>
          {files.length > 0 && <div className="pending-files">{files.map((file) => <button type="button" key={`${file.name}-${file.size}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><Paperclip size={11} /> {file.name} <X size={10} /></button>)}</div>}
          <MarkdownComposer conversationId={conversationId} value={body} onChange={updateBody} placeholder="Message Codex or Claude…" ariaLabel="Message Codex or Claude" onSubmit={() => {
            if ((body.trim() || files.length) && conversationId && !send.isPending && conversationReadyToSend) {
              sentDraftRef.current = { conversationId, body };
              send.mutate();
            }
          }} disabled={send.isPending} />
          <div className="composer-toolbar">
            <input ref={fileRef} className="visually-hidden" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
            <button type="button" className="composer-tool attach-button" onClick={() => fileRef.current?.click()} aria-label="Attach files" title="Attach files"><Paperclip size={14} /></button>
            <span className="composer-hint">Files, screenshots, or context</span>
            <ModelProfileSelect className="model-target" value={executionProfile} onChange={setExecutionProfile} />
            <select className="agent-target account-target" value={accountProfile} onChange={(event) => setAccountProfile(event.target.value)} aria-label="Account profile" disabled={agentAccounts.isLoading}>
              {accountProfiles.map((account) => <option key={account.name} value={account.name}>{account.name === 'default' ? 'Default' : account.name}</option>)}
            </select>
            <select className="agent-target dispatch-target" value={dispatchTo} onChange={(event) => { const target = event.target.value as typeof dispatchTo; setDispatchTo(target); if (linkedWorkItemId && !linkedTaskIsSelfAssigned) updateConversationOwner.mutate(target); }} aria-label="Who should respond">
              <option value="codex">Codex</option><option value="claude">Claude</option><option value="both">Both</option>
            </select>
            <button className="icon-button primary composer-send" aria-label="Send message" disabled={(!body.trim() && files.length === 0) || !conversationId || send.isPending || !conversationReadyToSend}>{send.isPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
          </div>
          {send.error && <p className="error-message">{send.error.message}</p>}
        </form>}
      </section>
      {planArchivePromptOpen && <FollowUpArchiveDialog count={selectedPlanTaskIndexes.size} pending={resolvePlan.isPending} onClose={() => setPlanArchivePromptOpen(false)} onChoose={(archiveParent) => resolvePlan.mutate({ resolution: 'accepted', archiveParent })} />}
      {deleteConversationPromptOpen && conversationId && <ConfirmationDialog title="Delete this conversation?" description="This permanently deletes the conversation and cannot be undone." confirmLabel="Delete conversation" pending={deleteConversation.isPending} onClose={() => setDeleteConversationPromptOpen(false)} onConfirm={() => deleteConversation.mutate(conversationId)} />}
    </main>
  );
}
