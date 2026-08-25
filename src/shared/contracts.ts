import { z } from 'zod';
import { projectKey } from './project-name.js';

export const workItemStatusSchema = z.enum([
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'pinned',
  'done',
  'canceled',
]);

/** States a user can set while work is active. Completion is a lifecycle action. */
export const activeWorkItemStatusSchema = z.enum(['backlog', 'ready', 'in_progress', 'blocked', 'pinned']);
export const runKindSchema = z.enum(['research', 'analysis', 'strategy', 'execute', 'review', 'bugfix']);

/** A real calendar date, intentionally independent of an instant or timezone. */
export const calendarDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, 'Use a real calendar date.');

export const assigneeSchema = z.enum(['jeffrey', 'codex', 'claude']);
export const sourceSchema = z.enum(['manual', 'linear']);

/**
 * Assigning Jeffrey to a task is exclusive: it means he is doing the work himself.
 * While he owns a task no agent can be assigned alongside him and no agent run can
 * be dispatched against it, so agents never spend a run on work he has claimed.
 */
export const isAgentAssignee = (assignee: Assignee): assignee is AgentAssignee => assignee !== 'jeffrey';
export const isSelfAssigned = (assignees: readonly Assignee[]): boolean => assignees.includes('jeffrey');
export const SELF_ASSIGNED_OWNER_MESSAGE = 'Jeffrey owns this task. Unassign him before assigning Codex or Claude.';
export const SELF_ASSIGNED_EXECUTION_MESSAGE = 'Jeffrey owns this task, so an agent cannot execute it. Unassign him first.';

/**
 * Work items are written concurrently by the browser, MCP tools, and the
 * scheduler/agent-runner. A caller that read a stale `version` and passes it
 * back as `expectedVersion` gets this conflict instead of silently
 * clobbering a concurrent write.
 */
export const VERSION_CONFLICT_CODE = 'VERSION_CONFLICT';
export const VERSION_CONFLICT_MESSAGE = 'This task changed since it was last read. Reload it and try again.';

/**
 * Assignment lists carry the exclusivity rule. Filter inputs deliberately keep the
 * plain array schema: filtering for "mine and Codex's" is a legitimate query.
 */
export const assigneeSelectionSchema = z.array(assigneeSchema).max(3)
  .refine((assignees) => !(isSelfAssigned(assignees) && assignees.some(isAgentAssignee)), SELF_ASSIGNED_OWNER_MESSAGE);

export interface WorkItemLineage {
  parentTitle: string | null;
  followUpCount: number;
  openFollowUpCount: number;
}

/** Legacy persistence field retained while older runtimes drain. New work uses attention. */
export const workItemStackSchema = z.enum(['attention', 'workbench']);
export type WorkItemStack = z.infer<typeof workItemStackSchema>;

export const workItemDependencySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: workItemStatusSchema,
  archivedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  isOpen: z.boolean(),
});
export type WorkItemDependency = z.infer<typeof workItemDependencySchema>;

/**
 * How a human closed out an agent result. `left_open` is a real decision: it
 * clears the task from the review inbox without changing its status, for work
 * that is still in flight but no longer needs a look.
 */
export const workItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: workItemStatusSchema,
  priority: z.number().int().min(0).max(4),
  queuePosition: z.number(),
  source: sourceSchema,
  isQueued: z.boolean(),
  archivedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  parentWorkItemId: z.string().nullable(),
  completionStatus: z.enum(['incomplete', 'completed']),
  agentOutcome: z.enum(['finished', 'follow_ups', 'needs_attention', 'promoting', 'waiting_promotion']).nullable(),
  classificationKind: z.string().nullable().optional(),
  classificationComplex: z.boolean().optional(),
  sourceIdentifier: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceTags: z.array(z.string()),
  /** Discovery created this item; Jeffrey must promote it before execution. */
  machineProposed: z.boolean().optional(),
  machineProposalRunId: z.string().nullable().optional(),
  machineProposalWindowStart: z.string().nullable().optional(),
  suggestedPriority: z.number().int().min(0).max(4).nullable().optional(),
  suggestedQueuePosition: z.number().int().positive().nullable().optional(),
  proposalRationale: z.string().nullable().optional(),
  projectName: z.string().nullable(),
  stack: workItemStackSchema,
  workspacePath: z.string().nullable(),
  /** Files Jeffrey attached as durable context before task execution. */
  attachments: z.array(z.object({ name: z.string(), path: z.string(), mimeType: z.string(), size: z.number().int().nonnegative() })).optional(),
  strategy: z.string(),
  assignees: z.array(assigneeSchema),
  labels: z.array(z.string()),
  dueDate: z.string().nullable(),
  providerUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastTouchedAt: z.string(),
  // Optional while older promoted runtimes can still return the pre-dependency
  // contract. New repository reads always populate it.
  blockedBy: z.array(workItemDependencySchema).optional(),
  // Optional for the same reason: an older promoted runtime's response, and
  // any fixture written before optimistic concurrency existed, omits it. New
  // repository reads always populate it.
  version: z.number().int().optional(),
  lineage: z.object({
    parentTitle: z.string().nullable(),
    followUpCount: z.number().int().nonnegative(),
    openFollowUpCount: z.number().int().nonnegative(),
  }).optional(),
});

