import { z } from 'zod';
import { REVIEW_CHANGE_TYPES } from './change-type.js';
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
  agentOutcome: z.enum(['finished', 'follow_ups', 'needs_attention', 'canceled', 'promoting', 'waiting_promotion']).nullable(),
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
  hasMore: boolean;
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

/** Blocks of one file's diff sent for AI confidence assessment. Keys are echoed
 * back in the response so the client can match scores to rendered blocks. */
export const diffConfidenceRequestSchema = z.object({
  blocks: z.array(z.object({
    key: z.string().min(1).max(2_000),
    lines: z.array(z.string().max(4_000)).min(1).max(200),
  })).min(1).max(120),
});

/** A reviewer-initiated question about one review-queue decision. Each action
 * spawns a fresh single-shot AI turn on click — including `score_risk`, which
 * produces the 0-100 review-risk number on demand for the decision a reviewer
 * has open rather than ambiently for every hunk in the diff. Every request here
 * is explicit and its failure is reported to the reviewer rather than silently
 * downgraded. */
/** Wire limits shared by the schema and the one payload builder used by both
 * foreground assist and background scoring. Keeping them exported prevents a
 * large diff from becoming a client/server contract mismatch. */
export const REVIEW_ASSIST_MAX_HUNKS = 50;
export const REVIEW_ASSIST_MAX_LINES_PER_HUNK = 200;
export const REVIEW_ASSIST_MAX_LINE_LENGTH = 4_000;

/** Accepts payloads from tabs opened before the current release while applying
 * the exact same representative bound as the current client. This is a rolling
 * compatibility boundary: a runtime handoff must not turn an old, valid diff
 * into a 400 until the user refreshes their browser. */
export function boundReviewAssistLines(lines: readonly string[]): string[] {
  const bounded = lines.length <= REVIEW_ASSIST_MAX_LINES_PER_HUNK
    ? lines
    : [
      ...lines.slice(0, Math.floor((REVIEW_ASSIST_MAX_LINES_PER_HUNK - 1) / 2)),
      `... ${lines.length - REVIEW_ASSIST_MAX_LINES_PER_HUNK + 1} diff lines omitted ...`,
      ...lines.slice(-(REVIEW_ASSIST_MAX_LINES_PER_HUNK - Math.floor((REVIEW_ASSIST_MAX_LINES_PER_HUNK - 1) / 2) - 1)),
    ];
  return bounded.map((line) => line.slice(0, REVIEW_ASSIST_MAX_LINE_LENGTH));
}

const reviewAssistLinesSchema = z.array(z.string())
  .transform(boundReviewAssistLines)
  .pipe(z.array(z.string().max(REVIEW_ASSIST_MAX_LINE_LENGTH)).max(REVIEW_ASSIST_MAX_LINES_PER_HUNK));

/** How much attention the review stack routed a block to. It rides on the
 * assist request because it changes what the answer is worth: a T1 skim and a
 * T3 study are different questions, and a cache that ignored the tier would
 * serve the cheap one wearing the expensive one's authority. Changes never
 * sends it, so its requests hash exactly as they did before this existed. */
export const REVIEW_ASSIST_TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
export type ReviewAssistTier = typeof REVIEW_ASSIST_TIERS[number];

/** The line a tiered answer signs off with, so the review stack can tell an
 * answer the model stands behind from one it could not. Only tiered requests
 * are asked for it: a Changes answer gains no trailer it did not have before.
 * Both prefixes live here because the server writes the instruction and the
 * review stack reads the result, and a marker defined twice drifts. */
export const REVIEW_ASSIST_CONFIDENCE_PREFIX = 'CONFIDENCE:';
/** Names what the model needed and was not given, on the line after a low
 * confidence marker. What it names is the reason the block escalates. */
export const REVIEW_ASSIST_MISSING_PREFIX = 'MISSING:';

