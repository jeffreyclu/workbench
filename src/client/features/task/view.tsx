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
  Eye,
  EyeOff,
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
  Settings,
  Trash2,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { Fragment, type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownComposer } from '../../components/markdown/markdown-composer.js';
import { MarkdownCode, MarkdownPre } from '../../components/markdown/markdown-code.js';
import { isSelfAssigned, SELF_ASSIGNED_EXECUTION_MESSAGE, SELF_ASSIGNED_OWNER_MESSAGE } from '../../../shared/contracts';
import type { AgentRun, Assignee, ExecutionPlan, ProviderSyncConflict, SessionFeedbackRating, SharedConversation, SharedMessage, UpdateWorkItemInput, WorkItem, WorkItemDetail, WorkItemPage, WorkItemReference, WorkItemReferenceType } from '../../../shared/contracts';
import { api } from '../../data/api';
import { ArtifactLibraryView } from '../artifacts/view';
import { AttachmentPreview } from '../../components/attachment-preview';
import { ConfirmationDialog } from '../../components/dialogs/confirmation-dialog';
import { InsightsView } from '../insights/view';
import { navigate, parseRoute, routePath, useRoute, type StackName } from '../../lib/router';
import { useDebouncedValue } from '../conversation/hooks';
import { CandidateRowSkeleton, TaskDetailSkeleton } from '../../components/skeleton/skeleton';
import { Toaster } from '../../components/toast/toast';
import { toast, toastError } from '../../state/toast-store';
import { SortableQueueItem as TaskQueueItem, TaskClassificationSelect } from '../queue';
import { AgentMessageBody, LiveRunOutput } from '../../components/agent-message/agent-message';
import { ConversationOriginBadge, ModelProfileSelect, ReferenceTypeIcon } from '../../components/badges';
import { CreateTask } from '../../components/dialogs/create-task-dialog';
import { DiscoveryInboxView } from '../discovery';
import { useNavigation } from '../../features/navigation/hooks';
import { NavigationView } from '../../features/navigation/view';
import { FollowUpArchiveDialog } from '../../components/dialogs/follow-up-archive-dialog';
import { activityKindLabel, agentDecisionKinds, attachmentPreviewKind, formatFileSize, formatRunBadge, formatRunTelemetry, memorySourceLabel, providerConflictFieldLabel, selectBalancedVisibleAgent, sourceLinkLabel, sourceReferenceTitle, sourceReferenceType, taskDetailSaveFeedback } from '../../lib/formatters';
import { clearSentConversationDraft, readConversationDrafts, readConversationModelProfiles, readLastOpenedItem, readTaskModelProfiles, writeConversationDraft, writeConversationModelProfiles, writeLastOpenedItem, writeTaskModelProfile } from '../../lib/preferences';
import { QueueExplanationList } from '../../components/queue-explanations';
import { ProjectColorDot } from '../../components/project/project-color';
import { InlineProjectEditor } from '../../components/project/project-field';
import { isWorkbenchProject, WORKBENCH_PROJECT_NAME } from '../../../shared/project-name';
import { SourcesDialog } from '../source';
import { createTaskStackViewModel } from '../../lib/stack-view-model';
import { useRealtimeNotifications, type RealtimeNotification } from '../../hooks/realtime';
import { useTaskDetail } from './hooks';
import { useTaskAccountProfile, useTaskExecutionProfile } from './state';
import { celebrate } from '../../components/celebrate';
import { SessionFeedbackPrompt } from '../../components/dialogs/session-feedback-prompt';
import { WorkspaceDiffView } from '../workspace-diff/view';
import type { AgentAccountProfile } from '../../data/runtime-client';

/**
 * IDE LEGACY-AFFECTING: Workspace review is now a closed disclosure. The
 * existing task detail still loads the same review data, but task selection no
 * longer moves the page into a large patch automatically.
 */