export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;
export type Assignee = z.infer<typeof assigneeSchema>;
export type AgentAssignee = Exclude<Assignee, 'jeffrey'>;

export const DEFAULT_ACCOUNT_PROFILE = 'default';
export const PERSONAL_ACCOUNT_PROFILE = 'personal';

/**
 * Workbench and Pluto are Jeffrey's personal projects. Every other project
 * keeps the normal provider CLI account unless a profile is selected.
 */
export function defaultAccountProfileForTask(task: Pick<WorkItem, 'projectName' | 'workspacePath'>): string {
  const project = projectKey(task.projectName);
  if (project === 'workbench' || project === 'pluto' || project === 'plutoalpha') return PERSONAL_ACCOUNT_PROFILE;
  const workspace = task.workspacePath?.replace(/\\/g, '/').toLowerCase() ?? '';
  return /\/(?:workbench|pluto-alpha)(?:\/|$)/.test(workspace) ? PERSONAL_ACCOUNT_PROFILE : DEFAULT_ACCOUNT_PROFILE;
}

export const providerSyncFieldSchema = z.enum(['title', 'description', 'status', 'projectName', 'labels', 'dueDate']);
export type ProviderSyncField = z.infer<typeof providerSyncFieldSchema>;
export interface ProviderSyncConflict {
  field: ProviderSyncField;
  localValue: string | string[] | null;
  providerValue: string | string[] | null;
  providerBaseline: string | string[] | null;
  conflictedAt: string;
}

export const providerSyncConflictResolutionSchema = z.object({
  resolution: z.enum(['keep_local', 'use_provider']),
}).strict();
export type ProviderSyncConflictResolution = z.infer<typeof providerSyncConflictResolutionSchema>['resolution'];

export const workItemFilterSchema = z.object({
  projectNames: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  statuses: z.array(workItemStatusSchema).max(20).default([]),
  assignees: z.array(assigneeSchema).max(3).default([]),
  sources: z.array(sourceSchema).max(2).default([]),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  dueStates: z.array(z.enum(['overdue', 'due_today', 'due_later', 'unscheduled'])).max(4).default([]),
  query: z.string().trim().max(2_000).default(''),
}).strict();
export type WorkItemFilter = z.infer<typeof workItemFilterSchema>;

