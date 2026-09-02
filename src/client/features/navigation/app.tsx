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
import { Fragment, type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownComposer } from '../../components/markdown/markdown-composer.js';
import { MarkdownCode, MarkdownPre } from '../../components/markdown/markdown-code.js';
import { isSelfAssigned, SELF_ASSIGNED_EXECUTION_MESSAGE, SELF_ASSIGNED_OWNER_MESSAGE } from '../../../shared/contracts';
import type { AgentRun, Assignee, ExecutionPlan, ProviderSyncConflict, SharedConversation, SharedMessage, UpdateWorkItemInput, WorkItem, WorkItemDetail, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../../../shared/contracts';
import { api } from '../../data/api';
import { ArtifactLibraryView } from '../artifacts/view';
import { ConfirmationDialog } from '../../components/dialogs/confirmation-dialog';
import { InsightsView } from '../insights/view';
import { navigate, parseRoute, routePath, useRoute, type StackName } from '../../lib/router';
import { TaskQueueSkeleton } from '../../components/skeleton/skeleton';
import { Toaster } from '../../components/toast/toast';
import { toast, toastError } from '../../state/toast-store';
import { SortableQueueItem as TaskQueueItem, TaskClassificationSelect } from '../queue';
import { AgentMessageBody, LiveRunOutput } from '../../components/agent-message/agent-message';
import { ConversationOriginBadge, ModelProfileSelect, ReferenceTypeIcon } from '../../components/badges';
import { CreateTask, type CreateTaskReopenState } from '../../components/dialogs/create-task-dialog';
import { DiscoveryInboxView } from '../discovery';
import { useNavigation } from '../../features/navigation/hooks';
import { NavigationView } from '../../features/navigation/view';
import { FollowUpArchiveDialog } from '../../components/dialogs/follow-up-archive-dialog';
import { activityKindLabel, agentDecisionKinds, formatFileSize, formatRunBadge, formatRunTelemetry, memorySourceLabel, selectBalancedVisibleAgent, sourceLinkLabel, sourceReferenceTitle, sourceReferenceType, taskDetailSaveFeedback } from '../../lib/formatters';
import { clearLastOpenedItem, clearSentConversationDraft, readConversationDrafts, readConversationModelProfiles, readTaskModelProfiles, writeConversationDraft, writeConversationModelProfiles, writeLastOpenedItem, writeTaskModelProfile } from '../../lib/preferences';
import { QueueExplanationList } from '../../components/queue-explanations';
import { ProjectColorDot } from '../../components/project/project-color';
import { InlineProjectEditor } from '../../components/project/project-field';
import { useValuePulse } from '../../hooks/use-value-pulse';
import { isWorkbenchProject, WORKBENCH_PROJECT_NAME } from '../../../shared/project-name';
import { SourcesDialog } from '../source';
import { SettingsDialog } from '../settings';
import { createTaskStackViewModel } from '../../lib/stack-view-model';
import { useRealtimeNotifications, type RealtimeNotification } from '../../hooks/realtime';
import { useAttentionIndicator } from '../../hooks/attention-indicator';
import { useTaskStackReorderAnimation } from '../queue/use-task-stack-reorder-animation';
import { reorderTaskPages, reorderTasks, type TaskReorderTarget } from '../queue/task-reorder';

import { SharedWorkspace } from '../conversation/view';
import { TaskDetail } from '../task/view';

type QueueReorderRequest = TaskReorderTarget & { stack: 'attention' | 'workbench' };
type QueueReorderMutation = {
  request: QueueReorderRequest;
  queryKey: readonly ['work-items', string, string];
  previous: InfiniteData<WorkItemPage> | undefined;
};

const PINNED_REMINDER_INTERVAL_MS = 30 * 60_000;

function PulseCount({ value, as: Tag = 'strong' }: { value: number; as?: 'strong' | 'span' }) {
  const pulse = useValuePulse(value);
  return <Tag className={pulse}>{value}</Tag>;
}

export function App() {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: api.getHealth, refetchInterval: 15_000 });
  const attentionCount = useQuery({
    queryKey: ['conversation-attention-count'],
    queryFn: api.getAttentionConversationCount,
    refetchInterval: 15_000,
  });
  useAttentionIndicator(attentionCount.data?.count ?? 0);
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
  const [createTaskReopenState, setCreateTaskReopenState] = useState<CreateTaskReopenState | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProposalDetail, setShowProposalDetail] = useState(false);
  const [taskSearch, setTaskSearch] = useState('');
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
  const [pendingTaskReorder, setPendingTaskReorder] = useState<QueueReorderRequest | null>(null);
  // A saved primary-surface task can be archived elsewhere between visits. It
  // must not turn clicking Workbench into navigation to the Archive filter.
  const primaryStackTask = useRef<{ taskId: string; stack: Extract<StackName, 'active' | 'workbench'> } | null>(null);
  const taskEnterTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const selectedId = route.name === 'task' ? route.taskId : null;
  const animateTaskExit = (id: string) => new Promise<void>((resolve) => {
    setExitingTaskIds((current) => new Set(current).add(id));
    window.setTimeout(resolve, 560);
    // Clearing `is-exiting` while the row is still mounted flips its
    // `animation` back to the base rule's `queue-card-enter`, replaying the
    // entrance animation on a card that is supposed to be leaving. The
    // effect below clears the flag only once the row has actually left
    // `renderedItems`. This fallback exists purely so a failed archive
    // (row never leaves the list) doesn't hide the row forever.
    window.setTimeout(() => {
      setExitingTaskIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 10_000);
  });
  const animateTaskEnter = (id: string) => {
    setEnteringTaskIds((current) => new Set(current).add(id));
    const timer = setTimeout(() => {
      taskEnterTimers.current.delete(timer);
      setEnteringTaskIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 560);
    taskEnterTimers.current.add(timer);
  };
  useEffect(() => () => taskEnterTimers.current.forEach((timer) => clearTimeout(timer)), []);
  const agentConversationId = route.name === 'conversations' ? route.conversationId : null;
  const handleRealtimeNotification = useCallback((notification: RealtimeNotification) => {
    if (notification.action) {
      const target = parseRoute(notification.action.route);
      const alreadyViewing = (target.name === 'task' && route.name === 'task' && route.taskId === target.taskId)
        || (target.name === 'conversations' && target.conversationId !== null && agentConversationId === target.conversationId);
      // Jeffrey is already looking at the task or conversation the update is
      // about, so a toast would just duplicate what's already on screen.
      if (alreadyViewing) return;
    }
    const options = {
      description: notification.description,
      duration: notification.duration,
      ...(notification.action ? {
        action: () => navigate(parseRoute(notification.action!.route)),
        actionLabel: notification.action.label,
      } : {}),
    };
    toast[notification.tone](notification.message, options);
  }, [route, agentConversationId]);
  const { state: realtimeConnectionState, browserOffline: realtimeBrowserOffline, retryNow: retryRealtimeConnection } = useRealtimeNotifications(handleRealtimeNotification);
  const view = route.name === 'stack' ? route.stack : route.name === 'task' ? taskStack : route.name === 'conversations' ? 'context' : route.name;
  const { mobileNavOpen, setMobileNavOpen, isCompactNav, workItems: workItemCounts, conversations: totalConversationCount } = useNavigation();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const [isTaskDragging, setIsTaskDragging] = useState(false);
  const dragFinishFrame = useRef<number | null>(null);
  // A pointer/keyboard drag already has dnd-kit's immediate movement. Suppress
  // the following server refresh so only system-initiated rank changes use FLIP.
  const skipNextDragReorderAnimation = useRef(false);
  const isArchiveView = view === 'archive' || view === 'workbench-archive';
  const isWorkbenchScope = view === 'workbench' || view === 'workbench-archive';
  const queueView = view === 'workbench-archive' ? 'workbench-archive' : view === 'archive' ? 'archive' : view === 'workbench' ? 'workbench' : 'active';
  const items = useInfiniteQuery({
    queryKey: ['work-items', queueView, taskSearch.trim()],
    queryFn: ({ pageParam }) => api.listWorkItems(queueView, taskSearch.trim(), pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: view === 'active' || view === 'workbench' || isArchiveView,
  });
  const pinnedReminder = useQuery({ queryKey: ['pinned-reminder'], queryFn: () => api.listWorkItems('active', ''), staleTime: 60_000, refetchInterval: PINNED_REMINDER_INTERVAL_MS });
  const syncedConversationId = useRef<string | null>(route.name === 'conversations' ? route.conversationId : null);
  function openConversation(conversationId: string) {
    navigate({ name: 'conversations', conversationId });
  }
  function openPrimaryStack(stack: Extract<StackName, 'active' | 'workbench'>) {
    setTaskStack(stack);
    primaryStackTask.current = null;
    navigate({ name: 'stack', stack });
  }
  function openConversations() {
    navigate({ name: 'conversations', conversationId: null });
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
    const key = 'workbench:pinned-reminder-shown-at';
    const lastShown = Number(window.localStorage.getItem(key) ?? 0);
    const now = Date.now();
    if (now - lastShown < PINNED_REMINDER_INTERVAL_MS) return;
    window.localStorage.setItem(key, String(now));
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
        const stack = item.archivedAt ? (isWorkbenchProject(item.projectName) ? 'workbench-archive' : 'archive') : isWorkbenchProject(item.projectName) ? 'workbench' : 'active';
        const requested = primaryStackTask.current;
        if (item.archivedAt && requested?.taskId === taskId) {
          // The saved selection is stale. Keep the requested stack open and
          // forget it so the next Workbench click is clean as well.
          clearLastOpenedItem(requested.stack === 'workbench' ? 'workbench' : 'attention');
          primaryStackTask.current = null;
          setTaskStack(requested.stack);
          setResolvedTaskId(taskId);
          navigate({ name: 'stack', stack: requested.stack }, { replace: true });
          return;
        }
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
  const queueAgentActivity = useQuery({ queryKey: ['shared-message-activity'], queryFn: api.listSharedMessageActivity, refetchInterval: 5_000 });
  const queueAgentStatusSignature = (queueAgentActivity.data?.messages ?? []).map((message) => `${message.id}:${message.status}`).join('|');
  useEffect(() => {
    if (queueAgentStatusSignature) void queryClient.invalidateQueries({ queryKey: ['work-items'] });
  }, [queryClient, queueAgentStatusSignature]);
  const reorder = useMutation({
    mutationFn: ({ request }: QueueReorderMutation) => api.reorderQueue(request),
    onError: (error, { queryKey, previous }) => {
      queryClient.setQueryData(queryKey, previous);
      setPendingTaskReorder(null);
      toastError('Could not save the new order. The list will reset.', error);
    },
    onSuccess: async (_result, { request }) => {
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
      setPendingTaskReorder((current) => current?.itemId === request.itemId ? null : current);
    },
  });
  const resolveProposal = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: 'accepted' | 'rejected' }) => api.resolveQueueProposal(id, resolution),
    onSuccess: (result, variables) => {
      navigate({ name: 'stack', stack: result.proposal.stack === 'workbench' ? 'workbench' : 'active' });
      toast.success(variables.resolution === 'accepted' ? 'Proposed stack accepted.' : 'Proposed stack rejected.');
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
    onError: (error) => toastError('Could not update the proposal.', error),
  });
  const planQueue = useMutation({
    mutationFn: (stack: 'attention' | 'workbench') => api.planQueue(stack),
    onSuccess: (_result, stack) => {
      toast.success(`${stack === 'workbench' ? 'Workbench' : 'Attention'} stack proposal ready.`);
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
  const serverFiltered = useMemo(() => items.data?.pages.flatMap((page) => page.items) ?? [], [items.data?.pages]);
  // TanStack Query remains the server-state owner. This local projection exists
  // only to guarantee that dnd teardown and the final order share one paint.
  const filtered = useMemo(
    () => pendingTaskReorder ? reorderTasks(serverFiltered, pendingTaskReorder) : serverFiltered,
    [pendingTaskReorder, serverFiltered],
  );
  const taskStackScope = isArchiveView ? 'archive' : view === 'workbench' ? 'workbench' : 'attention';
  const { items: renderedItems, rows: renderedRows } = useMemo(() => createTaskStackViewModel(filtered, taskStackScope), [filtered, taskStackScope]);
  // Rendered sections are separate rank domains. The Attention section contains
  // several raw statuses, so drag-and-drop must use this visible grouping rather
  // than treating each status as a separate list.
  const renderedSections = useMemo(() => {
    type Header = Extract<typeof renderedRows[number], { type: 'header' }>;
    type Item = Extract<typeof renderedRows[number], { type: 'item' }>;
    const sections: Array<{ header: Header | null; items: Item[] }> = [];
    for (const row of renderedRows) {
      if (row.type === 'header') {
        sections.push({ header: row, items: [] });
      } else {
        const section = sections.at(-1);
        if (section) section.items.push(row);
        else sections.push({ header: null, items: [row] });
      }
    }
    return sections;
  }, [renderedRows]);
  useTaskStackReorderAnimation(queueScrollRef, renderedItems.map((item) => item.id), skipNextDragReorderAnimation, queueView);
  useEffect(() => {
    if (exitingTaskIds.size === 0) return;
    const presentIds = new Set(renderedItems.map((item) => item.id));
    const stale = [...exitingTaskIds].filter((id) => !presentIds.has(id));
    if (stale.length === 0) return;
    setExitingTaskIds((current) => {
      const next = new Set(current);
      for (const id of stale) next.delete(id);
      return next;
    });
  }, [renderedItems, exitingTaskIds]);
  useEffect(() => {
    if (route.name !== 'task' || !pendingTaskNavigation || pendingTaskNavigation !== route.taskId) return;
    // Wait until the stack behind the task is known: before that the queue can
    // still be listing another stack, where the task is legitimately missing.
    if (pendingTaskNavigation !== resolvedTaskId) return;
    const resolvedDetail = queryClient.getQueryData<WorkItemDetail>(['work-item', pendingTaskNavigation]);
    const resolvedStack = resolvedDetail?.item.archivedAt ? (isWorkbenchProject(resolvedDetail.item.projectName) ? 'workbench-archive' : 'archive') : isWorkbenchProject(resolvedDetail?.item.projectName) ? 'workbench' : 'active';
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

  useEffect(() => () => {
    if (dragFinishFrame.current !== null) window.cancelAnimationFrame(dragFinishFrame.current);
  }, []);

  function startTaskDrag() {
    if (dragFinishFrame.current !== null) window.cancelAnimationFrame(dragFinishFrame.current);
    dragFinishFrame.current = null;
    setIsTaskDragging(true);
  }

  function finishTaskDrag() {
    if (dragFinishFrame.current !== null) window.cancelAnimationFrame(dragFinishFrame.current);
    // Keep visual transitions disabled through dnd-kit's teardown commit. The
    // class can disappear once the card is already resting in its final style.
    dragFinishFrame.current = window.requestAnimationFrame(() => {
      dragFinishFrame.current = null;
      setIsTaskDragging(false);
    });
  }

  function commitTaskReorder(request: QueueReorderRequest) {
    const queryKey = ['work-items', queueView, taskSearch.trim()] as const;
    const previous = queryClient.getQueryData<InfiniteData<WorkItemPage>>(queryKey);
    skipNextDragReorderAnimation.current = true;
    setPendingTaskReorder(request);
    queryClient.setQueryData<InfiniteData<WorkItemPage>>(queryKey, (current) => current && ({
      ...current,
      pages: reorderTaskPages(current.pages, request),
    }));
    reorder.mutate({ request, queryKey, previous });
  }

  function handleDragEnd(event: DragEndEvent) {
    finishTaskDrag();
    const { active, over } = event;
    if (!over || active.id === over.id || items.isFetchingNextPage) return;
    const activeRow = renderedRows.find((row) => row.type === 'item' && row.id === active.id);
    const overRow = renderedRows.find((row) => row.type === 'item' && row.id === over.id);
    if (!activeRow || activeRow.type !== 'item' || !overRow || overRow.type !== 'item' || activeRow.group !== overRow.group) return;
    const group = renderedRows.flatMap((row) => row.type === 'item' && row.group === activeRow.group ? [row.item] : []);
    const oldIndex = group.findIndex((item) => item.id === active.id);
    const newIndex = group.findIndex((item) => item.id === over.id);
    const moved = arrayMove(group, oldIndex, newIndex);
    const next = moved[newIndex + 1];
    const previous = moved[newIndex - 1];
    const stack = view === 'workbench' ? 'workbench' : 'attention';
    if (next) {
      commitTaskReorder({ itemId: String(active.id), beforeId: next.id, stack });
    } else if (previous) {
      commitTaskReorder({ itemId: String(active.id), afterId: previous.id, stack });
    }
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
      {(realtimeBrowserOffline || realtimeConnectionState === 'reconnecting' || realtimeConnectionState === 'polling') && (
        <div className="realtime-status-banner" role="status">
          <LoaderCircle className="spin" size={13} />
          {realtimeBrowserOffline
            ? 'Offline — showing cached data'
            : realtimeConnectionState === 'reconnecting'
              ? 'Reconnecting… showing cached data'
              : 'Live agent updates are polling over HTTPS'}
          <button type="button" className="realtime-status-retry" onClick={() => retryRealtimeConnection()}>Retry now</button>
        </div>
      )}
      <NavigationView
        view={view === 'workbench-archive' ? 'workbench' : view}
        mobileNavOpen={mobileNavOpen}
        isCompactNav={isCompactNav}
        counts={workItemCounts.data}
        conversationCount={totalConversationCount.data?.count}
        onOpenActive={() => { openPrimaryStack('active'); setMobileNavOpen(false); }}
        onOpenWorkbench={() => { openPrimaryStack('workbench'); setMobileNavOpen(false); }}
        onOpenDiscovery={() => { navigate({ name: 'discovery' }); setMobileNavOpen(false); }}
        onOpenConversations={() => { openConversations(); setMobileNavOpen(false); }}
        onOpenArtifacts={() => { navigate({ name: 'artifacts' }); setMobileNavOpen(false); }}
        onOpenInsights={() => { navigate({ name: 'insights' }); setMobileNavOpen(false); }}
        onOpenSources={() => { setShowSources(true); setMobileNavOpen(false); }}
        onOpenSettings={() => { setShowSettings(true); setMobileNavOpen(false); }}
        onToggleMore={() => setMobileNavOpen((open) => !open)}
        onSelectGlobalSearchResult={(result) => {
          if (result.conversationId) openConversation(result.conversationId);
          else if (result.workItemId) openTaskFromConversation(result.workItemId);
          setMobileNavOpen(false);
        }}
      />

      {view === 'context' ? <SharedWorkspace key={`conversation-${conversationNavigationVersion}`} initialConversationId={agentConversationId} initialStackOnly={agentConversationId === null} view={conversationRailView} onViewChange={setConversationRailView} onSelectConversation={handleConversationSelected} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} /> : view === 'artifacts' ? <ArtifactLibraryView onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenConversation={openConversation} /> : view === 'insights' ? <InsightsView /> : view === 'discovery' ? <DiscoveryInboxView onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenStack={() => navigate({ name: 'stack', stack: 'active' })} /> : <><main className="queue-panel">
        <header className="queue-header stack-toolbar">
          <div className="stack-toolbar-copy"><span className="eyebrow">{isArchiveView ? 'Archive' : 'Tasks'}</span><h2>{isWorkbenchScope ? 'Workbench focus' : 'Attention stack'}</h2></div>
          <div className="header-actions">
            {(!isArchiveView) && <>
            <button className="icon-button" onClick={() => planQueue.mutate(isWorkbenchScope ? 'workbench' : 'attention')} disabled={planQueue.isPending} aria-label={planQueue.isPending ? 'Reordering stack' : 'Reorder stack'} title={planQueue.isPending ? 'Reordering stack' : 'Reorder stack'}>
              {planQueue.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
            </button>
            <button className="icon-button primary" onClick={() => { setCreateTaskReopenState(null); setShowCreate(true); }} aria-label="New task" title="New task"><Plus size={15} /></button>
            </>}
          </div>
        </header>
        <div className="search-box task-search-box">
          <Search size={15} />
          <input
            aria-label="Search tasks"
            value={taskSearch}
            onChange={(event) => setTaskSearch(event.target.value)}
            placeholder="Search everything…"
          />
          {taskSearch && <button type="button" className="icon-button" aria-label="Clear task search" onClick={() => setTaskSearch('')}><X size={13} /></button>}
        </div>
        <div className="stack-view-filter task-view-filter" role="group" aria-label="Task view"><button type="button" className={!isArchiveView ? 'active' : ''} aria-pressed={!isArchiveView} onClick={() => navigate({ name: 'stack', stack: isWorkbenchScope ? 'workbench' : 'active' })}>Active</button><button type="button" className={isArchiveView ? 'active' : ''} aria-pressed={isArchiveView} onClick={() => navigate({ name: 'stack', stack: isWorkbenchScope ? 'workbench-archive' : 'archive' })}>Archive <PulseCount as="span" value={isArchiveView ? items.data?.pages[0]?.totalCount ?? 0 : isWorkbenchScope ? workItemCounts.data?.workbenchArchive ?? 0 : workItemCounts.data?.attentionArchive ?? 0} /></button></div>
        {selectedIds.size > 0 && <div className="queue-bulkbar" role="toolbar" aria-label="Bulk task actions"><span>{selectedIds.size} selected</span><button onClick={() => bulkUpdate.mutate({ action: isArchiveView ? 'restore' : 'archive', ids: [...selectedIds] })} disabled={bulkUpdate.isPending}>{isArchiveView ? 'Restore' : 'Archive'}</button><button onClick={() => setSelectedIds(new Set())}>Clear</button>{isWorkbenchScope && <small>Workbench is filtered to the Workbench project.</small>}</div>}
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={startTaskDrag} onDragCancel={finishTaskDrag} onDragEnd={handleDragEnd}>
        <div ref={queueScrollRef} className={`queue-list ${isTaskDragging ? 'is-dragging' : ''}`} role="list" aria-label={isArchiveView ? 'Archived tasks' : view === 'workbench' ? 'Workbench focus' : 'Work stacks'} onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 500 && items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
        }}>
          {items.isLoading && <TaskQueueSkeleton count={8} />}
          {items.isError && <div className="list-state error-message">Could not load work items. <button className="button secondary compact" onClick={() => items.refetch()}>Retry</button></div>}
          {!items.isLoading && !items.isError && filtered.length === 0 && <div className="list-state">{taskSearch.trim() ? `No tasks match “${taskSearch.trim()}”.` : view === 'active' ? 'No work items yet. Add one or connect Linear.' : view === 'workbench' ? 'No Workbench-project tasks yet.' : 'No archived tasks.'}</div>}
          <div className="queue-rows">
            {renderedSections.map((section, sectionIndex) => <Fragment key={`section-${section.header?.id ?? sectionIndex}`}>
              {section.header && <div key={section.header.id} className={`stack-header stack-header-${section.header.group}`}><span>{section.header.label}</span><PulseCount value={section.header.count} /></div>}
              <SortableContext items={(view === 'active' || view === 'workbench') && selectedIds.size === 0 ? section.items.filter(({ item }) => item.status !== 'in_progress').map((item) => item.id) : []} strategy={verticalListSortingStrategy}>
                {section.items.map((rendered) => <div key={rendered.id} className={`task-group-row task-group-${rendered.group} ${enteringTaskIds.has(rendered.item.id) ? 'is-entering' : ''} ${exitingTaskIds.has(rendered.item.id) ? 'is-exiting' : ''}`}><TaskQueueItem item={rendered.item} index={renderedItems.indexOf(rendered.item)} selected={selectedId === rendered.item.id} focused={(focusedId ?? renderedItems[0]?.id) === rendered.item.id} draggable={(view === 'active' || view === 'workbench') && rendered.item.status !== 'in_progress' && !items.isFetchingNextPage && selectedIds.size === 0} onSelect={() => selectTaskInStack(rendered.item.id)} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onFocus={() => setFocusedId(rendered.item.id)} onKeyDown={(event) => handleQueueKeyDown(event, rendered.item.id)} /></div>)}
              </SortableContext>
            </Fragment>)}
          </div>
          {items.isFetchingNextPage && <TaskQueueSkeleton count={2} />}
          {!items.hasNextPage && filtered.length > 0 && <div className="page-state">All {items.data?.pages[0]?.totalCount ?? filtered.length} items loaded</div>}
        </div>
        </DndContext>
      </main>

      {selectedId ? <TaskDetail key={selectedId} id={selectedId} onClose={() => navigate({ name: 'stack', stack: taskStack })} onCreated={revealCreatedTask} onRemoving={animateTaskExit} onOpenTask={(taskId) => { openTaskFromConversation(taskId); }} onOpenConversation={openConversation} /> : <section className="detail-empty"><Sparkles /><h2>Choose your next move</h2><p>Select an item or add something new.</p></section>}</>}
      {showCreate && <CreateTask onClose={() => setShowCreate(false)} onCreated={revealCreatedTask} onBackgroundError={(state) => { setCreateTaskReopenState(state); setShowCreate(true); }} initialState={createTaskReopenState} defaultProjectName={view === 'workbench' ? WORKBENCH_PROJECT_NAME : ''} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </div>
  );
}