export const reviewAssistRequestSchema = z.object({
  action: z.enum(['explain', 'what_could_break', 'compare_task_intent', 'score_risk']),
  decision: z.object({
    behavior: z.string().min(1).max(2_000),
    state: z.string().min(1).max(100),
    // Defaulted rather than required: a browser tab left open across a runtime
    // upgrade still posts the old payload shape, and degrading it to the
    // residual type is better than a validation error in the reviewer's face.
    changeType: z.enum(REVIEW_CHANGE_TYPES).default('behavior_edit'),
    secondaryChangeTypes: z.array(z.enum(REVIEW_CHANGE_TYPES)).max(REVIEW_CHANGE_TYPES.length).default([]),
    hunks: z.array(z.object({
      filePath: z.string().min(1).max(2_000),
      location: z.string().min(1).max(200),
      lines: reviewAssistLinesSchema,
    })).min(1).max(REVIEW_ASSIST_MAX_HUNKS),
    // Defaulted for the same reason as `changeType`: a tab opened before this
    // field existed still posts the old payload, and answering without the
    // coverage pack is strictly better than rejecting the request.
    coverageEvidence: z.object({
      symbols: z.array(z.string().min(1).max(200)).max(12),
      hunks: z.array(z.object({
        filePath: z.string().min(1).max(2_000),
        location: z.string().min(1).max(200),
        lines: reviewAssistLinesSchema,
        symbols: z.array(z.string().min(1).max(200)).max(12),
      })).max(4),
      uncitedSymbols: z.array(z.string().min(1).max(200)).max(12),
    }).default({ symbols: [], hunks: [], uncitedSymbols: [] }),
    // Defaulted for the same reason as `coverageEvidence`.
    referenceEvidence: z.object({
      symbols: z.array(z.string().min(1).max(200)).max(12),
      hunks: z.array(z.object({
        filePath: z.string().min(1).max(2_000),
        location: z.string().min(1).max(200),
        lines: reviewAssistLinesSchema,
        symbols: z.array(z.string().min(1).max(200)).max(12),
        kind: z.enum(['residual', 'updated']),
      })).max(3),
      residualSymbols: z.array(z.string().min(1).max(200)).max(12),
      clearedSymbols: z.array(z.string().min(1).max(200)).max(12),
    }).default({ symbols: [], hunks: [], residualSymbols: [], clearedSymbols: [] }),
  }),
  taskIntent: z.object({
    title: z.string().max(2_000),
    description: z.string().max(50_000),
  }).nullable().default(null),
  tier: z.enum(REVIEW_ASSIST_TIERS).nullable().default(null),
});

/** One logic-block boundary the TypeScript compiler found inside a diff: the
 * line a primitive starts on in the file as the patch leaves it.
 *
 * The wire shape is deliberately loose where the server is strict. `effect`
 * and `hazards` are unions in the analysis module, but that module imports the
 * TypeScript compiler and the client is a browser bundle, so the unions stay
 * server side and the boundary crosses as plain strings. */
export interface DiffLogicBoundary {
  /** 1-based, in the file as the patch leaves it. */
  line: number;
  /** The construct as a reviewer would name it, taken from the syntax. */
  label: string;
  effect: string;
  /** What this costs to get wrong. What the review queue ranks on. */
  score: number;
  hazards: string[];
}

/** The hazard vocabulary, and what each hazard costs to get wrong.
 *
 * It lives here rather than beside the analysis that finds them because both
 * sides need it: the server weighs a primitive's score with it, and the Review
 * queue routes and explains a block with it. The analysis module imports the
 * TypeScript compiler and so cannot ship to a browser bundle — a copy on the
 * client would be a second vocabulary drifting from the one doing the finding. */
export const LOGIC_HAZARD_WEIGHT = {
  guard_removed: 12,
  error_swallowed: 10,
  await_in_loop: 7,
  condition_inverted: 7,
  boundary_moved: 5,
  loop_bound_changed: 5,
  return_path_added: 3,
} as const;

export type LogicHazardName = keyof typeof LOGIC_HAZARD_WEIGHT;

/** Said in the reviewer's words, because this is what the queue shows as the
 * reason a block was routed where it was. */
export const LOGIC_HAZARD_REASONS: Record<LogicHazardName, string> = {
  guard_removed: 'A guard that used to reject input is gone.',
  error_swallowed: 'A failure is caught and not reported.',
  await_in_loop: 'Each iteration waits for the last — this is sequential I/O.',
  condition_inverted: 'A condition changed sense, so the paths swapped.',
  boundary_moved: 'A comparison boundary moved, so the edge case changed.',
  loop_bound_changed: 'The iteration bound changed.',
  return_path_added: 'A new way out of the function.',
};

/** Hazards cross the wire as plain strings, so the client narrows before it
 * weighs one. An unknown name is a server newer than this bundle, not a bug. */
export function isLogicHazard(name: string): name is LogicHazardName {
  return Object.prototype.hasOwnProperty.call(LOGIC_HAZARD_WEIGHT, name);
}

/** A read-only snapshot of the uncommitted changes in a task's local workspace. */
export interface WorkspaceDiffFile {
  path: string;
  /** A local editor deep link when this file still exists in the selected checkout. */
  editorUrl?: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
  previousPath: string | null;
  patch: string | null;
  isBinary: boolean;
  /** Where the compiler says the thoughts in this patch begin. Absent when the
   * file is binary, is not a language the parser speaks, or is too large to be
   * worth parsing; the Review splitter falls back to its indentation heuristic. */
  logicBlocks?: DiffLogicBoundary[];
}