/**
 * One entry in the canonical project vocabulary. `key` is the comparison
 * identity from `project-name.ts`; `name` is the spelling every task carries.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  key: string;
  taskCount: number;
  lastUsedAt: string | null;
}

export const savedWorkItemFilterViewSchema = z.enum(['active', 'workbench', 'archive']);
export type SavedWorkItemFilterView = z.infer<typeof savedWorkItemFilterViewSchema>;
export const savedWorkItemFilterSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  view: savedWorkItemFilterViewSchema,
  filter: workItemFilterSchema,
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedWorkItemFilter = z.infer<typeof savedWorkItemFilterSchema>;
export const createSavedWorkItemFilterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  view: savedWorkItemFilterViewSchema,
  filter: workItemFilterSchema,
}).strict();
export const updateSavedWorkItemFilterSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  filter: workItemFilterSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Provide at least one field.');

const bulkWorkItemIdsSchema = z.array(z.string().uuid()).min(1).max(200);
export const bulkWorkItemActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_status'), ids: bulkWorkItemIdsSchema, status: activeWorkItemStatusSchema }).strict(),
  z.object({ action: z.literal('archive'), ids: bulkWorkItemIdsSchema }).strict(),
  z.object({ action: z.literal('restore'), ids: bulkWorkItemIdsSchema }).strict(),
  z.object({ action: z.literal('set_assignees'), ids: bulkWorkItemIdsSchema, assignees: assigneeSelectionSchema }).strict(),
  z.object({ action: z.literal('set_project'), ids: bulkWorkItemIdsSchema, projectName: z.string().trim().min(1).max(200).nullable() }).strict(),
  z.object({ action: z.literal('set_stack'), ids: bulkWorkItemIdsSchema, stack: workItemStackSchema }).strict(),
]);
export type BulkWorkItemAction = z.infer<typeof bulkWorkItemActionSchema>;
export type BulkWorkItemConflict = { id: string; reason: 'not_found' | 'active_run' | 'provider_owned' | 'invalid_state' };
export interface BulkWorkItemResult { appliedIds: string[]; conflicts: BulkWorkItemConflict[]; }

export interface WorkItemPage {
  items: WorkItem[];
  nextCursor: string | null;
  totalCount: number;
  proposal: QueueProposal | null;
}

export interface ConversationPage {
  conversations: SharedConversation[];
  nextCursor: string | null;
  totalCount: number;
}

export interface SharedMessagePage {
  messages: SharedMessage[];
  nextCursor: string | null;
  totalCount: number;
}

export interface SharedSearchResult {
  type: 'conversation' | 'message';
  conversationId: string;
  conversationTitle: string;
  messageId: string | null;
  snippet: string;
  rank: number;
}

export interface SharedSearchResponse {
  results: SharedSearchResult[];
}

export interface MemorySearchResult {
  source: string;
  sourceId: string;
  title: string;
  snippet: string;
  createdAt: string;
  conversationId: string | null;
  workItemId: string | null;
  actor: string | null;
  score: number;
}

export interface MemorySearchResponse {
  results: MemorySearchResult[];
}

export const createWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).default(''),
  priority: z.number().int().min(0).max(4).default(2),
  status: activeWorkItemStatusSchema.default('backlog'),
  projectName: z.string().trim().max(200).nullable().default(null),
  // Compatibility-only. New work always enters the one attention queue.
  stack: workItemStackSchema.optional(),
  workspacePath: z.string().trim().max(1_000).nullable().default(null),
  dueDate: calendarDateSchema.nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
  classificationKind: runKindSchema.optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().max(200).default('application/octet-stream'),
    size: z.number().int().min(0).max(10_000_000),
    dataBase64: z.string().max(14_000_000),
  })).max(10).default([]),
});

export const generateTaskDraftSchema = z.object({ prompt: z.string().trim().min(3).max(50_000) });
export interface GeneratedTaskDraft { title: string; description: string; projectName: string | null; workspacePath: string | null; }

export const resolveSourceUrlSchema = z.object({ url: z.string().url().max(4_000) });
export interface ResolvedSourceDraft { source: string; sourceUrl: string; title: string; description: string; }

export const sourceProviderSchema = z.enum(['github', 'slack', 'figma', 'confluence', 'gmail']);
export type SourceProvider = z.infer<typeof sourceProviderSchema>;
export type SourceAuthMode = 'oauth' | 'api_key' | 'managed_externally';
export type SourceConfigurationState = 'unconfigured' | 'authorizing' | 'connected' | 'reauth_required' | 'disabled';
export type SourceHealthState = 'unknown' | 'healthy' | 'degraded' | 'unavailable';
export interface SourceConnection { provider: SourceProvider; connected: boolean; label: string; lastScannedAt: string | null; lastError: string | null; authMode?: SourceAuthMode; configurationState?: SourceConfigurationState; health?: SourceHealthState; }
export type DiscoveryCandidateStatus = 'pending' | 'converted' | 'merged' | 'dismissed' | 'snoozed';
export interface DiscoveryCandidate {
  id: string;
  provider: string;
  title: string;
  description: string;
  sourceUrl: string | null;
  occurredAt: string | null;
  status: DiscoveryCandidateStatus;
  discoveredAt: string;
  updatedAt: string;
  snoozedUntil: string | null;
  workItemId: string | null;
  relevance: number;
  suggestedWorkItemId: string | null;
}
export interface DiscoveryRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  candidateCount: number;
  errors: string[];
}
export interface DiscoveryInbox {
  candidates: DiscoveryCandidate[];
  pendingCount: number;
  reviewedCount: number;
  lastRun: DiscoveryRun | null;
  running: boolean;
  queueProposal: QueueProposal | null;
}
export const updateDiscoveryCandidateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
});
export const resolveDiscoveryCandidateSchema = z.object({ workItemId: z.string().uuid().optional() });
export const bulkDiscoveryActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(['convert', 'dismiss', 'snooze']),
});
export type BrokerSourceId = 'slack' | 'figma' | 'linear' | 'atlassian' | 'github' | 'google';
export type BrokerConnectionState = 'connected' | 'needs_auth' | 'reauth_required' | 'disabled' | 'error';
export interface BrokerConnection {
  id: BrokerSourceId;
  name: string;
  state: BrokerConnectionState;
  host: 'workbench' | 'managed_connector';
  capabilities: Array<'resolve_links' | 'search' | 'sync'>;
  detail: string;
  configurable: boolean;
  lastError: string | null;
}
export const brokerSourceIdSchema = z.enum(['slack', 'figma', 'linear', 'atlassian', 'github', 'google']);
export const searchSourcesSchema = z.object({
  query: z.string().trim().min(2).max(2_000),
  sources: z.array(brokerSourceIdSchema).min(1).max(6),
});
export interface BrokerSearchResult {
  source: BrokerSourceId;
  title: string;
  summary: string;
  url: string | null;
  occurredAt: string | null;
}
export interface BrokerSearchResponse {
  results: BrokerSearchResult[];
  errors: Partial<Record<BrokerSourceId, string>>;
}
export const sourceConnectionInputSchema = z.object({
  provider: sourceProviderSchema,
  label: z.string().trim().max(200).default(''),
  settings: z.record(z.string(), z.string().max(10_000)),
});

// Figma's authenticated connector can open a known design URL, but cannot
// enumerate a workspace. These roots define the explicit design surface that
// Discovery is allowed to inspect.
export const figmaScopeSchema = z.object({
  roots: z.array(z.string().url().max(4_000).refine((value) => {
    try { return new URL(value).hostname.endsWith('figma.com'); }
    catch { return false; }
  }, 'Each scope must be a Figma URL.')).max(20),
});
export type FigmaScope = z.infer<typeof figmaScopeSchema>;

export const updateWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  status: activeWorkItemStatusSchema.optional(),
  projectName: z.string().trim().max(200).nullable().optional(),
  stack: workItemStackSchema.optional(),
  workspacePath: z.string().trim().max(1_000).nullable().optional(),
  dueDate: calendarDateSchema.nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  strategy: z.string().max(50_000).optional(),
  assignees: assigneeSelectionSchema.optional(),
  queuePosition: z.number().optional(),
  blockedByIds: z.array(z.string().uuid()).max(200).optional(),
  // When present, the update is only applied if the row's current `version`
  // still matches. Omitted, the write applies unconditionally (last write
  // wins), which keeps existing callers working unchanged.
  expectedVersion: z.number().int().optional(),
});
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;

export const unblockWorkItemSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
});
export type UnblockWorkItemInput = z.infer<typeof unblockWorkItemSchema>;

export const activitySchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  actor: z.enum(['jeffrey', 'codex', 'claude', 'system']),
  kind: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export type Activity = z.infer<typeof activitySchema>;

export const createActivitySchema = z.object({
  actor: z.enum(['jeffrey', 'codex', 'claude', 'system']),
  kind: z.enum(['note', 'progress', 'decision', 'blocker', 'handoff']),
  body: z.string().trim().min(1).max(50_000),
});

export const workItemReferenceTypeSchema = z.enum(['linear_issue', 'pull_request', 'slack_thread', 'document', 'other']);
export type WorkItemReferenceType = z.infer<typeof workItemReferenceTypeSchema>;

export interface WorkItemReference {
  id: string;
  workItemId: string;
  type: WorkItemReferenceType;
  url: string;
  title: string;
  createdAt: string;
}

export const createWorkItemReferenceSchema = z.object({
  type: workItemReferenceTypeSchema.default('other'),
  url: z.string().trim().url().max(2_000),
  title: z.string().trim().max(300).default(''),
});

export const createWorkItemLinkSchema = z.object({
  linkedWorkItemId: z.string().uuid(),
});

export interface WorkItemDetail {
  item: WorkItem;
  parentItem: WorkItem | null;
  children: WorkItem[];
  activity: Activity[];
  runs: AgentRun[];
  executionPlan: ExecutionPlan | null;
  classification: TaskClassification | null;
  conversations: SharedConversation[];
  artifacts: ArtifactSummary[];
  linkedTasks: WorkItem[];
  references: WorkItemReference[];
  blocks?: WorkItemDependency[];
  providerConflicts: ProviderSyncConflict[];
}

/**
 * One task waiting on a human verdict, paired with just enough of the agent's
 * result to decide without opening the task: the last finished run's summary,
 * and the size of any decomposition it is proposing.
 */

