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
import { KeyboardHelpDialog, SettingsDialog } from '../settings';
import { createTaskStackViewModel } from '../../lib/stack-view-model';
import { useRealtimeNotifications, type RealtimeNotification } from '../../hooks/realtime';
import { useAttentionIndicator } from '../../hooks/attention-indicator';
import { useTaskStackReorderAnimation } from '../queue/use-task-stack-reorder-animation';
import { reorderTaskPages, reorderTasks, type TaskReorderTarget } from '../queue/task-reorder';

import { SharedWorkspace } from '../conversation/view';
import { TaskDetail } from '../task/view';
import { X6Demo } from '../x6-demo';

type QueueReorderRequest = TaskReorderTarget & { stack: 'attention' | 'workbench' };
type QueueReorderMutation = {
  request: QueueReorderRequest;
  queryKey: readonly ['work-items', string, string];
  previous: InfiniteData<WorkItemPage> | undefined;
};

const PINNED_REMINDER_INTERVAL_MS = 30 * 60_000;

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

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

  // X6 Demo route: /x6-demo
  if ((route as any).name === 'x6-demo') {
    return <X6Demo />;
  }

  // ...rest of the existing App component code...
  // (No changes to the rest of the file)
}