export interface WorkspaceDiff {
  workspacePath: string;
  branch: string;
  /** Content revision used to detect updates without replacing an open diff. */
  revision: string;
  files: WorkspaceDiffFile[];
  changedFiles: number;
  additions: number;
  deletions: number;
  publish: WorkspacePublishStatus;
}

/** One file read whole, for reviewing a block in its real surroundings rather
 * than in a three-line patch window.
 *
 * `content` is null whenever the file cannot be read as one page — deleted,
 * binary, absent from the revision, oversized — and `unavailable` then carries
 * the reason to show. The patch is unaffected either way. */
export interface WorkspaceFileSource {
  path: string;
  /** The commit read, or null when the working-tree copy was read. */
  revision: string | null;
  content: string | null;
  unavailable: string | null;
}

/** An immutable, previously reviewed workspace diff. */
export interface WorkspaceDiffSnapshot {
  id: string;
  revision: string;
  diff: WorkspaceDiff;
  capturedAt: string;
  /** Agent run that produced this review record, when Workbench can establish one. */
  originatingAgentRunId: string | null;
  /** Full Git HEAD recorded with the snapshot, or its recovered commit. */
  commitHash: string | null;
}

export type DiffHunkReviewState = 'reviewed' | 'needs_changes' | 'commented';

/** Persistent review state for one hunk of one file at a given diff revision. */
export interface DiffHunkReview {
  id: string;
  revision: string;
  filePath: string;
  hunkRange: string;
  state: DiffHunkReviewState;
  note: string | null;
  updatedAt: string;
}

export const upsertDiffHunkReviewsSchema = z.object({
  revision: z.string().trim().min(1),
  hunks: z.array(z.object({
    filePath: z.string().trim().min(1),
    hunkRange: z.string().trim().min(1),
  })).min(1).max(500),
  state: z.enum(['reviewed', 'needs_changes', 'commented']),
  note: z.string().trim().min(1).optional(),
}).superRefine((input, context) => {
  const keys = new Set<string>();
  for (const hunk of input.hunks) {
    const key = `${hunk.filePath}\u0000${hunk.hunkRange}`;
    if (keys.has(key)) context.addIssue({ code: 'custom', message: 'Each hunk may appear only once.', path: ['hunks'] });
    keys.add(key);
  }
});

export type UpsertDiffHunkReviewsInput = z.infer<typeof upsertDiffHunkReviewsSchema>;

/** Persistent review state for one *block* — a hunk cut at the boundaries a
 * reader would use — at a given diff revision.
 *
 * Deliberately its own table rather than a column on `diff_hunk_reviews`. A
 * shared table would make Changes read rows addressed at a granularity it does
 * not speak, and the Review surface exists precisely so that Changes keeps
 * working exactly as it does today. Answering every block of a hunk
 * now reconciles up to the hunk row Changes reads, but that projection lives in
 * the Review surface: Changes still reads only its own table at its own
 * granularity, and a half-answered hunk is never claimed. */
export interface DiffBlockReview {
  id: string;
  revision: string;
  filePath: string;
  blockRange: string;
  /** Hash of the block's own lines. A block whose content changed asks its
   * question again instead of inheriting a verdict given about other code. */
  contentHash: string;
  state: DiffHunkReviewState;
  note: string | null;
  updatedAt: string;
}

export const upsertDiffBlockReviewSchema = z.object({
  revision: z.string().trim().min(1),
  filePath: z.string().trim().min(1),
  blockRange: z.string().trim().min(1),
  contentHash: z.string().trim().min(1).max(64),
  state: z.enum(['reviewed', 'needs_changes', 'commented']),
  note: z.string().trim().min(1).optional(),
});

export type UpsertDiffBlockReviewInput = z.infer<typeof upsertDiffBlockReviewSchema>;

export interface WorkspacePublishStatus {
  branch: string | null;
  hasOrigin: boolean;
  ahead: number;
  hasChanges: boolean;
  reason: string | null;
}

export interface WorkspacePublishResult {
  committed: boolean;
  pushed: boolean;
  commit: string | null;
}

export interface GitHubPullRequestFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
  previousPath: string | null;
  patch: string | null;
  isBinary: boolean;
}

export interface GitHubPullRequestReviewComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  author: string | null;
  createdAt: string;
  url: string;
}