/**
 * A review verdict. `follow_up` needs the follow-up task's copy; `rerun` may
 * carry extra instructions telling the agent what the first attempt missed.
 */
export interface TaskClassification {
  kind: AgentRun['kind'];
  agent: AgentRun['agent'];
  complex: boolean;
  instructions: string;
  classifiedAt: string;
  source: 'automatic' | 'manual';
}

export const taskLifecycleActionSchema = z.enum(['archive', 'complete']);

export interface PlannedTask {
  title: string;
  description: string;
  workspacePath: string | null;
}

export interface ExecutionPlan {
  id: string;
  workItemId: string;
  status: 'pending' | 'accepted' | 'rejected';
  summary: string;
  tasks: PlannedTask[];
  createdAt: string;
  resolvedAt: string | null;
}

export const agentTargetSchema = z.enum(['auto', 'codex', 'claude', 'both']);
export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'canceled']);
export const executionProfileOverrideSchema = z.enum(['economy', 'standard', 'deep']).nullable().default(null);
export const accountProfileSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Account profile must use letters, numbers, spaces, hyphens, or underscores.');

export const createAgentRunSchema = z.object({
  kind: runKindSchema,
  target: agentTargetSchema,
  instructions: z.string().trim().max(20_000).default(''),
  executionProfile: executionProfileOverrideSchema,
  accountProfile: accountProfileSchema.optional(),
});