export function TaskDetail({ id, onClose, onOpenConversation, onOpenTask, onCreated, onRemoving }: { id: string; onClose: () => void; onOpenConversation: (conversationId: string) => void; onOpenTask: (taskId: string) => void; onCreated: (item: WorkItem) => void; onRemoving?: (id: string) => Promise<void> }) {
  const queryClient = useQueryClient();
  const detail = useTaskDetail(id);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [deleteTaskPromptOpen, setDeleteTaskPromptOpen] = useState(false);
  const [feedbackTarget, setFeedbackTarget] = useState<{ conversationId?: string | null; workItemId: string } | null>(null);
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
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [expandedAttachments, setExpandedAttachments] = useState<Set<string>>(new Set());
  const [artifactLinkQuery, setArtifactLinkQuery] = useState('');
  const [dependencyQuery, setDependencyQuery] = useState('');
  const normalizedDependencyQuery = useDebouncedValue(dependencyQuery.trim(), 300);
  const normalizedTaskLinkQuery = useDebouncedValue(taskLinkQuery.trim(), 300);
  const normalizedArtifactLinkQuery = artifactLinkQuery.trim();
  const [selectedExecutionTaskIndexes, setSelectedExecutionTaskIndexes] = useState<Set<number>>(new Set());
  const [executionPlanArchivePromptOpen, setExecutionPlanArchivePromptOpen] = useState(false);
  const { executionProfile, setExecutionProfile } = useTaskExecutionProfile(id);
  const { accountProfile, setAccountProfile } = useTaskAccountProfile(id, detail.data?.item);
  const [newAccountProfile, setNewAccountProfile] = useState('');
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const ACTIVITY_PAGE_SIZE = 20;
  const [activityVisibleCount, setActivityVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const RUNS_PAGE_SIZE = 5;
  const [runsVisibleCount, setRunsVisibleCount] = useState(RUNS_PAGE_SIZE);
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
  const addAttachments = useMutation({
    mutationFn: async (files: File[]) => api.addWorkItemAttachments(id, await Promise.all(files.map(async (file) => ({
      name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
      dataBase64: await new Promise<string>((resolveValue, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolveValue(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file); }),
    })))),
    onSuccess: async () => { toast.success('Task files attached.'); await queryClient.invalidateQueries({ queryKey: ['work-item', id] }); },
    onError: (error) => toastError('Could not attach task files.', error),
  });
  const removeAttachment = useMutation({
    mutationFn: (path: string) => api.removeWorkItemAttachment(id, path),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['work-item', id] }); },
    onError: (error) => toastError('Could not remove the task file.', error),
  });
  const resolveProviderConflict = useMutation({
    mutationFn: ({ field, resolution }: { field: ProviderSyncConflict['field']; resolution: 'keep_local' | 'use_provider' }) => api.resolveProviderConflict(id, field, resolution),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
      ]);
    },
    onError: (error, input) => toastError(`Could not resolve the ${providerConflictFieldLabel(input.field)} conflict with Linear.`, error),
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
    mutationFn: () => api.executeWorkItem(id, executionProfile, accountProfile),
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
  const agentAccounts = useQuery({ queryKey: ['agent-accounts'], queryFn: api.listAgentAccounts, refetchInterval: 5_000 });
  const startAccountLogin = useMutation({
    mutationFn: ({ provider, name }: { provider: 'codex' | 'claude'; name: string }) => api.startAgentAccountLogin(provider, name),
    onSuccess: ({ accounts }) => {
      queryClient.setQueryData(['agent-accounts'], { accounts });
      toast.success('Login opened in Terminal. Complete the provider browser flow; Workbench will refresh the status automatically.');
    },
    onError: (error) => toastError('Could not open the provider login.', error),
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
    onError: (error) => toastError('Could not resolve the plan.', error),
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
      if (action === 'complete') {
        celebrate();
        // Keep the detail mounted until the required verdict persists.
        setFeedbackTarget({ conversationId: detail.data?.conversations.at(0)?.id ?? null, workItemId: id });
      } else onClose();
      const undoable = action === 'archive' || action === 'complete';
      toast.success(lifecycleSuccessMessage[action], undoable ? { action: () => lifecycle.mutate('restore'), actionLabel: 'Undo', duration: 10_000 } : undefined);
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
    onError: (error) => toastError('Could not create the follow-up task.', error),
  });
  const addReference = useMutation({
    mutationFn: () => api.addWorkItemReference(id, { type: referenceType, url: referenceUrl.trim(), title: referenceTitle.trim() }),
    onSuccess: async () => {
      setReferenceUrl(''); setReferenceTitle(''); setReferenceType('other'); setShowAddReference(false);
      await queryClient.invalidateQueries({ queryKey: ['work-item', id] });
    },
    onError: (error) => toastError('Could not add the reference.', error),
  });
  const removeReference = useMutation({
    mutationFn: (referenceId: string) => api.removeWorkItemReference(id, referenceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
    onError: (error) => toastError('Could not remove the reference.', error),
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
    onError: (error) => toastError('Could not link that task.', error),
  });
  const removeTaskLink = useMutation({
    mutationFn: (linkedWorkItemId: string) => api.removeTaskLink(id, linkedWorkItemId),
    onSuccess: async (_data, linkedWorkItemId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-item', id] }),
        queryClient.invalidateQueries({ queryKey: ['work-item', linkedWorkItemId] }),
      ]);
    },
    onError: (error) => toastError('Could not unlink that task.', error),
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
    onError: (error) => toastError('Could not attach that artifact.', error),
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

  if (detail.isLoading) return <TaskDetailSkeleton />;
  if (!detail.data) return <div className="detail-empty">Unable to load this item.</div>;
  const { item, activity } = detail.data;
  const taskAttachments = item.attachments ?? [];
  const decisionCount = activity.filter((entry) => agentDecisionKinds.has(entry.kind)).length;
  const dependencies = item.blockedBy ?? [];
  const openDependencies = dependencies.filter((dependency) => dependency.isOpen);
  const providerConflicts = detail.data.providerConflicts ?? [];
  const hasBeenExecuted = detail.data.runs.length > 0;
  // A dispatch becomes active before the runner claims it. Keep task mutations
  // locked from the optimistic request through its queued/running lifecycle.
  const isExecutionActive = execute.isPending || item.status === 'in_progress' || detail.data.runs.some((run) => run.status === 'queued' || run.status === 'running');
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

  function toggleAttachmentPreview(path: string) {
    setExpandedAttachments((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  return (
    <section className={`detail-panel ${isExecutionActive ? 'execution-starting' : ''}`} aria-busy={isExecutionActive}>
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
        <span><strong>Execution blocked</strong><small>Complete {openDependencies.length === 1 ? 'this prerequisite' : 'these prerequisites'} before dispatching an agent: {openDependencies.map((dependency, index) => <Fragment key={dependency.id}>{index > 0 && ', '}<button type="button" className="dependency-blocker-link" onClick={() => onOpenTask(dependency.id)}>{dependency.title}</button></Fragment>)}.</small></span>
      </div>}
      <fieldset className="task-execution-controls" disabled={isExecutionActive} aria-label={isExecutionActive ? 'Task actions are disabled while execution is in progress' : undefined}>
      {providerConflicts.length > 0 && <section className="provider-conflicts" aria-label="Linear sync conflicts">
        <div><strong>Linear changes need a decision</strong><small>{providerConflicts.length} field{providerConflicts.length === 1 ? '' : 's'} kept local after Linear changed too.</small></div>
        {providerConflicts.map((conflict) => {
          const resolvingThisField = resolveProviderConflict.isPending && resolveProviderConflict.variables?.field === conflict.field;
          return <div className="provider-conflict" key={conflict.field}>
            <strong>{providerConflictFieldLabel(conflict.field)}</strong>
            <span><small>Local</small>{Array.isArray(conflict.localValue) ? conflict.localValue.join(', ') || 'None' : conflict.localValue || 'None'}</span>
            <span><small>Linear</small>{Array.isArray(conflict.providerValue) ? conflict.providerValue.join(', ') || 'None' : conflict.providerValue || 'None'}</span>
            <div className="provider-conflict-actions">
              <button className="button secondary compact" disabled={resolvingThisField} onClick={() => resolveProviderConflict.mutate({ field: conflict.field, resolution: 'keep_local' })}>{resolvingThisField ? <LoaderCircle className="spin" size={13} /> : null} Keep local</button>
              <button className="button compact" disabled={resolvingThisField} onClick={() => resolveProviderConflict.mutate({ field: conflict.field, resolution: 'use_provider' })}>{resolvingThisField ? <LoaderCircle className="spin" size={13} /> : null} Use Linear</button>
            </div>
          </div>;
        })}
      </section>}
      <div className="task-lifecycle-actions">
        <button type="button" className="icon-button" onClick={() => setShowFollowUp((value) => !value)} aria-label="Create follow-up task" title="Create follow-up task"><Plus size={14} /></button>
        <button type="button" className={`icon-button${item.status === 'pinned' ? ' icon-button-active' : ''}`} onClick={() => togglePin.mutate()} disabled={togglePin.isPending} aria-pressed={item.status === 'pinned'} aria-label={item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'} title={item.status === 'pinned' ? 'Bring back' : 'Put a pin in it'}><Pin size={14} fill={item.status === 'pinned' ? 'currentColor' : 'none'} /></button>
        {item.archivedAt ? <><span className={`archive-state ${item.completionStatus}`}>{item.completionStatus === 'completed' ? 'Completed & archived' : 'Archived incomplete'}</span><button type="button" className="icon-button" onClick={() => lifecycle.mutate('restore')} disabled={lifecycle.isPending} aria-label="Restore task" title="Restore task"><Archive size={14} /></button></> : <>
          <button type="button" className="icon-button" onClick={() => lifecycle.mutate('archive')} disabled={lifecycle.isPending} aria-label="Archive task" title="Archive task"><Archive size={14} /></button>
          <button type="button" className="icon-button primary" onClick={() => lifecycle.mutate('complete')} disabled={lifecycle.isPending} aria-label="Complete task" title="Complete task"><Check size={14} /></button>
        </>}
        <button type="button" className="icon-button danger" onClick={() => setDeleteTaskPromptOpen(true)} aria-label="Delete task" title="Delete task"><Trash2 size={14} /></button>
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
      <div className="detail-section task-attachments">
        <span className="section-label">Files for the agent</span>
        {taskAttachments.length > 0 ? <><div className="message-files">{taskAttachments.map((file) => {
          const previewable = attachmentPreviewKind(file.mimeType) !== 'none';
          const expanded = expandedAttachments.has(file.path);
          return <span key={file.path}>
            {previewable && <button type="button" className="icon-button" aria-expanded={expanded} aria-label={expanded ? `Hide preview of ${file.name}` : `Preview ${file.name}`} title={expanded ? 'Hide preview' : 'Preview'} onClick={() => toggleAttachmentPreview(file.path)}>{expanded ? <EyeOff size={11} /> : <Eye size={11} />}</button>}
            <a href={`/api/work-items/${item.id}/attachments/${encodeURIComponent(file.path)}`} target="_blank" rel="noreferrer" title={`${file.mimeType} · ${formatFileSize(file.size)}`}><Paperclip size={11} /> {file.name} <span className="message-file-meta">{formatFileSize(file.size)}</span></a>
            {!hasBeenExecuted && <button type="button" className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => removeAttachment.mutate(file.path)} disabled={removeAttachment.isPending}><X size={12} /></button>}
          </span>;
        })}</div>
        {taskAttachments.filter((file) => expandedAttachments.has(file.path)).map((file) => <div className="attachment-preview-pane" key={file.path}><AttachmentPreview url={`/api/work-items/${item.id}/attachments/${encodeURIComponent(file.path)}`} file={file} /></div>)}
        </> : <p className="muted">No files attached.</p>}
        {!hasBeenExecuted && <><input ref={attachmentInputRef} className="visually-hidden" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) addAttachments.mutate(files); event.currentTarget.value = ''; }} /><button type="button" className="button secondary compact" onClick={() => attachmentInputRef.current?.click()} disabled={addAttachments.isPending || taskAttachments.length >= 10}><Paperclip size={13} /> {addAttachments.isPending ? 'Attaching…' : 'Attach files'}</button></>}
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
          if (dependencyCandidates.isLoading) return <CandidateRowSkeleton />;
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
        {openDependencies.length > 0 && <div className="task-execution-locked blocked"><AlertTriangle size={13} /><span><strong>Blocked by {openDependencies.length} prerequisite{openDependencies.length === 1 ? '' : 's'}</strong><small>{openDependencies.map((dependency, index) => <Fragment key={dependency.id}>{index > 0 && ', '}<button type="button" className="dependency-blocker-link" onClick={() => onOpenTask(dependency.id)}>{dependency.title}</button></Fragment>)}</small></span></div>}
        <p className="execution-copy">Workbench will classify the task, choose the right agent, and either execute it directly or return an approval-ready decomposition for complex work.</p>
        {execute.error && <p className="error-message">{execute.error.message}</p>}
        <div className="execution-controls">
          <ModelProfileSelect className="execution-control" value={executionProfile} onChange={setExecutionProfile} />
          <select className="execution-control" value={accountProfile} onChange={(event) => setAccountProfile(event.target.value)} aria-label="Account profile">
            {(agentAccounts.data?.accounts ?? [{ name: 'default' } as AgentAccountProfile]).map((account) => <option key={account.name} value={account.name}>{account.name === 'default' ? 'Default profile' : account.name}</option>)}
          </select>
          <button className="button secondary compact edit-profile-button" type="button" onClick={() => setProfileEditorOpen((open) => !open)} aria-label={profileEditorOpen ? 'Close profile editor' : 'Edit profile'} title={profileEditorOpen ? 'Close profile editor' : 'Edit profile'} aria-expanded={profileEditorOpen} aria-controls="agent-profile-editor"><Settings size={15} /></button>
          <button className="icon-button primary execute-button" onClick={() => execute.mutate()} disabled={hasBeenExecuted || selfAssigned || openDependencies.length > 0 || execute.isPending}
            aria-label={hasBeenExecuted ? 'Already executed' : selfAssigned ? 'Assigned to you' : openDependencies.length > 0 ? 'Blocked by prerequisites' : execute.isPending ? 'Executing task' : 'Execute task'}
            title={hasBeenExecuted ? 'This task has already been executed.' : selfAssigned ? SELF_ASSIGNED_EXECUTION_MESSAGE : openDependencies.length > 0 ? 'Complete this task\u2019s prerequisites before dispatching an agent.' : execute.isPending ? 'Executing task' : 'Execute task'}>
            {execute.isPending ? <LoaderCircle className="spin" size={16} /> : selfAssigned ? <User size={16} /> : openDependencies.length > 0 ? <AlertTriangle size={16} /> : <Sparkles size={16} />}
          </button>
        </div>
        {profileEditorOpen && <div id="agent-profile-editor" className="agent-account-manager agent-profile-editor">
          {(agentAccounts.data?.accounts ?? []).map((account) => <div className="agent-account-profile" key={account.name}>
            <div className="agent-account-profile-heading"><strong>{account.name === 'default' ? 'Default account' : account.name}</strong>{account.name === accountProfile && <small>Selected</small>}</div>
            {(['codex', 'claude'] as const).map((provider) => {
              const status = account.providers[provider];
              const connected = status.configured && status.loggedIn;
              const label = connected ? status.email ?? (provider === 'codex' ? 'ChatGPT account' : 'Connected') : status.configured ? 'Sign in required' : 'Not configured';
              return <div className={`agent-account-status ${connected ? 'connected' : ''}`} key={provider}>
                <span className="account-provider-mark" aria-hidden="true">{provider === 'codex' ? 'C' : 'A'}</span>
                <span><b>{provider === 'codex' ? 'Codex' : 'Claude'}</b><small>{label}</small></span>
                <span className={`account-state ${connected ? 'connected' : ''}`}>{connected ? 'Connected' : 'Needs login'}</span>
                <button className="button secondary compact" disabled={startAccountLogin.isPending}
                  onClick={() => startAccountLogin.mutate({ provider, name: account.name })}
                  aria-label={connected ? `Switch ${provider} account` : `Sign in to ${provider}`}
                  title={connected ? `Connected${status.email ? ` as ${status.email}` : ''}. Sign in again to switch.` : `Sign in to ${provider}`}>
                  <ArrowUpRight size={13} />
                </button>
              </div>;
            })}
          </div>)}
          <details className="agent-account-add">
            <summary>Add a separate account</summary>
            <div><input value={newAccountProfile} onChange={(event) => setNewAccountProfile(event.target.value)} placeholder="Profile name, e.g. personal" aria-label="New account profile" />
              <button className="button secondary compact" aria-label="Add account with Codex" title="Add account with Codex" disabled={!newAccountProfile.trim() || startAccountLogin.isPending} onClick={() => startAccountLogin.mutate({ provider: 'codex', name: newAccountProfile.trim() })}><span aria-hidden="true">C</span></button>
              <button className="button secondary compact" aria-label="Add account with Claude" title="Add account with Claude" disabled={!newAccountProfile.trim() || startAccountLogin.isPending} onClick={() => startAccountLogin.mutate({ provider: 'claude', name: newAccountProfile.trim() })}><span aria-hidden="true">A</span></button></div>
          </details>
        </div>
        }
      </div>
      </details>

      </fieldset>
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
              {run.instructions && <p className="run-prompt" title={run.instructions}>{run.instructions}</p>}
              {run.status === 'running' && !run.conversationId && <div className="live-output-label"><span /> Live activity & reasoning summaries</div>}
              {run.output && run.status !== 'completed' && !run.conversationId && <LiveRunOutput output={run.output} />}
              {run.model && <span className="model-badge" title={formatRunTelemetry(run)}>Requested {run.requestedAgent[0].toUpperCase() + run.requestedAgent.slice(1)} · Actual {run.agent[0].toUpperCase() + run.agent.slice(1)}{run.fallbackFrom ? ' (fallback)' : ''} · {run.accountProfile} · {run.model} · {formatRunBadge(run)}</span>}
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

      <fieldset className="task-execution-controls" disabled={isExecutionActive} aria-label={isExecutionActive ? 'Task actions are disabled while execution is in progress' : undefined}>
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
      {feedbackTarget && <SessionFeedbackPrompt onSubmit={async (rating: SessionFeedbackRating) => { await api.createSessionFeedback({ ...feedbackTarget, rating }); setFeedbackTarget(null); onClose(); }} />}

      <details className="detail-section task-collapsible workspace-review-section">
        <summary><span>Workspace review</span><small>Latest changes and recorded snapshots</small></summary>
        <div className="task-collapsible-content">
          <WorkspaceDiffView scope={{ workItemId: item.id }} activeWorkspacePaths={detail.data.runs.filter((run) => run.status === 'queued' || run.status === 'running').flatMap((run) => run.resolvedWorkspace ? [run.resolvedWorkspace] : [])} reviewHandoff={detail.data.runs.find((run) => run.reviewHandoff)?.reviewHandoff ?? null} taskIntent={{ title: item.title, description: item.description }} pullRequestUrlCandidates={references.map((reference) => reference.url)} />
        </div>
      </details>
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
          {removeTaskLink.error && <p className="error-message">Could not remove linked task: {removeTaskLink.error.message}</p>}
          {showAddTaskLink ? (
            <div className="reference-form">
              <input autoFocus value={taskLinkQuery} onChange={(event) => setTaskLinkQuery(event.target.value)} placeholder="Search tasks to link" aria-label="Search tasks to link" />
              {addTaskLink.error && <p className="error-message">Could not link task: {addTaskLink.error.message}</p>}
              {normalizedTaskLinkQuery && (taskLinkCandidateQuery.isLoading ? <CandidateRowSkeleton /> : taskLinkCandidates.length ? <ul className="dependency-candidates">{taskLinkCandidates.slice(0, 8).map((candidate) => <li key={candidate.id}><button type="button" disabled={addTaskLink.isPending} onClick={() => addTaskLink.mutate(candidate.id)}><Plus size={12} /><span>{candidate.title}</span><small>{candidate.projectName ?? 'Personal'}</small></button></li>)}</ul> : <p className="muted">No other tasks match.</p>)}
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
              {artifactLinkCandidateQuery.isLoading ? <CandidateRowSkeleton /> : normalizedArtifactLinkQuery && (artifactLinkCandidates.length ? <ul className="dependency-candidates">{artifactLinkCandidates.slice(0, 8).map((artifact) => <li key={artifact.id}><button type="button" disabled={addArtifactLink.isPending} onClick={() => addArtifactLink.mutate(artifact.id)}><FileText size={12} /><span>{artifact.title}</span><small>v{artifact.version}</small></button></li>)}</ul> : <p className="muted">No unlinked artifacts match.</p>)}
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
          {removeReference.error && <p className="error-message">Could not remove reference: {removeReference.error.message}</p>}
          {showAddReference ? (
            <form className="reference-form" onSubmit={(event) => { event.preventDefault(); if (referenceUrl.trim()) addReference.mutate(); }}>
              <label className="visually-hidden" htmlFor="reference-type">Reference type</label>
              <select id="reference-type" value={referenceType} onChange={(event) => setReferenceType(event.target.value as WorkItemReferenceType)}>
                <option value="linear_issue">Linear issue</option>
                <option value="pull_request">Pull request</option>
                <option value="slack_thread">Slack thread</option>
                <option value="document">Document</option>
                <option value="other">Other</option>
              </select>
              <label className="visually-hidden" htmlFor="reference-url">URL</label>
              <input id="reference-url" autoFocus value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="https://…" type="url" />
              <label className="visually-hidden" htmlFor="reference-title">Title (optional)</label>
              <input id="reference-title" value={referenceTitle} onChange={(event) => setReferenceTitle(event.target.value)} placeholder="Title (optional)" />
              {addReference.error && <p className="error-message">Could not add reference: {addReference.error.message}</p>}
              <div><button type="button" className="button secondary compact" onClick={() => setShowAddReference(false)}>Cancel</button><button className="button primary compact" disabled={!referenceUrl.trim() || addReference.isPending}>{addReference.isPending ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} Link</button></div>
            </form>
          ) : (
            <button type="button" className="button secondary compact" onClick={() => setShowAddReference(true)}><Link2 size={13} /> Link Linear, PR, Slack, or a document</button>
          )}
        </div>
        </div>
      </details>

      </fieldset>
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