export interface GitHubPullRequestCommentsSummary {
  /** False when the comments fetch itself failed; counts below are then unusable. */
  available: boolean;
  /** True when more review comments exist beyond the loaded page, so `total`/`byPath` undercount. */
  partial: boolean;
  total: number | null;
  byPath: Record<string, number>;
  comments: GitHubPullRequestReviewComment[];
  error: string | null;
}

export interface GitHubPullRequestDiff {
  url: string;
  repository: string;
  number: number;
  title: string;
  baseRef: string;
  headRef: string;
  /** Immutable Git commit used to anchor review decisions for this PR revision. */
  headSha: string;
  /** Review revision. Equal to `headSha` so force-pushes never reuse decisions. */
  revision: string;
  files: GitHubPullRequestFile[];
  changedFiles: number;
  additions: number;
  deletions: number;
  nextPage: number | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  /** GitHub's mergeable_state, or 'unknown' while GitHub is still computing it. */
  mergeableState: string;
  /** Approximated from individual review states (GitHub only exposes the authoritative
   * review_decision through GraphQL). Null when no reviews exist or the reviews fetch failed. */
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  /** Set when the reviews fetch failed, so a null reviewDecision above isn't mistaken for "no reviews". */
  reviewDecisionError: string | null;
  comments: GitHubPullRequestCommentsSummary;
}

export const sourceProviderSchema = z.enum(['github', 'slack', 'figma', 'confluence', 'grafana', 'gmail']);
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
export type BrokerSourceId = 'slack' | 'figma' | 'linear' | 'atlassian' | 'grafana' | 'github' | 'google';
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
export const brokerSourceIdSchema = z.enum(['slack', 'figma', 'linear', 'atlassian', 'grafana', 'github', 'google']);
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

export const grafanaConnectionSchema = z.object({
  token: z.string().trim().min(1, 'Grafana service-account token is required.').max(10_000),
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

export interface AgentRunReviewHandoffChange {
  path: string;
  summary: string;
  rationale: string;
}

export interface AgentRunReviewHandoffCriterion {
  criterion: string;
  files: string[];
  decisions: string[];
}

export interface AgentRunReviewHandoffContractChange {
  kind: 'api' | 'schema' | 'behavior';
  summary: string;
}

export interface AgentRunReviewHandoffVerification {
  command: string;
  exitCode: number | null;
  result: 'passed' | 'failed';
}

/** Immutable reviewer map captured when a coding run completes. */
export interface AgentRunReviewHandoff {
  agentRunId: string;
  formatVersion: 1;
  /** Agent-provided navigation text. It is never verification evidence. */
  summary: string;
  changes: AgentRunReviewHandoffChange[];
  acceptanceCriteria: AgentRunReviewHandoffCriterion[];
  contractChanges: AgentRunReviewHandoffContractChange[];
  verification: AgentRunReviewHandoffVerification[];
  uncertainties: string[];
  tradeoffs: Array<{ decision: string; rationale: string }>;
  createdAt: string;
}

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
  /** Dollars for this run: provider-billed when reported, else estimated from
   * the recorded tokens. Null when the model has no known rate. */
  estimatedCostUsd: number | null;
  costSource: 'provider' | 'estimated' | null;
  fallbackFrom: 'codex' | 'claude' | null;
  fallbackReason: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** Directory this run resolved to and edits under. Recorded at dispatch so a run's filesystem target is durable, auditable, and lockable. */
  resolvedWorkspace: string | null;
  /** Historical dispatch origin. New runs are always manual. */
  origin: 'manual' | 'autonomous';
  /** Present only after a completed coding run writes its immutable reviewer map. */
  reviewHandoff: AgentRunReviewHandoff | null;
}

/** A conversation-level alert threshold for cumulative cached-input spend.
 * This is accounting only: cache spend must never terminate an active agent. */
export const CACHE_READ_SOFT_LIMIT_TOKENS = 500_000;

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
  /** Dollars for this reply; see AgentRun.estimatedCostUsd. */
  estimatedCostUsd: number | null;
  costSource: 'provider' | 'estimated' | null;
  fallbackFrom: 'codex' | 'claude' | null;
  fallbackReason: string | null;
  dispatchTarget: 'auto' | 'both' | 'codex' | 'claude' | 'none';
  /** The human turn that dispatched this reply; both-agent replies share it. */
  dispatchGroupId: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** Higher values run first among queued human turns; set only by Interject. */
  queuePriority?: number;
  /** Activity-feed boundary captured when this interjection reached a live reply. */
  interjectionStreamOffset?: number | null;
  /** Number of memory matches retrieved from RAG for this reply's prompt, or null if retrieval was not run (e.g. the human's own message). */
  retrievedMemoryCount: number | null;
  /** Execution type this reply was dispatched under (research/analysis/strategy/execute/review/bugfix), set for both linked and standalone conversations. Null for messages created before this field existed, or for non-agent messages (e.g. jeffrey's own turns, system notices). */
  kind?: z.infer<typeof runKindSchema> | null;
}