export interface AgentRun {
  id: string;
  workItemId: string;
  kind: z.infer<typeof runKindSchema>;
  requestedTarget: z.infer<typeof agentTargetSchema>;
  requestedAgent: 'codex' | 'claude';
  agent: 'codex' | 'claude';
  status: z.infer<typeof runStatusSchema>;
  instructions: string;
  output: string;
  error: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  conversationId: string | null;
  messageId: string | null;
  model: string | null;
  executionProfile: 'economy' | 'standard' | 'deep' | null;
  /** Named local credential profile selected at dispatch; credentials never enter Workbench data. */
  accountProfile: string;
  inputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  /** Whether the stored cost came from the provider or a token-rate estimate. */
  costSource: 'provider' | 'estimated' | null;
  fallbackFrom: 'codex' | 'claude' | null;
  fallbackReason: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** Directory this run resolved to and edits under. Recorded at dispatch so a run's filesystem target is durable, auditable, and lockable. */
  resolvedWorkspace: string | null;
  /** How this run was dispatched: a direct human action, or (once phase 3 ships) the autonomy governor. */
  origin: 'manual' | 'autonomous';
}

export interface LinearSyncResult {
  imported: number;
  updated: number;
  skipped: number;
  conflicts: number;
  syncedAt: string;
}

export interface LinearProject {
  id: string;
  name: string;
  state: string;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
  projects: LinearProject[];
}

export interface LinearProviderConfig {
  teamIds: string[];
  projectIds: string[];
}

export type QueueSignalKey =
  | 'status'
  | 'agent_outcome'
  | 'ownership'
  | 'aging'
  | 'deadline'
  | 'blocker'
  | 'source_change'
  | 'workload'
  | 'feedback';

/** One named reason a task scored where it did, with its point contribution. */
export interface QueueSignal {
  key: QueueSignalKey;
  delta: number;
  detail: string;
}

/** Per-task audit trail for a proposal: what it scored, why, and where it moved. */
export interface QueueItemExplanation {
  itemId: string;
  title: string;
  score: number;
  signals: QueueSignal[];
  previousPosition: number;
  proposedPosition: number;
}

export interface QueueProposal {
  id: string;
  stack: 'attention' | 'workbench';
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  previousOrder: string[];
  proposedOrder: string[];
  rationale: string;
  explanations: QueueItemExplanation[];
  createdAt: string;
  resolvedAt: string | null;
}

/** A reversible ordering change. Every reorder records one, whoever caused it. */
export interface QueueOrderChange {
  id: string;
  stack: 'attention' | 'workbench';
  reason: string;
  actor: 'jeffrey' | 'agent' | 'system';
  previousOrder: string[];
  newOrder: string[];
  createdAt: string;
  undoneAt: string | null;
}

export const createQueueProposalSchema = z.object({
  orderedItemIds: z.array(z.string()).min(1),
  rationale: z.string().trim().min(1).max(20_000),
});

export const reorderQueueSchema = z.object({
  itemId: z.string(),
  beforeId: z.string().optional(),
  afterId: z.string().optional(),
  // The Workbench project is a separately rendered slice of the canonical
  // queue, so a move must name the slice whose neighboring IDs it uses.
  stack: z.enum(['attention', 'workbench']).default('attention'),
}).refine((input) => Boolean(input.beforeId) !== Boolean(input.afterId), {
  message: 'Provide exactly one neighboring item.',
});

export const sharedMessageAuthorSchema = z.enum(['jeffrey', 'codex', 'claude', 'system']);
export const sharedMessageStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'canceled']);

export interface SharedMessage {
  id: string;
  conversationId: string;
  author: z.infer<typeof sharedMessageAuthorSchema>;
  body: string;
  pinned: boolean;
  status: z.infer<typeof sharedMessageStatusSchema>;
  error: string;
  createdAt: string;
  completedAt: string | null;
  attachments: SharedAttachment[];
  model: string | null;
  /** Credential profile selected for this provider invocation; never credentials.
   * Optional while an older promoted runtime can still return the pre-proof contract. */
  accountProfile?: string | null;
  executionProfile: 'routing' | 'economy' | 'standard' | 'deep' | null;
  /** Fresh, non-cached input tokens. */
  inputTokens: number | null;
  /** Provider prompt-cache creation/refresh tokens, when reported. */
  cacheCreationInputTokens: number | null;
  /** Provider prompt-cache read tokens, when reported. */
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  costSource?: 'provider' | 'estimated' | null;
  fallbackFrom: 'codex' | 'claude' | null;
  fallbackReason: string | null;
  dispatchTarget: 'auto' | 'both' | 'codex' | 'claude' | 'none';
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** Number of memory matches retrieved from RAG for this reply's prompt, or null if retrieval was not run (e.g. the human's own message). */
  retrievedMemoryCount: number | null;
}

