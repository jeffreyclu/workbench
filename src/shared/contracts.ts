import { z } from 'zod';

export const workItemStatusSchema = z.enum([
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'done',
  'canceled',
]);

export const assigneeSchema = z.enum(['jeffrey', 'codex', 'claude']);
export const sourceSchema = z.enum(['manual', 'linear']);

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
  agentOutcome: z.enum(['finished', 'follow_ups', 'needs_attention']).nullable(),
  classificationKind: z.string().nullable().optional(),
  classificationComplex: z.boolean().optional(),
  sourceIdentifier: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceTags: z.array(z.string()),
  projectName: z.string().nullable(),
  workspacePath: z.string().nullable(),
  strategy: z.string(),
  assignees: z.array(assigneeSchema),
  labels: z.array(z.string()),
  dueDate: z.string().nullable(),
  providerUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastTouchedAt: z.string(),
});

export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;
export type Assignee = z.infer<typeof assigneeSchema>;

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

export const createWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).default(''),
  priority: z.number().int().min(0).max(4).default(2),
  status: workItemStatusSchema.default('backlog'),
  projectName: z.string().trim().max(200).nullable().default(null),
  workspacePath: z.string().trim().max(1_000).nullable().default(null),
  dueDate: z.string().nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
});

export const generateTaskDraftSchema = z.object({ prompt: z.string().trim().min(3).max(50_000) });
export interface GeneratedTaskDraft { title: string; description: string; projectName: string | null; workspacePath: string | null; }

export const resolveSourceUrlSchema = z.object({ url: z.string().url().max(4_000) });
export interface ResolvedSourceDraft { source: string; sourceUrl: string; title: string; description: string; }

export const sourceProviderSchema = z.enum(['github', 'slack', 'confluence', 'gmail']);
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

export const updateWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  status: workItemStatusSchema.optional(),
  projectName: z.string().trim().max(200).nullable().optional(),
  workspacePath: z.string().trim().max(1_000).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  strategy: z.string().max(50_000).optional(),
  assignees: z.array(assigneeSchema).optional(),
  queuePosition: z.number().optional(),
});

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
  references: WorkItemReference[];
}

export interface TaskClassification {
  kind: AgentRun['kind'];
  agent: AgentRun['agent'];
  complex: boolean;
  instructions: string;
  classifiedAt: string;
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

export const runKindSchema = z.enum(['research', 'analysis', 'strategy', 'execute', 'review']);
export const agentTargetSchema = z.enum(['auto', 'codex', 'claude', 'both']);
export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'canceled']);

export const createAgentRunSchema = z.object({
  kind: runKindSchema,
  target: agentTargetSchema,
  instructions: z.string().trim().max(20_000).default(''),
});

export interface AgentRun {
  id: string;
  workItemId: string;
  kind: z.infer<typeof runKindSchema>;
  requestedTarget: z.infer<typeof agentTargetSchema>;
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
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  fallbackFrom: 'codex' | 'claude' | null;
  fallbackReason: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
}

export interface LinearSyncResult {
  imported: number;
  updated: number;
  skipped: number;
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

export interface QueueProposal {
  id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  previousOrder: string[];
  proposedOrder: string[];
  rationale: string;
  createdAt: string;
  resolvedAt: string | null;
}

export const createQueueProposalSchema = z.object({
  orderedItemIds: z.array(z.string()).min(1),
  rationale: z.string().trim().min(1).max(20_000),
});

export const reorderQueueSchema = z.object({
  itemId: z.string(),
  beforeId: z.string().optional(),
  afterId: z.string().optional(),
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
  executionProfile: 'routing' | 'economy' | 'standard' | 'deep' | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  fallbackFrom: 'codex' | 'claude' | null;
  fallbackReason: string | null;
  dispatchTarget: 'auto' | 'both' | 'codex' | 'claude' | 'none';
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
}

export interface SharedAttachment { name: string; path: string; mimeType: string; size: number; }
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
export interface SharedConversation { id: string; title: string; workItemId: string | null; forkedFromConversationId: string | null; archivedAt: string | null; createdAt: string; updatedAt: string; isActive?: boolean; }
export interface SharedMemory { id: string; kind: 'assistant_codex' | 'assistant_claude' | 'task_archive' | 'conversation_archive'; body: string; createdAt: string; }

export const createSharedMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().max(50_000).default(''),
  dispatchTo: z.enum(['auto', 'both', 'codex', 'claude', 'none']).default('auto'),
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

// --- Structured memory (Phase 1) --------------------------------------------
//
// A memory is a small, provenanced fact/decision/preference/constraint/convention
// that should keep showing up in agent prompts until it's edited away. Distinct
// from the older free-text `shared_memories` archive: memories are structured,
// scoped (global/project/workspace/reference), and status-tracked so a bad one
// can be superseded or rejected without deleting history.

export const memoryKindSchema = z.enum(['constraint', 'preference', 'decision', 'convention', 'fact']);
export const memoryScopeSchema = z.enum(['global', 'project', 'workspace', 'reference']);
export const memoryStatusSchema = z.enum(['proposed', 'active', 'superseded', 'rejected']);

export interface Memory {
  id: string;
  kind: z.infer<typeof memoryKindSchema>;
  scope: z.infer<typeof memoryScopeSchema>;
  projectName: string | null;
  workspacePath: string | null;
  body: string;
  status: z.infer<typeof memoryStatusSchema>;
  supersedesId: string | null;
  sourceTaskId: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceQuote: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const createMemorySchema = z.object({
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  projectName: z.string().trim().max(200).nullable().default(null),
  workspacePath: z.string().trim().max(1_000).nullable().default(null),
  body: z.string().trim().min(1).max(800),
  sourceTaskId: z.string().uuid().nullable().default(null),
  sourceConversationId: z.string().uuid().nullable().default(null),
  sourceMessageId: z.string().uuid().nullable().default(null),
  sourceQuote: z.string().trim().max(2_000).nullable().default(null),
  createdBy: z.string().trim().max(80).nullable().default(null),
}).refine((input) => (input.scope !== 'project' || Boolean(input.projectName)), {
  message: 'projectName is required when scope is "project".', path: ['projectName'],
}).refine((input) => (input.scope !== 'workspace' || Boolean(input.workspacePath)), {
  message: 'workspacePath is required when scope is "workspace".', path: ['workspacePath'],
}).refine((input) => (input.scope !== 'reference' || Boolean(input.sourceTaskId || input.sourceConversationId)), {
  message: 'sourceTaskId or sourceConversationId is required when scope is "reference".', path: ['sourceTaskId'],
});

export const updateMemorySchema = z.object({
  kind: memoryKindSchema.optional(),
  body: z.string().trim().min(1).max(800).optional(),
  projectName: z.string().trim().max(200).nullable().optional(),
  workspacePath: z.string().trim().max(1_000).nullable().optional(),
  status: memoryStatusSchema.optional(),
});

export const listMemoriesQuerySchema = z.object({
  scope: memoryScopeSchema.optional(),
  projectName: z.string().trim().max(200).optional(),
  status: memoryStatusSchema.optional(),
  kind: memoryKindSchema.optional(),
});

export const supersedeMemorySchema = z.object({
  kind: memoryKindSchema,
  body: z.string().trim().min(1).max(800),
});