export interface SharedAttachment { name: string; path: string; mimeType: string; size: number; }

/** A provider event retained for the agent debugger. It belongs to one reply,
 * so parallel Codex and Claude streams never get mixed together. */
export interface AgentStreamEvent {
  id: string;
  messageId: string;
  runId: string | null;
  kind: 'decision' | 'tool' | 'file_read' | 'file_write';
  detail: string;
  createdAt: string;
}

export type SessionFeedbackRating = 'positive' | 'neutral' | 'negative';

/** Immutable human verdict plus the causal evidence available when it was made. */
export interface SessionFeedback {
  id: string;
  conversationId: string | null;
  workItemId: string | null;
  rating: SessionFeedbackRating;
  decisionTree: { version: 1; capturedAt: string; conversationId: string | null; workItemId: string | null; events: AgentStreamEvent[] };
  createdAt: string;
}

export const createSessionFeedbackSchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  workItemId: z.string().uuid().nullable().optional(),
  rating: z.enum(['positive', 'neutral', 'negative']),
}).refine((input) => input.conversationId || input.workItemId, { message: 'A conversation or task is required.' });

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
  /** Stable, page-local range identifying the text the coworker commented on. */
  anchor: string | null;
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
  anchor: z.string().trim().min(1).max(500).optional(),
});

export const updateArtifactSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  workItemId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
});

export const artifactLibraryViewSchema = z.enum(['published', 'revoked', 'all']).catch('published');
export interface SharedConversation { id: string; title: string; workItemId: string | null; pinned?: boolean; linkedProjectName?: string | null; forkedFromConversationId: string | null; archivedAt: string | null; sharedBrief?: string; preferredExecutionProfile?: AgentRun['executionProfile']; draftBody?: string; preferredAccountProfile?: string | null; preferredDispatchTarget?: 'both' | 'codex' | 'claude' | null; claudeSessionId?: string | null; codexThreadId?: string | null; state?: 'working' | 'needs_attention' | 'canceled' | 'waiting_approval' | 'promoting' | 'waiting_promotion' | 'finished' | null; isUnread?: boolean; linkedWorkItemPinned?: boolean; createdAt: string; updatedAt: string; isActive?: boolean; }

export const setConversationTaskSchema = z.object({ workItemId: z.string().uuid().nullable() });
export const setConversationPinnedSchema = z.object({ pinned: z.boolean() });
export const updateSharedBriefSchema = z.object({ brief: z.string().trim().max(12_000) });
export const updateSharedConversationDraftSchema = z.object({ body: z.string().max(50_000) });

export const createSharedMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().max(50_000).default(''),
  dispatchTo: z.enum(['auto', 'both', 'codex', 'claude', 'none']).default('auto'),
  executionKind: runKindSchema.optional(),
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
  pinned: z.boolean().optional(),
  kind: runKindSchema.optional(),
}).refine((input) => input.pinned !== undefined || input.kind !== undefined, {
  message: 'Message update required.',
});

// --- Diagnostics and insights -----------------------------------------------
//
// Structured logging for scheduler, agent, and system events. Events flow into
// the diagnostics table, which self-prunes and feeds the insights dashboard.

export type InsightsTimeframe = '15m' | '1h' | '1d' | '7d' | '30d' | 'all';

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

export interface RunInsights {
  /** Retry lifecycle events per terminal agent run. This may exceed 1 when a run is retried repeatedly. */
  retryRate: number | null;
  retryCount: number;
  /** Agent-handoff lifecycle events per terminal agent run. */
  fallbackRate: number | null;
  handoffCount: number;
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
  /** Dollars for the window: provider-billed where reported, else list-price
   * estimate. Excludes runs on a model with no known rate. */
  estimatedCostUsd: number;
  /** Runs with usable token telemetry on a model Workbench cannot price. */
  unpricedTokenTelemetryRuns: number;
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

export interface RunInsightsTokenUsage {
  provider: 'codex' | 'claude';
  model: string | null;
  /** Fresh, non-cached input tokens. */
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  runs: number;
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
}

export interface RunInsightsByKind {
  kind: z.infer<typeof runKindSchema>;
  completed: number;
  failed: number;
  canceled: number;
  successRate: number | null;
}

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