export interface SharedAttachment { name: string; path: string; mimeType: string; size: number; }

/** The exact RAG query and matches behind a reply's retrievedMemoryCount, fetched on demand when the memory badge is clicked. */
export interface RetrievedMemoryDetail {
  query: string;
  items: Array<{ source: string; title: string; body: string; createdAt: string }>;
}
export interface PublishedArtifact { id: string; url: string; title: string; }

// --- Artifact library -------------------------------------------------------
//
// A published artifact is a stable identity (id + public URL) with an ordered
// list of versions. Republishing appends a version and moves the latest
// snapshot; revoking takes every version offline without losing the history.

export const artifactEventKindSchema = z.enum(['published', 'republished', 'revoked', 'restored', 'commented', 'linked']);
export type ArtifactEventKind = z.infer<typeof artifactEventKindSchema>;

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  title: string;
  url: string;
  contentHash: string;
  note: string;
  publishedAt: string;
}

export interface ArtifactEvent {
  id: string;
  artifactId: string;
  kind: ArtifactEventKind;
  version: number | null;
  detail: string;
  createdAt: string;
}

export interface ArtifactComment {
  id: string;
  artifactId: string;
  version: number | null;
  author: string;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ArtifactSummary {
  id: string;
  title: string;
  url: string;
  sourcePath: string;
  version: number;
  versionCount: number;
  workItemId: string | null;
  workItemTitle: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  publishedAt: string;
  revokedAt: string | null;
  commentCount: number;
  openCommentCount: number;
}

export interface ArtifactDetail {
  artifact: ArtifactSummary;
  versions: ArtifactVersion[];
  events: ArtifactEvent[];
  comments: ArtifactComment[];
  sourceAvailable: boolean;
  sourceChanged: boolean;
}

export const createArtifactCommentSchema = z.object({
  author: z.string().trim().min(1).max(80).default('Coworker'),
  body: z.string().trim().min(1).max(5_000),
  version: z.coerce.number().int().positive().optional(),
});

export const updateArtifactSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  workItemId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
});

export const artifactLibraryViewSchema = z.enum(['published', 'revoked', 'all']).catch('published');
export interface SharedConversation { id: string; title: string; workItemId: string | null; linkedProjectName?: string | null; forkedFromConversationId: string | null; archivedAt: string | null; sharedBrief?: string; preferredExecutionProfile?: AgentRun['executionProfile']; preferredAccountProfile?: string | null; preferredDispatchTarget?: 'both' | 'codex' | 'claude' | null; state?: 'working' | 'needs_attention' | 'waiting_approval' | 'promoting' | 'waiting_promotion' | 'finished' | null; isUnread?: boolean; linkedWorkItemPinned?: boolean; createdAt: string; updatedAt: string; isActive?: boolean; }

export const setConversationTaskSchema = z.object({ workItemId: z.string().uuid().nullable() });
export const updateSharedBriefSchema = z.object({ brief: z.string().trim().max(12_000) });

export const createSharedMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().max(50_000).default(''),
  dispatchTo: z.enum(['auto', 'both', 'codex', 'claude', 'none']).default('auto'),
  executionProfile: executionProfileOverrideSchema,
  // A room turn can be unlinked from a task, so it needs the same explicit
  // account choice as task execution instead of inheriting a hidden server
  // default for the lifetime of the conversation.
  accountProfile: accountProfileSchema.optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().max(200).default('application/octet-stream'),
    size: z.number().int().min(0).max(10_000_000),
    dataBase64: z.string().max(14_000_000),
  })).max(10).default([]),
}).refine((input) => input.body.length > 0 || input.attachments.length > 0, 'Message or attachment required.');

export const createSharedConversationSchema = z.object({ title: z.string().trim().min(1).max(200).default('New conversation') });

export const updateSharedMessageSchema = z.object({
  pinned: z.boolean(),
});

// --- Diagnostics and insights -----------------------------------------------
//
// Structured logging for scheduler, agent, and system events. Events flow into
// the diagnostics table, which self-prunes and feeds the insights dashboard.

export const diagnosticEventSchema = z.enum(['scheduler_tick', 'scheduler_error', 'retention_cleanup', 'message_prune', 'run_compact', 'run_recovery', 'agent_failure', 'lease_expired']);

