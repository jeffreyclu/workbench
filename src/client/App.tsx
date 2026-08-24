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
  MoreHorizontal,
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
  Wrench,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownComposer } from './markdown-composer.js';
import { MarkdownCode, MarkdownPre } from './markdown-code.js';
import { isSelfAssigned, SELF_ASSIGNED_EXECUTION_MESSAGE, SELF_ASSIGNED_OWNER_MESSAGE } from '../shared/contracts';
import type { AgentRun, Assignee, ExecutionPlan, ProviderSyncConflict, SharedConversation, SharedMessage, UpdateWorkItemInput, WorkItem, WorkItemDetail, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../shared/contracts';
import { api } from './api';
import { ArtifactLibraryView, ArtifactNav } from './artifacts';
import { ConfirmationDialog } from './confirmation-dialog';
import { InsightsView, InsightsNav } from './insights';
import { navigate, parseRoute, routePath, useRoute, type StackName } from './router';
import { ListRowSkeleton } from './skeleton';
import { Toaster } from './toast';
import { toast, toastError } from './toast-store';
import { SortableQueueItem as TaskQueueItem, TaskClassificationSelect } from './task-queue';
import { AgentMessageBody, LiveRunOutput } from './agent-message';
import { ConversationOriginBadge, ModelProfileSelect, ReferenceTypeIcon } from './badges';
import { CreateTask } from './create-task-dialog';
import { DiscoveryInboxView, DiscoveryNav } from './discovery';
import { FollowUpArchiveDialog } from './follow-up-archive-dialog';
import { activityKindLabel, agentDecisionKinds, formatFileSize, formatRunBadge, formatRunTelemetry, memorySourceLabel, selectBalancedVisibleAgent, sourceLinkLabel, sourceReferenceTitle, sourceReferenceType, taskDetailSaveFeedback } from './formatters';
import { clearSentConversationDraft, readConversationDrafts, readConversationModelProfiles, readLastOpenedItem, readTaskModelProfiles, writeConversationDraft, writeConversationModelProfiles, writeLastOpenedItem, writeTaskModelProfile } from './preferences';
import { QueueExplanationList } from './queue-explanations';
import { ProjectColorDot } from './project-color';
import { InlineProjectEditor } from './project-field';
import { isWorkbenchProject, WORKBENCH_PROJECT_NAME } from '../shared/project-name';
import { SourcesDialog } from './sources-dialog';
import { createTaskStackViewModel } from './stack-view-model';
import { useRealtimeNotifications, type RealtimeNotification } from './realtime';

const CONVERSATION_ROW_GAP = 6;

export function SharedWorkspace({ initialConversationId, onOpenTask, onSelectConversation, view, onViewChange }: { initialConversationId?: string | null; onOpenTask?: (taskId: string) => void; onSelectConversation?: (conversationId: string | null) => void; view?: 'active' | 'archive'; onViewChange?: (view: 'active' | 'archive') => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(() => initialConversationId ? readConversationDrafts()[initialConversationId] ?? '' : '');
  const [dispatchTo, setDispatchTo] = useState<'both' | 'codex' | 'claude'>('codex');
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
  const [debouncedConversationSearch, setDebouncedConversationSearch] = useState('');
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedConversationSearch(conversationSearch.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [conversationSearch]);
  const conversationSearchResults = useQuery({
    queryKey: ['memory-search', debouncedConversationSearch],
    queryFn: () => api.searchMemory(debouncedConversationSearch, 40),
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
    queryKey: ['shared-conversations', conversationView], queryFn: ({ pageParam }) => api.listSharedConversations(conversationView, pageParam),
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
  const conversationVirtualizer = useVirtualizer({ count: conversationStackRows.length, getScrollElement: () => conversationScrollRef.current, estimateSize: (index) => (conversationStackRows[index]?.type === 'header' ? 38 : 58) + CONVERSATION_ROW_GAP, overscan: 5, initialRect: { width: 250, height: 600 } });
  const conversationRows = conversationVirtualizer.getVirtualItems();
  const displayedConversationRows = conversationRows.length ? conversationRows : conversationStackRows.map((row, index) => ({ index, start: conversationStackRows.slice(0, index).reduce((total, item) => total + (item.type === 'header' ? 38 : 58) + CONVERSATION_ROW_GAP, 0) }));
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
    queryKey: ['shared-conversation', conversationId],
    queryFn: () => api.getSharedConversation(conversationId!),
    enabled: Boolean(conversationId) && !listedConversation && !conversations.isLoading,
    retry: false,
  });
  const selectedConversation = listedConversation ?? conversationDetail.data?.conversation;
  const selectedConversationMissing = Boolean(conversationId) && !listedConversation && conversationDetail.isError;
  const executionProfile = conversationId ? conversationModelProfiles[conversationId] ?? selectedConversation?.preferredExecutionProfile ?? null : null;
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
  const linkedTaskCompleted = linkedWorkItem.data?.item.completionStatus === 'completed';
  // A task Jeffrey has claimed keeps its owner: chatting here must not hand it to an agent.
  const linkedTaskIsSelfAssigned = isSelfAssigned(linkedWorkItem.data?.item.assignees ?? []);
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
  const threadRows = threadVirtualizer.getVirtualItems();
  const displayedThreadRows = threadRows.length
    ? threadRows
    : conversationMessages.map((_, index) => ({ index, start: index * 220 }));
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
    setDispatchInitializedFor(conversationId);
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
      toast.success('Conversation deleted.');
      void queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
    },
    onError: (error) => toastError('Could not delete the conversation.', error),
  });
  const archiveConversation = useMutation({
    mutationFn: async (id: string) => { await animateConversationExit(id); return api.archiveSharedConversation(id); },
    onSuccess: async (_response, archivedConversationId) => {
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
  const latestMessageLength = messages.data?.messages.at(-1)?.body.length ?? 0;
  const scrollThreadToLatest = (behavior: ScrollBehavior) => {
    const container = threadScrollRef.current;
    if (!container) return;
    // scrollIntoView also scrolls hidden ancestors. In the conversation layout
    // that moved the console header and view switch above the viewport.
    if (typeof container.scrollTo === 'function') container.scrollTo({ top: container.scrollHeight, behavior });
    else container.scrollTop = container.scrollHeight;
  };
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
    && Boolean(previewStatus.data?.pending) && !promotionInFlight && !agentWorkInFlight;

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
            placeholder="Search everything…"
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
              <div key={`${result.source}-${result.sourceId}`} className="virtual-row" style={{ position: 'static' }}>
                <button
                  className={result.conversationId === conversationId ? 'active' : ''}
                  disabled={!result.conversationId}
                  onClick={() => {
                    if (!result.conversationId) return;
                    setConversationId(result.conversationId);
                    setPendingSelectedConversation({ id: result.conversationId, title: result.title });
                    setConversationSearch('');
                    setRailOpen(false);
                  }}
                >
                  <span className="conversation-tab-title"><small className="memory-source-tag">{memorySourceLabel(result.source)}</small> <strong>{result.title}</strong></span>
                  <small>{result.snippet}</small>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="conversation-view-tabs" role="group" aria-label="Conversation view">
              <button type="button" className={conversationView === 'active' ? 'active' : ''} aria-pressed={conversationView === 'active'} onClick={() => selectConversationView('active')}>Active</button>
              <button type="button" className={conversationView === 'archive' ? 'active' : ''} aria-pressed={conversationView === 'archive'} onClick={() => selectConversationView('archive')}>Archive</button>
            </div>
            <div ref={conversationScrollRef} className="conversation-tabs">
              <div className="virtual-list" style={{ height: conversationVirtualizer.getTotalSize() }}>
                {displayedConversationRows.map((virtualRow) => {
                  const row = conversationStackRows[virtualRow.index];
                  if (!row) return null;
                  if (row.type === 'header') return <div key={row.id} ref={conversationVirtualizer.measureElement} data-index={virtualRow.index} className="virtual-row" style={{ transform: `translateY(${virtualRow.start}px)` }}><div className={`stack-header conversation-stack-header stack-header-${row.group}`}><span>{row.label}</span><strong>{row.count}</strong></div></div>;

                  const { conversation, state } = row;
                  const isUnread = Boolean(conversation.isUnread && !locallyReadConversationIds.has(conversation.id) && conversation.id !== conversationId);
                  const stateLabel = state === 'working' ? 'Working' : state === 'needs_attention' ? 'Failed or canceled' : state === 'waiting_approval' ? 'Review follow-ups' : state === 'promoting' ? 'Approved · promoting preview' : state === 'waiting_promotion' ? 'Approved and waiting promotion' : state === 'finished' ? 'Finished' : null;
                  const stateClass = state;
                  return <div key={conversation.id} ref={conversationVirtualizer.measureElement} data-index={virtualRow.index} className="virtual-row" style={{ transform: `translateY(${virtualRow.start}px)` }}><button className={`${conversation.id === conversationId ? 'active' : ''} ${isUnread ? 'conversation-unread' : 'conversation-read'} ${stateClass ? `conversation-${stateClass}` : ''} ${exitingConversationIds.has(conversation.id) ? 'conversation-exiting' : ''}`} onClick={() => { setConversationId(conversation.id); setRailOpen(false); }}><span className="conversation-tab-title">{conversation.linkedProjectName && <ProjectColorDot projectName={conversation.linkedProjectName} labelled />}<strong>{conversation.title}</strong>{conversation.linkedWorkItemPinned && <span className="conversation-pinned-marker" aria-label="Pinned task" title="Pinned task"><Pin size={10} fill="currentColor" aria-hidden="true" /></span>}{isUnread && <span className="conversation-unread-marker">New</span>}{stateLabel && <span className={`conversation-state conversation-state-${state}`}>{(state === 'working' || state === 'promoting') && <LoaderCircle className="spin" size={10} />}{state === 'waiting_promotion' && <Clock size={10} />}{stateLabel}</span>}</span><small className="conversation-tab-meta"><ConversationOriginBadge workItemId={conversation.workItemId} /><span>{state === 'working' ? 'Agent working…' : state === 'promoting' ? 'Promoting preview…' : state === 'waiting_promotion' ? 'Waiting to promote…' : new Date(conversation.updatedAt).toLocaleDateString()}</span></small></button></div>;
                })}
              </div>
              {conversations.isLoading && <ListRowSkeleton count={6} />}
              {conversations.isError && conversationList.length === 0 && (
                <div className="page-state error-message">Could not load conversations. <button type="button" className="button secondary compact" onClick={() => conversations.refetch()}>Retry</button></div>
              )}
              {!conversations.isLoading && !conversations.isError && conversationList.length === 0 && <div className="page-state">No {conversationView} conversations.</div>}
              {conversations.isFetchingNextPage && <div className="page-state"><LoaderCircle className="spin" size={12} /> Loading more…</div>}
            </div>
          </>
        )}
      </aside>
      <section className="agent-console" aria-label="Shared agent workspace">
        <header className="agent-console-header"><button ref={railToggleRef} type="button" className="rail-toggle icon-button" aria-label="Show conversations" aria-controls="conversation-rail" aria-expanded={railOpen} onClick={() => setRailOpen(true)}><Menu size={16} /></button><div className="agent-console-title">{selectedConversation ? <ConversationOriginBadge workItemId={selectedConversation.workItemId} /> : <span className="eyebrow">Shared context</span>}<h2>{selectedConversation?.title
              ?? (pendingSelectedConversation?.id === conversationId ? pendingSelectedConversation.title
                : conversationDetail.isLoading ? 'Loading conversation…'
                  : selectedConversationMissing ? 'Conversation not found'
                    : 'New conversation')}</h2>{linkedWorkItem.data?.item && onOpenTask && <button type="button" className="related-task-link" onClick={() => onOpenTask(linkedWorkItem.data!.item.id)}><ArrowLeft size={12} /> Back to task</button>}</div>{conversationId && selectedConversation && <div className="conversation-window-actions">{!selectedConversation.workItemId && <label className="conversation-task-picker" title="Link this conversation to a task"><Link2 size={13} /><select aria-label="Link conversation to task" defaultValue="" disabled={linkableTasks.isLoading || setConversationTask.isPending} onChange={(event) => { if (event.target.value) setConversationTask.mutate(event.target.value); event.currentTarget.value = ''; }}><option value="">Link task…</option>{(linkableTasks.data?.items ?? []).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}{selectedConversation.workItemId && <button type="button" className="icon-button conversation-unlink-task" onClick={() => setConversationTask.mutate(null)} disabled={setConversationTask.isPending} aria-label="Unlink task" title="Unlink task"><Link2Off size={14} /></button>}{linkedWorkItem.data?.item && <button type="button" className="icon-button complete-task-button" disabled={linkedTaskCompleted || completeLinkedTask.isPending} onClick={() => completeLinkedTask.mutate()} aria-label={linkedTaskCompleted ? 'Task completed' : 'Complete linked task'} title={linkedTaskCompleted ? 'Task completed' : 'Complete linked task'}>{completeLinkedTask.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}</button>}<button className="icon-button" onClick={() => forkConversation.mutate(conversationId)} aria-label="Fork conversation" title="Fork into a new conversation"><MessageSquarePlus size={14} /></button>{conversationView === 'active' ? <button className="icon-button" onClick={() => archiveConversation.mutate(conversationId)} aria-label="Archive conversation" title="Archive conversation"><Archive size={14} /></button> : <button className="icon-button" onClick={() => restoreConversation.mutate(conversationId)} aria-label="Restore conversation" title="Restore conversation"><RefreshCw size={14} /></button>}<span className={`conversation-delete-control ${selectedConversation.workItemId ? 'is-disabled' : ''}`} tabIndex={selectedConversation.workItemId ? 0 : undefined}><button className="icon-button delete-conversation-button" disabled={Boolean(selectedConversation.workItemId)} onClick={() => setDeleteConversationPromptOpen(true)} aria-label="Delete conversation" aria-describedby={selectedConversation.workItemId ? 'linked-conversation-delete-help' : undefined} title={selectedConversation.workItemId ? undefined : 'Delete permanently'}><Trash2 size={14} /></button>{selectedConversation.workItemId && <span id="linked-conversation-delete-help" className="action-tooltip" role="tooltip">Delete the related task to delete this conversation.</span>}</span></div>}</header>
        {linkedWorkItem.data?.item && <div className="thread-filter-bar"><TaskClassificationSelect itemId={linkedWorkItem.data.item.id} kind={linkedWorkItem.data.item.classificationKind} /><button type="button" className={`icon-button${linkedWorkItem.data.item.status === 'pinned' ? ' icon-button-active' : ''}`} onClick={() => toggleLinkedTaskPin.mutate()} disabled={toggleLinkedTaskPin.isPending} aria-pressed={linkedWorkItem.data.item.status === 'pinned'} aria-label={linkedWorkItem.data.item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'} title={linkedWorkItem.data.item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'}><Pin size={13} fill={linkedWorkItem.data.item.status === 'pinned' ? 'currentColor' : 'none'} /></button></div>}
        <div className="shared-thread" ref={threadScrollRef}>
          {conversationDetail.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading conversation…</div>}
          {selectedConversationMissing && (
            <div className="list-state compact-state error-message">
              This conversation could not be found. It may have been deleted.
              <button type="button" className="button secondary compact" onClick={() => conversationDetail.refetch()}>Retry</button>
            </div>
          )}
          {messages.isLoading && <ListRowSkeleton count={5} />}
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
          <div className="thread-virtualizer" style={{ height: threadVirtualizer.getTotalSize() }}>
          {displayedThreadRows.map((row) => {
            const message = conversationMessages[row.index];
            if (!message) return null;
            return <div key={message.id} ref={threadVirtualizer.measureElement} data-index={row.index} className="thread-virtual-row" style={{ transform: `translateY(${row.start}px)` }}>
            <article className={`shared-message shared-${message.author}`}>
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
          {previewApprovalAvailable && <div className="preview-approval"><span><strong>Workbench preview has unpublished changes</strong><small>Review them on port 5174, then promote this source snapshot to live.</small></span><button className="button primary compact" onClick={() => approvePreview.mutate()} disabled={approvePreview.isPending}>{approvePreview.isPending ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />} {approvePreview.isPending ? 'Approving…' : 'Approve preview'}</button></div>}
          {previewApprovalAvailable && approvePreview.error && <p className="error-message">Could not approve preview: {approvePreview.error.message}</p>}
          {proposedPlan && proposedPlanConversationId === conversationId && <article className="chat-plan"><span className="eyebrow">Proposed follow-up tasks</span><h3>{proposedPlan.summary}</h3><ol>{proposedPlan.tasks.map((task, index) => <li key={`${task.title}-${index}`}><label><input type="checkbox" checked={selectedPlanTaskIndexes.has(index)} onChange={() => setSelectedPlanTaskIndexes((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span><strong>{task.title}</strong><p>{task.description}</p></span></label></li>)}</ol><div><button className="button secondary" onClick={() => resolvePlan.mutate({ resolution: 'rejected' })}>Reject</button><button className="button primary" disabled={selectedPlanTaskIndexes.size === 0 || resolvePlan.isPending} onClick={() => setPlanArchivePromptOpen(true)}><Check size={14} /> Add {selectedPlanTaskIndexes.size} to queue</button></div></article>}
          {createTasks.isPending && createTasks.variables?.conversationId === conversationId && <div className="finding-progress"><LoaderCircle className="spin" size={15} /><span><strong>Turning findings into tasks</strong><small>Reading the report and producing self-contained queue items…</small></span></div>}
          {createTasks.error && createTasks.variables?.conversationId === conversationId && <div className="finding-progress error-message"><X size={15} /><span><strong>Could not create tasks</strong><small>{createTasks.error.message}</small></span></div>}
          <div ref={endRef} />
        </div>
        {hasNewActivityBelow && <button type="button" className="jump-to-latest-button" onClick={jumpToLatest}><ArrowDown size={13} /> New activity · Jump to latest</button>}
        {conversationView === 'archive' ? <div className="archived-composer-note"><Archive size={14} /> Archived conversation · restore or fork it to continue</div> : <form className="shared-composer" onSubmit={submit}>
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
            <select className="agent-target" value={dispatchTo} onChange={(event) => { const target = event.target.value as typeof dispatchTo; setDispatchTo(target); if (linkedWorkItemId && !linkedTaskIsSelfAssigned) updateConversationOwner.mutate(target); }} aria-label="Who should respond">
              <option value="codex">Ask Codex</option><option value="claude">Ask Claude</option><option value="both">Ask both</option>
            </select>
            <button className="composer-send" aria-label="Send message" disabled={(!body.trim() && files.length === 0) || !conversationId || send.isPending || !conversationReadyToSend}>{send.isPending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button>
          </div>
          {send.error && <p className="error-message">{send.error.message}</p>}
        </form>}
      </section>
      {planArchivePromptOpen && <FollowUpArchiveDialog count={selectedPlanTaskIndexes.size} pending={resolvePlan.isPending} onClose={() => setPlanArchivePromptOpen(false)} onChoose={(archiveParent) => resolvePlan.mutate({ resolution: 'accepted', archiveParent })} />}
      {deleteConversationPromptOpen && conversationId && <ConfirmationDialog title="Delete this conversation?" description="This permanently deletes the conversation and cannot be undone." confirmLabel="Delete conversation" pending={deleteConversation.isPending} onClose={() => setDeleteConversationPromptOpen(false)} onConfirm={() => deleteConversation.mutate(conversationId)} />}
    </main>
  );
}

export function TaskDetail({ id, onClose, onOpenConversation, onOpenTask, onCreated, onRemoving }: { id: string; onClose: () => void; onOpenConversation: (conversationId: string) => void; onOpenTask: (taskId: string) => void; onCreated: (item: WorkItem) => void; onRemoving?: (id: string) => Promise<void> }) {
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
  const ACTIVITY_PAGE_SIZE = 20;
  const [activityVisibleCount, setActivityVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const RUNS_PAGE_SIZE = 5;
  const [runsVisibleCount, setRunsVisibleCount] = useState(RUNS_PAGE_SIZE);
  const setExecutionProfile = (profile: AgentRun['executionProfile']) => {
    setExecutionProfileState(profile);
    writeTaskModelProfile(id, profile);
  };

  const initializedExecutionPlanSelectionId = useRef<string | null>(null);
  const update = useMutation({
    mutationFn: (input: UpdateWorkItemInput) => api.updateWorkItem(id, input),
    onSuccess: async (_data, input) => {
      toast.success(taskDetailSaveFeedback(input).success);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
      ]);
    },
    onError: (error, input) => toastError(taskDetailSaveFeedback(input).error, error),
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
  const unlinkConversation = useMutation({
    mutationFn: (conversationId: string) => api.setSharedConversationTask(conversationId, null),
    onSuccess: async () => {
      toast.success('Conversation unlinked from task.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['shared-conversations'] }),
      ]);
    },
    onError: (error) => toastError('Could not unlink the conversation.', error),
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
      if (action === 'delete') { setDeleteTaskPromptOpen(false); await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); }
      if (action !== 'restore') await onRemoving?.(id);
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
  const togglePin = useMutation({
    mutationFn: () => api.updateWorkItem(id, { status: detail.data?.item.status === 'pinned' ? 'ready' : 'pinned' }),
    onSuccess: async () => {
      toast.success(detail.data?.item.status === 'pinned' ? 'Task brought back to Ready.' : 'Task pinned for later.');
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['work-items'] }), queryClient.invalidateQueries({ queryKey: ['work-item', id] })]);
    },
    onError: (error) => toastError('Could not update the task.', error),
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
  }, [detail.data?.item, editingField]);
  useEffect(() => {
    setActivityVisibleCount(ACTIVITY_PAGE_SIZE);
    setRunsVisibleCount(RUNS_PAGE_SIZE);
  }, [id]);

  if (detail.isLoading) return <ListRowSkeleton count={6} className="detail-empty-skeleton" />;
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
  // Parent/follow-up is a first-class task relationship, not a duplicate
  // manual link. Present it in the same Linked tasks section from either end.
  const relatedTaskIds = new Set([
    ...linkedTasks.map((linkedTask) => linkedTask.id),
    ...(detail.data.parentItem ? [detail.data.parentItem.id] : []),
    ...detail.data.children.map((child) => child.id),
  ]);
  const taskLinkCandidates = (taskLinkCandidateQuery.data?.items ?? []).filter((candidate) => candidate.id !== item.id && !relatedTaskIds.has(candidate.id));
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
        <button type="button" className={`icon-button${item.status === 'pinned' ? ' icon-button-active' : ''}`} onClick={() => togglePin.mutate()} disabled={togglePin.isPending} aria-pressed={item.status === 'pinned'} aria-label={item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'} title={item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'}><Pin size={14} fill={item.status === 'pinned' ? 'currentColor' : 'none'} /></button>
        {item.archivedAt ? <><span className={`archive-state ${item.completionStatus}`}>{item.completionStatus === 'completed' ? 'Completed & archived' : 'Archived incomplete'}</span><button type="button" className="button secondary compact" onClick={() => lifecycle.mutate('restore')} disabled={lifecycle.isPending}><Archive size={14} /> Restore</button></> : <>
          <button type="button" className="button secondary compact" onClick={() => lifecycle.mutate('archive')} disabled={lifecycle.isPending}><Archive size={14} /> Archive</button>
          <button type="button" className="button primary compact" onClick={() => lifecycle.mutate('complete')} disabled={lifecycle.isPending}><Check size={14} /> Complete</button>
        </>}
        <button type="button" className="button danger compact" onClick={() => setDeleteTaskPromptOpen(true)}><Trash2 size={14} /> Delete</button>
      </div>
      {showFollowUp && <form className="follow-up-form" onSubmit={(event) => { event.preventDefault(); if (followUpTitle.trim()) createFollowUp.mutate(); }}>
        <span className="section-label">New follow-up task</span>
        <input autoFocus value={followUpTitle} onChange={(event) => setFollowUpTitle(event.target.value)} placeholder="Follow-up title" />
        <MarkdownComposer conversationId={`follow-up-${item.id}`} value={followUpDescription} onChange={setFollowUpDescription} placeholder="Description and expected outcome" ariaLabel="Follow-up task description" />
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
      <div className="detail-controls">{editingField === 'project' ? <InlineProjectEditor initialValue={item.projectName ?? ''}
        onCommit={(projectName) => { if (projectName !== item.projectName) update.mutate({ projectName }); setEditingField(null); }}
        onCancel={() => setEditingField(null)} />
        : <button className={`project-pill inline-editable ${item.projectName ? '' : 'empty'}`} onClick={() => setEditingField('project')} title="Click to edit project">{item.projectName || 'Add project'}</button>}<TaskClassificationSelect itemId={item.id} kind={item.classificationKind} /></div>

      <div className="detail-section">
        <span className="section-label">Description</span>
        {editingField === 'description' ? <MarkdownComposer conversationId={`task-description-${item.id}`} value={editDescription} onChange={setEditDescription} onBlur={() => { if (editDescription !== item.description) update.mutate({ description: editDescription }); setEditingField(null); }} placeholder="Notes, constraints, links…" ariaLabel="Task description" autoFocus className="inline-description-editor" />
          : item.description ? <div className="inline-editable task-description-markdown" onClick={() => setEditingField('description')} title="Click to edit description"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode, pre: MarkdownPre }}>{item.description}</ReactMarkdown></div> : <p className="inline-editable muted" onClick={() => setEditingField('description')} title="Click to edit description">No description has been added yet.</p>}
      </div>
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
          {detail.data.runs.slice(0, runsVisibleCount).map((run, runIndex) => (
            <article className="run-card" data-agent={run.agent} key={run.id}>
              <header>
                <span className={`run-status run-${run.status}`}>{run.status === 'running' && <LoaderCircle className="spin" size={11} />}{run.status === 'queued' && run.attempt > 0 ? `Retrying (attempt ${run.attempt + 1} of ${run.maxAttempts})…` : run.status}</span>
                <strong>{run.agent} · {run.kind}</strong>
                <time>{new Date(run.createdAt).toLocaleString()}</time>
                {(run.status === 'queued' || run.status === 'running') && <button className="cancel-run" onClick={() => cancelRun.mutate(run.id)}><X size={11} /> Cancel</button>}
                {runIndex === 0 && (run.status === 'failed' || run.status === 'canceled') && <button className="retry-run" onClick={() => retryRun.mutate(run.id)} disabled={retryRun.isPending}><RefreshCw size={11} /> Retry / continue</button>}
              </header>
              {run.instructions && <p className="run-prompt">{run.instructions}</p>}
              {run.status === 'running' && !run.conversationId && <div className="live-output-label"><span /> Live activity & reasoning summaries</div>}
              {run.output && run.status !== 'completed' && !run.conversationId && <LiveRunOutput output={run.output} />}
              {run.model && <span className="model-badge" title={formatRunTelemetry(run)}>{run.model} · {formatRunBadge(run)}</span>}
              {run.status === 'completed' && run.output && <div className="run-summary"><span className="section-label">Agent summary</span><AgentMessageBody body={run.output} running={false} workItemId={item.id} /></div>}
              {run.error && <p className="error-message">{run.error}</p>}
              {run.conversationId && <button className="open-run-chat" onClick={() => onOpenConversation(run.conversationId!)}><MessageCircle size={13} /> Open execution chat</button>}
            </article>
          ))}
          {detail.data.runs.length > runsVisibleCount && (
            <button
              type="button"
              className="show-more-activity-button"
              onClick={() => setRunsVisibleCount((current) => current + RUNS_PAGE_SIZE)}
            >
              Show more ({detail.data.runs.length - runsVisibleCount} more)
            </button>
          )}
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
        <summary><span>Linked items & history</span><small>{(detail.data.parentItem ? 1 : 0) + detail.data.children.length + linkedTasks.length + detail.data.conversations.length + detail.data.artifacts.length + references.length} linked</small></summary>
        <div className="task-collapsible-content">
        <div className="relationship-group">
          <span className="relationship-group-label">Linked tasks</span>
          {detail.data.parentItem && (
            <div className="relationship-item reference-item">
              <button type="button" className="relationship-task-link" onClick={() => onOpenTask(detail.data!.parentItem!.id)}><span>{detail.data.parentItem.title}</span></button>
              <em className="relationship-tag">parent task</em>
            </div>
          )}
          {detail.data.children.map((child) => (
            <div className="relationship-item reference-item" key={child.id}>
              <button type="button" className="relationship-task-link" onClick={() => onOpenTask(child.id)}><span>{child.title}</span></button>
              <em className="relationship-tag">follow-up{child.archivedAt ? ' · archived' : ''}</em>
            </div>
          ))}
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
              <div className="relationship-item reference-item" key={conversation.id}>
                <button type="button" className="relationship-task-link" onClick={() => onOpenConversation(conversation.id)}><MessageCircle size={13} /><span>{conversation.title}</span>{conversation.forkedFromConversationId && <em className="relationship-tag">fork</em>}{conversation.archivedAt && <em className="relationship-tag">archived</em>}</button>
                {conversation.workItemId === item.id && <button type="button" className="icon-button" aria-label={`Unlink conversation ${conversation.title}`} disabled={unlinkConversation.isPending} onClick={() => unlinkConversation.mutate(conversation.id)}><X size={12} /></button>}
              </div>
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
        {activity.length === 0 ? <p className="muted">No activity yet.</p> : activity.slice(0, activityVisibleCount).map((entry) => (
          <div className={`activity${agentDecisionKinds.has(entry.kind) ? ' decision' : ''}`} key={entry.id}>
            <span className="activity-dot" />
            <div>
              <strong>{entry.actor}</strong> <span className="activity-kind">{activityKindLabel(entry.kind)}</span>{' '}
              <span className="activity-body">{entry.body}</span>
              <time>{new Date(entry.createdAt).toLocaleString()}</time>
            </div>
          </div>
        ))}
        {activity.length > activityVisibleCount && (
          <button
            type="button"
            className="show-more-activity-button"
            onClick={() => setActivityVisibleCount((current) => current + ACTIVITY_PAGE_SIZE)}
          >
            Show more ({activity.length - activityVisibleCount} more)
          </button>
        )}
        </div>
      </details>
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const handleRealtimeNotification = useMemo(() => (notification: RealtimeNotification) => {
    const options = {
      description: notification.description,
      duration: notification.duration,
      ...(notification.action ? {
        action: () => navigate(parseRoute(notification.action!.route)),
        actionLabel: notification.action.label,
      } : {}),
    };
    toast[notification.tone](notification.message, options);
  }, []);
  useRealtimeNotifications(handleRealtimeNotification);
  const health = useQuery({ queryKey: ['health'], queryFn: api.getHealth, refetchInterval: 15_000 });
  const loadedBuildId = useRef<string | null>(null);
  useEffect(() => {
    const buildId = health.data?.buildId;
    if (!buildId) return;
    if (loadedBuildId.current === null) { loadedBuildId.current = buildId; return; }
    if (loadedBuildId.current === buildId) return;
    toast.info('A newer version of Workbench is live', {
      duration: 0,
      action: () => window.location.reload(),
      actionLabel: 'Reload',
    });
    loadedBuildId.current = buildId;
  }, [health.data?.buildId]);
  const route = useRoute();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exitingTaskIds, setExitingTaskIds] = useState<Set<string>>(new Set());
  const [enteringTaskIds, setEnteringTaskIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showProposalDetail, setShowProposalDetail] = useState(false);
  // A task URL names the task, never a stack, so a link keeps working after the
  // task moves. The queue shown behind an open task is resolved from the task.
  const [taskStack, setTaskStack] = useState<StackName>('active');
  const [resolvedTaskId, setResolvedTaskId] = useState<string | null>(null);
  const [conversationNavigationVersion, setConversationNavigationVersion] = useState(0);
  // The rail's Active/Archive selection lives here, outside the remount key
  // above, so reopening the workspace on a conversation keeps the rail Jeffrey
  // chose instead of snapping back to Active.
  const [conversationRailView, setConversationRailView] = useState<'active' | 'archive'>('active');
  const [pendingTaskNavigation, setPendingTaskNavigation] = useState<string | null>(null);
  const [pendingPinnedNavigation, setPendingPinnedNavigation] = useState(false);
  const selectedId = route.name === 'task' ? route.taskId : null;
  const animateTaskExit = (id: string) => new Promise<void>((resolve) => {
    setExitingTaskIds((current) => new Set(current).add(id));
    window.setTimeout(resolve, 560);
  });
  const animateTaskEnter = (id: string) => {
    setEnteringTaskIds((current) => new Set(current).add(id));
    window.setTimeout(() => {
      setEnteringTaskIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 560);
  };
  const agentConversationId = route.name === 'conversations' ? route.conversationId ?? readLastOpenedItem('conversation') : null;
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
  const workItemCounts = useQuery({ queryKey: ['work-item-counts'], queryFn: api.getWorkItemCounts, refetchInterval: 5_000 });
  const pinnedReminder = useQuery({ queryKey: ['pinned-reminder'], queryFn: () => api.listWorkItems('active', ''), staleTime: 60_000 });
  const totalConversationCount = useQuery({ queryKey: ['conversation-count'], queryFn: api.getConversationCount, refetchInterval: 5_000 });
  const syncedConversationId = useRef<string | null>(route.name === 'conversations' ? route.conversationId : null);
  function openConversation(conversationId: string) {
    navigate({ name: 'conversations', conversationId });
  }
  function openPrimaryStack(stack: Extract<StackName, 'active' | 'workbench'>) {
    const surface = stack === 'active' ? 'attention' : 'workbench';
    const taskId = readLastOpenedItem(surface);
    // These navigations happen in one event, so React may only render the final
    // task route. Set the close destination directly instead of relying on the
    // stack-route effect to observe the intermediate history entry.
    setTaskStack(stack);
    // Keep the stack route behind the task for the mobile back gesture.
    navigate({ name: 'stack', stack });
    if (taskId) navigate({ name: 'task', taskId });
  }
  function openConversations() {
    navigate({ name: 'conversations', conversationId: readLastOpenedItem('conversation') });
  }
  function handleConversationSelected(conversationId: string | null) {
    syncedConversationId.current = conversationId;
    // Landing on the console picks a conversation for you; replacing that entry
    // keeps one back press enough to leave the console again.
    navigate({ name: 'conversations', conversationId }, { replace: route.name === 'conversations' && route.conversationId === null });
  }
  useEffect(() => {
    if (route.name !== 'conversations') return;
    // Switching rails clears the selection before the new rail picks its first
    // conversation, so the workspace briefly addresses `/conversations` and then
    // the conversation it settled on. The workspace's own effects flush before
    // this one, which means `route` here can already describe a superseded
    // address. Remounting on that stale intermediate reset the rail to Active
    // and reopened an unrelated conversation. Only a render that still matches
    // the live address describes navigation that came from outside.
    if (routePath(route) !== window.location.pathname) return;
    if (route.conversationId === syncedConversationId.current) return;
    // The address changed from outside the workspace — a link, a notification,
    // or the back button — so remount it on the conversation the URL names.
    syncedConversationId.current = route.conversationId;
    setConversationNavigationVersion((current) => current + 1);
  }, [route]);
  useEffect(() => {
    if (route.name === 'stack') setTaskStack(route.stack);
  }, [route]);
  useEffect(() => {
    const count = pinnedReminder.data?.items.filter((item) => item.status === 'pinned').length ?? 0;
    if (!count) return;
    const today = new Date().toLocaleDateString('en-CA');
    const key = 'workbench:pinned-reminder-date';
    if (window.localStorage.getItem(key) === today) return;
    window.localStorage.setItem(key, today);
    toast.info(`${count} pinned task${count === 1 ? '' : 's'} waiting for you.`, {
      action: () => {
        setPendingPinnedNavigation(true);
        navigate({ name: 'stack', stack: 'active' });
      },
      actionLabel: 'Open pinned',
    });
  }, [pinnedReminder.data]);
  useEffect(() => {
    if (route.name !== 'task' || resolvedTaskId === route.taskId) return;
    const taskId = route.taskId;
    let canceled = false;
    void queryClient.fetchQuery({ queryKey: ['work-item', taskId], queryFn: () => api.getWorkItem(taskId) })
      .then(({ item }) => {
        if (canceled) return;
        const stack = item.archivedAt ? 'archive' : isWorkbenchProject(item.projectName) ? 'workbench' : 'active';
        setTaskStack(stack);
        if (stack !== 'archive') writeLastOpenedItem(stack === 'workbench' ? 'workbench' : 'attention', item.id);
        setResolvedTaskId(taskId);
      })
      .catch(() => {
        // A dead task link still renders the detail panel, which reports the
        // failure in place; this only stops the stack lookup from retrying.
        if (!canceled) setResolvedTaskId(taskId);
      });
    return () => { canceled = true; };
  }, [queryClient, resolvedTaskId, route]);
  const queueAgentActivity = useQuery({ queryKey: ['shared-message-activity'], queryFn: () => api.listSharedMessages(), refetchInterval: 5_000 });
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
    onSuccess: (_result, variables) => {
      navigate({ name: 'stack', stack: 'active' });
      toast.success(variables.resolution === 'accepted' ? 'Proposed stack accepted.' : 'Proposed stack rejected.');
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
    onError: (error) => toastError('Could not update the proposal.', error),
  });
  const planQueue = useMutation({
    mutationFn: () => api.planQueue('attention'),
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
  const taskStackScope = view === 'workbench' ? 'workbench' : view === 'archive' ? 'archive' : 'attention';
  const { items: renderedItems, rows: renderedRows } = useMemo(() => createTaskStackViewModel(filtered, taskStackScope), [filtered, taskStackScope]);
  useEffect(() => {
    if (route.name !== 'task' || !pendingTaskNavigation || pendingTaskNavigation !== route.taskId) return;
    // Wait until the stack behind the task is known: before that the queue can
    // still be listing another stack, where the task is legitimately missing.
    if (pendingTaskNavigation !== resolvedTaskId) return;
    const resolvedDetail = queryClient.getQueryData<WorkItemDetail>(['work-item', pendingTaskNavigation]);
    const resolvedStack = resolvedDetail?.item.archivedAt ? 'archive' : isWorkbenchProject(resolvedDetail?.item.projectName) ? 'workbench' : 'active';
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
          const scroller = queueScrollRef.current;
          const card = scroller?.querySelector<HTMLElement>(`[data-work-item-id="${pendingTaskNavigation}"]`);
          if (!scroller || !card) return;
          // scrollIntoView can scroll the document (or a detail pane) instead
          // of this independently scrolling stack. Target the stack directly.
          const cardBounds = card.getBoundingClientRect();
          const stackBounds = scroller.getBoundingClientRect();
          const top = Math.max(0, scroller.scrollTop + cardBounds.top - stackBounds.top - (scroller.clientHeight - cardBounds.height) / 2);
          if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'smooth' });
          else card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    if (!pendingPinnedNavigation || route.name !== 'stack' || route.stack !== 'active') return;
    const scroller = queueScrollRef.current;
    const pinnedHeader = scroller?.querySelector<HTMLElement>('.stack-header-pinned');
    if (!scroller || !pinnedHeader) {
      if (items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      // Scroll the queue itself so the detail pane and document position stay put.
      const headerBounds = pinnedHeader.getBoundingClientRect();
      const stackBounds = scroller.getBoundingClientRect();
      const top = Math.max(0, scroller.scrollTop + headerBounds.top - stackBounds.top);
      if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'smooth' });
      else pinnedHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setPendingPinnedNavigation(false);
    });
    return () => window.cancelAnimationFrame(frame);
  // The query result object is intentionally represented by its stable fields.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.fetchNextPage, items.hasNextPage, items.isFetchingNextPage, pendingPinnedNavigation, renderedRows.length, route]);
  useEffect(() => {
    // On tall mobile viewports the first page can be shorter than the
    // container, so it never becomes scrollable and onScroll-driven
    // pagination never fires, leaving a permanent blank gap below the list.
    const element = queueScrollRef.current;
    if (!element || !items.hasNextPage || items.isFetchingNextPage) return;
    if (element.scrollHeight <= element.clientHeight) void items.fetchNextPage();
  // The query result object is intentionally represented by its stable fields.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedRows.length, items.fetchNextPage, items.hasNextPage, items.isFetchingNextPage]);

  function openTaskFromConversation(taskId: string) {
    setPendingTaskNavigation(taskId);
    navigate({ name: 'task', taskId });
  }

  function selectTaskInStack(taskId: string) {
    // The stack on screen already contains this task, so the URL can change
    // without waiting to be told which stack the task belongs to.
    setResolvedTaskId(taskId);
    setPendingTaskNavigation(taskId);
    if (view === 'active' || view === 'workbench') writeLastOpenedItem(view === 'workbench' ? 'workbench' : 'attention', taskId);
    navigate({ name: 'task', taskId });
  }

  function revealCreatedTask(item: WorkItem) {
    // Creation can place a task anywhere in the scored stack, including a page
    // that has not been loaded yet. The existing pending-navigation effect will
    // fetch forward until it can center the new card.
    animateTaskEnter(item.id);
    setTaskStack(isWorkbenchProject(item.projectName) ? 'workbench' : 'active');
    writeLastOpenedItem(isWorkbenchProject(item.projectName) ? 'workbench' : 'attention', item.id);
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
    if (!activeItem || !overItem || activeItem.status !== overItem.status) return;
    const group = current.filter((item) => item.status === activeItem.status);
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
          <button className={`nav-item ${view === 'active' ? 'active' : ''}`} onClick={() => { openPrimaryStack('active'); setMobileNavOpen(false); }}><Command size={16} /> Attention stack <span>{workItemCounts.data?.active ?? '…'}</span></button>
          <button className={`nav-item ${view === 'workbench' ? 'active' : ''}`} onClick={() => { openPrimaryStack('workbench'); setMobileNavOpen(false); }}><Wrench size={16} /> Workbench <span>{workItemCounts.data?.workbench ?? '…'}</span></button>
          <DiscoveryNav active={view === 'discovery'} onClick={() => { navigate({ name: 'discovery' }); setMobileNavOpen(false); }} />
          <button className={`nav-item ${view === 'context' ? 'active' : ''}`} onClick={() => { openConversations(); setMobileNavOpen(false); }}><MessageCircle size={16} /> Conversations <span>{totalConversationCount.data?.count ?? '…'}</span></button>
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

      {view === 'context' ? <SharedWorkspace key={`conversation-${conversationNavigationVersion}`} initialConversationId={agentConversationId} view={conversationRailView} onViewChange={setConversationRailView} onSelectConversation={handleConversationSelected} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} /> : view === 'artifacts' ? <ArtifactLibraryView onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenConversation={openConversation} /> : view === 'insights' ? <InsightsView /> : view === 'discovery' ? <DiscoveryInboxView onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenStack={() => navigate({ name: 'stack', stack: 'active' })} /> : <><main className="queue-panel">
        <header className="queue-header">
          <div><span className="eyebrow">{view === 'active' ? 'Focus' : view === 'workbench' ? 'Focus' : 'History'}</span><h2>{view === 'active' ? 'Attention stack' : view === 'workbench' ? 'Workbench focus' : 'Archive'}</h2></div>
          <div className="header-actions">
            {(view === 'active' || view === 'workbench') && <>
            <button className="button secondary compact" onClick={() => planQueue.mutate()} disabled={planQueue.isPending}>
              {planQueue.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} {planQueue.isPending ? 'Reordering…' : 'Reorder stack'}
            </button>
            <button className="button primary compact" onClick={() => setShowCreate(true)}><Plus size={15} /> New</button>
            </>}
          </div>
        </header>
        {selectedIds.size > 0 && <div className="queue-bulkbar" role="toolbar" aria-label="Bulk task actions"><span>{selectedIds.size} selected</span><button onClick={() => bulkUpdate.mutate({ action: view === 'archive' ? 'restore' : 'archive', ids: [...selectedIds] })} disabled={bulkUpdate.isPending}>{view === 'archive' ? 'Restore' : 'Archive'}</button><button onClick={() => setSelectedIds(new Set())}>Clear</button>{view === 'workbench' && <small>Workbench is filtered to the Workbench project.</small>}</div>}
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
        <div ref={queueScrollRef} className="queue-list" role="list" aria-label={view === 'archive' ? 'Archived tasks' : view === 'workbench' ? 'Workbench focus' : 'Work stacks'} onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 500 && items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
        }}>
          {items.isLoading && <ListRowSkeleton count={8} />}
          {items.isError && <div className="list-state error-message">Could not load work items. <button className="button secondary compact" onClick={() => items.refetch()}>Retry</button></div>}
          {!items.isLoading && !items.isError && filtered.length === 0 && <div className="list-state">{view === 'active' ? 'No work items yet. Add one or connect Linear.' : view === 'workbench' ? 'No Workbench-project tasks yet.' : 'No archived tasks.'}</div>}
          <SortableContext items={(view === 'active' || view === 'workbench') && !items.hasNextPage && selectedIds.size === 0 ? renderedItems.map((item) => item.id) : []} strategy={verticalListSortingStrategy}>
            <div className="queue-rows">
              {renderedRows.map((rendered, index) => rendered.type === 'header'
                ? <div key={rendered.id} className={`stack-header stack-header-${rendered.group}`}><span>{rendered.label}</span><strong>{rendered.count}</strong></div>
                : <div key={rendered.id} className={`task-group-row task-group-${rendered.group} ${enteringTaskIds.has(rendered.item.id) ? 'is-entering' : ''} ${exitingTaskIds.has(rendered.item.id) ? 'is-exiting' : ''}`}><TaskQueueItem item={rendered.item} index={index} selected={selectedId === rendered.item.id} focused={(focusedId ?? renderedItems[0]?.id) === rendered.item.id} draggable={(view === 'active' || view === 'workbench') && !items.isFetchingNextPage && !items.hasNextPage && selectedIds.size === 0} onSelect={() => selectTaskInStack(rendered.item.id)} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onFocus={() => setFocusedId(rendered.item.id)} onKeyDown={(event) => handleQueueKeyDown(event, rendered.item.id)} /></div>)}
            </div>
          </SortableContext>
          {items.isFetchingNextPage && <div className="page-state"><LoaderCircle className="spin" size={14} /> Loading more…</div>}
          {!items.hasNextPage && filtered.length > 0 && <div className="page-state">All {items.data?.pages[0]?.totalCount ?? filtered.length} items loaded</div>}
        </div>
        </DndContext>
      </main>

      {selectedId ? <TaskDetail key={selectedId} id={selectedId} onClose={() => navigate({ name: 'stack', stack: taskStack })} onCreated={revealCreatedTask} onRemoving={animateTaskExit} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenConversation={openConversation} /> : <section className="detail-empty"><Sparkles /><h2>Choose your next move</h2><p>Select an item or add something new.</p></section>}</>}
      {showCreate && <CreateTask onClose={() => setShowCreate(false)} onCreated={revealCreatedTask} defaultProjectName={view === 'workbench' ? WORKBENCH_PROJECT_NAME : ''} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
    </div>
  );
}
