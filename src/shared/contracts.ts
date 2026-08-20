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
  sourceIdentifier: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  projectName: z.string().nullable(),
  workspacePath: z.string().nullable(),
  strategy: z.string(),
  assignees: z.array(assigneeSchema),
  labels: z.array(z.string()),
  dueDate: z.string().nullable(),
  providerUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
export interface SourceConnection { provider: SourceProvider; connected: boolean; label: string; lastScannedAt: string | null; lastError: string | null; }
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
  lastRun: DiscoveryRun | null;
  running: boolean;
}
export type BrokerSourceId = 'slack' | 'figma' | 'linear' | 'atlassian' | 'github' | 'google';
export type BrokerConnectionState = 'connected' | 'needs_auth' | 'disabled' | 'error';
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

export interface WorkItemDetail {
  item: WorkItem;
  parentItem: WorkItem | null;
  activity: Activity[];
  runs: AgentRun[];
  executionPlan: ExecutionPlan | null;
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
  attachments: SharedAttachment[];
  model: string | null;
  executionProfile: 'routing' | 'economy' | 'standard' | 'deep' | null;
}

export interface SharedAttachment { name: string; path: string; mimeType: string; size: number; }
export interface PublishedArtifact { id: string; url: string; title: string; }
export interface SharedConversation { id: string; title: string; workItemId: string | null; forkedFromConversationId: string | null; archivedAt: string | null; createdAt: string; updatedAt: string; isActive?: boolean; }

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