export interface DiagnosticEvent {
  id: string;
  event: z.infer<typeof diagnosticEventSchema>;
  subsystem: 'scheduler' | 'retention' | 'recovery' | 'agent';
  outcome: 'success' | 'failure';
  errorCode: string | null;
  detail: string;
  durationMs: number | null;
  createdAt: string;
}

export interface LifecycleReportStatus {
  minimumCompletedCases: number;
  eligibleCompletedCases: number;
  nextRunIntervalMs: number;
  report: LifecycleAnalysisSummary | null;
}

export interface LifecycleAnalysisSummary {
  modelVersion: string;
  generatedAt: string;
  caseCount: number;
  eventCount: number;
  deviations: Array<{ caseId: string; eventId: string | null; code: string; message: string }>;
  dataQuality: { casesMissingInitial: number; casesWithMultipleInitials: number; sameTimestampPairs: number; invalidTimestampCount: number };
}

export interface RunInsights {
  /** Retry lifecycle events per terminal agent run. This may exceed 1 when a run is retried repeatedly. */
  retryRate: number | null;
  retryCount: number;
  /** Agent-handoff lifecycle events per terminal agent run. */
  fallbackRate: number | null;
  handoffCount: number;
  costByDay: RunInsightsCostByDay[];
  /** Provider-reported billed cost. Never derived from tokens. */
  providerCostUsd: number;
  previousProviderCostUsd: number | null;
  /** Uncached, short-context list-price estimate from reported tokens; not a bill. */
  estimatedCostUsd: number;
  previousEstimatedCostUsd: number | null;
  providerPricedRuns: number;
  estimatedPricedRuns: number;
  /** Historical rows that stored a cost before Workbench recorded its provenance. Excluded from totals. */
  unverifiedCostRuns: number;
  /** Runs that reported tokens but had no rate for their model. */
  unpricedRuns: number;
  /** Runs recorded before cache telemetry was available. Their input cannot be
   * truthfully split into fresh and cached traffic, so token totals omit them. */
  incompleteTokenTelemetryRuns: number;
  /** Fresh, non-cached input tokens. */
  inputTokens: number;
  /** Tokens used to create or refresh a provider prompt cache. */
  cacheCreationInputTokens: number;
  /** Tokens served from a provider prompt cache. */
  cacheReadInputTokens: number;
  outputTokens: number;
  tokenUsageByModel: RunInsightsTokenUsage[];
  byAgent: RunInsightsByAgent[];
  byKind: RunInsightsByKind[];
  completedRuns: number;
  completedTasks: number;
  medianTaskCycleMs: number | null;
  followUpsCreated: number;
  agentFit: RunInsightsAgentFit[];
  cursing: CurseInsight;
}

export interface CurseInsight {
  total: number;
  /** The calendar day (local) with the highest curse count in this window, or null when there are none. */
  angriestDay: { day: string; count: number } | null;
  messagesAnalyzed: number;
  messagesWithCurses: number;
  instancesPer100Messages: number;
  byTerm: Array<{ term: string; count: number }>;
  byDay: Array<{ day: string; count: number }>;
  /** Attribution is the model on the most recent agent reply before Jeffrey's message. */
  byModel?: Array<{ model: string; count: number; messagesWithCurses: number; messagesAnalyzed: number; instancesPer100Messages: number }>;
}

export interface RunInsightsAgentFit {
  kind: z.infer<typeof runKindSchema>;
  agent: 'codex' | 'claude';
  completed: number;
  failed: number;
  canceled: number;
  successRate: number | null;
  medianDurationMs: number | null;
}

export interface RunInsightsCostByDay {
  day: string;
  costUsd: number;
}

export interface RunInsightsTokenUsage {
  provider: 'codex' | 'claude';
  model: string | null;
  /** Fresh, non-cached input tokens. */
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /** Runs in this model bucket with a token-derived list-price estimate. */
  estimatedPricedRuns: number;
  costUsd: number;
  runs: number;
  /** 'env' when a deployment rate override priced this model, 'default' when the built-in list price did. */
  rateSource: 'env' | 'default' | null;
}

export interface RunInsightsByAgent {
  agent: 'codex' | 'claude';
  total: number;
  completed: number;
  failed: number;
  successRate: number | null;
  /** Retry lifecycle events per terminal run for this agent. */
  retryRate: number | null;
  /** Agent-handoff lifecycle events per terminal run for this agent. */
  fallbackRate: number | null;
  medianDurationMs: number | null;
  p90DurationMs: number | null;
  providerCostUsd: number;
  /** Runs with provider-reported billing for this agent. */
  providerPricedRuns: number;
  estimatedCostUsd: number;
  /** Runs with a token-derived list-price estimate for this agent. */
  estimatedPricedRuns: number;
}

export interface RunInsightsByKind {
  kind: z.infer<typeof runKindSchema>;
  completed: number;
  failed: number;
  canceled: number;
  successRate: number | null;
}

// --- Weekly usage meter -------------------------------------------------------
//
// Sonnet-equivalent token (SET) totals for the current ISO week, split manual
// vs autonomous per provider, plus each provider's weekly ceiling so the
// frontend never has to know the ceiling values itself (see
// docs/autonomy-strategy.md). `ceilingSet` is null when no ceiling estimate
// exists yet — never fabricate one in the client.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  setTokens: number;
  runCount: number;
}

export interface WorkbenchUsageByOrigin {
  manual: UsageTotals;
  autonomous: UsageTotals;
}

export interface ClaudeInteractiveUsage {
  setTokens: number;
  scannedFiles: number;
  /** Non-null means this result is unsafe for a governor to use. */
  error: string | null;
}

/** Current account window read directly from Codex app-server. */
export interface CodexRateLimit {
  usedPercent: number;
  resetsAt: string | null;
  windowDurationMins: number | null;
  planType: string | null;
}

export interface WeeklyUsageReport {
  weekStart: string;
  weekEnd: string;
  /** Alarm-line fraction of each provider's weekly ceiling reserved for autonomous work (see docs/autonomy-strategy.md). */
  autonomousSliceFraction: number;
  /** Target-line fraction autonomous work should spend to, 4 points below the alarm (see docs/autonomy-strategy.md "Spend to 16%, alarm at 20%"). */
  autonomousTargetFraction: number;
  claude: {
    workbench: WorkbenchUsageByOrigin;
    interactive: ClaudeInteractiveUsage;
    /**
     * SET/week ceiling. Comes from the most recent calibration within the
     * last 14 days if one exists, otherwise the pessimistic estimate
     * (`CLAUDE_PESSIMISTIC_CEILING_SET`) so the system under-spends rather
     * than over-spends while uncalibrated.
     */
    ceilingSet: number;
    /** Null until the first `/usage` calibration lands, or once the last one is more than 14 days old. */
    calibration: UsageCalibration | null;
  };
  codex: {
    workbench: WorkbenchUsageByOrigin;
    /** Real account usage from `account/rateLimits/read`; null when Codex is unavailable. */
    rateLimit: CodexRateLimit | null;
    /** From the most recent Codex calibration within the last 14 days, or null until one is submitted. */
    ceilingSet: number | null;
    /** Null until the first `/usage` calibration lands for Codex, or once the last one is more than 14 days old. */
    calibration: UsageCalibration | null;
  };
}

// --- Usage calibration ---------------------------------------------------------
//
// Twice-weekly manual correction of the Claude ceiling: run `/usage` in an
// interactive session, report the percentage it shows and when it was
// observed, and Workbench solves for the real ceiling from the SET it
// already measured for that week. Each submission is a standalone
// observation — there is no automatic retry or correction, only newer
// observations superseding older ones by recency (see
// docs/autonomy-strategy.md "Calibration").

export interface UsageCalibration {
  id: string;
  provider: 'claude' | 'codex';
  observedAt: string;
  observedPercentage: number;
  /** Reset date `/usage` reported for this reading, if given. */
  resetsAt: string | null;
  /** Workbench-dispatched SET measured for the ISO week containing `observedAt`. */
  workbenchSet: number;
  /** Interactive (non-Workbench) SET measured for the same week. */
  interactiveSet: number;
  /** `(workbenchSet + interactiveSet) / (observedPercentage / 100)`. */
  computedCeilingSet: number;
  createdAt: string;
}

/**
 * A calibration as returned in `GET /api/usage/calibration` history: flagged
 * when its solved ceiling drifts sharply from the next-older reading, so a
 * bad `/usage` transcription shows up instead of silently blending in.
 */
export interface UsageCalibrationHistoryEntry extends UsageCalibration {
  flagged: boolean;
}

export const submitUsageCalibrationSchema = z.object({
  provider: z.enum(['claude', 'codex']).default('claude'),
  observedAt: z.string().datetime(),
  observedPercentage: z.number().gt(0).lte(100),
  resetsAt: z.string().datetime().nullish().transform((value) => value ?? null),
});

// --- Audit log ---------------------------------------------------------------
//
// Append-only record of outbound calls to third parties, agent file
// reads/writes/tool use, and every completed state-changing API request, so
// external, agent, and API activity all leave a trace.

export const auditCategorySchema = z.enum(['outbound_call', 'agent_file_read', 'agent_file_write', 'agent_tool_use', 'destructive_action', 'api_mutation']);

export interface AuditLogEntry {
  id: string;
  category: z.infer<typeof auditCategorySchema>;
  source: string;
  detail: string;
  workItemId: string | null;
  createdAt: string;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  nextCursor: string | null;
}

export const listAuditLogQuerySchema = z.object({
  category: auditCategorySchema.optional(),
  workItemId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});
