import type { RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  assigneeSelectionSchema,
  activeWorkItemStatusSchema,
  calendarDateSchema,
  workItemFilterSchema,
} from '../shared/contracts.js';
import { summarizeWorkItemChanges } from './activity-log.js';
import { WorkItemDependencyError } from './repository.js';
import type { WorkItemRepository } from './repository.js';

const actorSchema = z.enum(['codex', 'claude']).describe('The assistant recording this mutation. Jeffrey and system cannot be impersonated through MCP.');
const stackSchema = z.enum(['attention', 'workbench', 'archive']);
const activeStackSchema = z.enum(['attention', 'workbench']);
const activityKindSchema = z.enum(['note', 'progress', 'decision', 'blocker', 'handoff']);
const plannedTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000),
  workspacePath: z.string().trim().max(1_000).nullable().default(null),
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const mutationAnnotations = (idempotentHint = false) => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint,
  openWorldHint: false,
});

class ToolFailure extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'CONFLICT', message: string) {
    super(message);
  }
}

function success(data: unknown) {
  const payload = { data };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function failure(code: string, message: string) {
  const payload = { error: { code, message } };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function runTool(name: string, operation: () => unknown | Promise<unknown>) {
  const startedAt = Date.now();
  try {
    const data = await operation();
    console.info(JSON.stringify({ subsystem: 'workbench_mcp', event: 'tool_completed', tool: name, outcome: 'success', durationMs: Date.now() - startedAt }));
    return success(data);
  } catch (error) {
    if (error instanceof ToolFailure) {
      console.warn(JSON.stringify({ subsystem: 'workbench_mcp', event: 'tool_completed', tool: name, outcome: 'rejected', errorCode: error.code, durationMs: Date.now() - startedAt }));
      return failure(error.code, error.message);
    }
    console.error(JSON.stringify({
      subsystem: 'workbench_mcp', event: 'tool_completed', tool: name, outcome: 'failed', errorCode: 'INTERNAL_ERROR',
      errorType: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
      durationMs: Date.now() - startedAt,
    }));
    return failure('INTERNAL_ERROR', 'Workbench could not complete the tool call.');
  }
}

function requireWorkItem(repository: WorkItemRepository, id: string) {
  const item = repository.get(id);
  if (!item) throw new ToolFailure('NOT_FOUND', 'Work item not found.');
  return item;
}

export function createWorkbenchMcpServer(repository: WorkItemRepository): McpServer {
  const server = new McpServer({ name: 'workbench', version: '1.0.0' }, {
    instructions: [
      'Workbench is the canonical shared state for Jeffrey, Codex, and Claude.',
      'Read current state before mutating it. Use only the actor that represents the calling assistant.',
      'Provider-owned fields, credentials, execution results, hard deletes, execution dispatch, and plan approval are intentionally read-only or unavailable.',
    ].join(' '),
  });

  server.registerTool('list_stacks', {
    title: 'List Workbench stacks',
    description: 'Returns stack counts and the authoritative ordered work-item IDs for the two active stacks. Archive order is available through list_work_items.',
    inputSchema: {},
    annotations: readOnlyAnnotations,
  }, async () => runTool('list_stacks', () => {
    const counts = repository.getWorkItemCounts();
    return {
      stacks: [
        { name: 'attention', count: counts.active, orderedWorkItemIds: repository.list().map((item) => item.id) },
        { name: 'workbench', count: counts.workbench, orderedWorkItemIds: repository.listWorkbench().map((item) => item.id) },
        { name: 'archive', count: counts.archive },
      ],
    };
  }));

  server.registerTool('list_work_items', {
    title: 'List work items',
    description: 'Lists one canonical stack with stable cursor pagination. attention and workbench are ordered queues; archive is newest first.',
    inputSchema: {
      stack: stackSchema.default('attention'),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().max(4_000).nullable().default(null),
      query: z.string().trim().max(500).default(''),
    },
    annotations: readOnlyAnnotations,
  }, async ({ stack, limit, cursor, query }) => runTool('list_work_items', () => {
    try {
      return repository.listPage(stack === 'attention' ? 'active' : stack, limit, cursor, workItemFilterSchema.parse({ query }));
    } catch {
      throw new ToolFailure('INVALID_ARGUMENT', 'Invalid work-item cursor.');
    }
  }));

  server.registerTool('get_work_item', {
    title: 'Get complete work-item state',
    description: 'Returns a work item with parent/children, activity, immutable execution results, pending plan, classification, conversations, artifacts, references, and dependency edges in both directions.',
    inputSchema: { workItemId: z.string().uuid() },
    annotations: readOnlyAnnotations,
  }, async ({ workItemId }) => runTool('get_work_item', () => {
    const item = requireWorkItem(repository, workItemId);
    return {
      item,
      parentItem: item.parentWorkItemId ? repository.get(item.parentWorkItemId) : null,
      children: repository.listChildren(item.id),
      activity: repository.listActivity(item.id),
      results: repository.listRuns(item.id),
      executionPlan: repository.getPendingExecutionPlan(item.id),
      classification: repository.getClassification(item.id),
      conversations: repository.listConversationsForWorkItem(item.id),
      artifacts: repository.listArtifactsForWorkItem(item.id),
      references: repository.listReferences(item.id),
      // `item.blockedBy` carries the prerequisites; `blocks` is the reverse edge
      // so an agent can see what its work is holding up before it reprioritises.
      blocks: repository.listBlockedWork(item.id),
    };
  }));

  server.registerTool('create_work_item', {
    title: 'Create a manual work item',
    description: 'Creates a locally owned manual task at the top of its stack. Pass `stack` to choose it explicitly; omitted, it is inferred once from the project name. Provider ownership fields cannot be supplied.',
    inputSchema: {
      title: z.string().trim().min(1).max(300),
      description: z.string().max(20_000).default(''),
      priority: z.number().int().min(0).max(4).default(2),
      status: activeWorkItemStatusSchema.default('backlog'),
      projectName: z.string().trim().max(200).nullable().default(null),
      stack: activeStackSchema.optional(),
      workspacePath: z.string().trim().max(1_000).nullable().default(null),
      dueDate: calendarDateSchema.nullable().default(null),
      sourceUrl: z.string().url().max(2_000).nullable().default(null),
      parentWorkItemId: z.string().uuid().nullable().default(null),
    },
    annotations: mutationAnnotations(),
  }, async (input) => runTool('create_work_item', () => {
    if (input.parentWorkItemId) requireWorkItem(repository, input.parentWorkItemId);
    return { item: repository.create(input) };
  }));

  server.registerTool('update_work_item', {
    title: 'Update locally owned work-item fields',
    description: 'Patches only local fields. It cannot change source identity, provider payload, provider timestamps, archive state, completion evidence, or queue order.',
    inputSchema: {
      workItemId: z.string().uuid(),
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(20_000).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      status: activeWorkItemStatusSchema.optional(),
      projectName: z.string().trim().max(200).nullable().optional(),
      stack: activeStackSchema.optional(),
      workspacePath: z.string().trim().max(1_000).nullable().optional(),
      dueDate: calendarDateSchema.nullable().optional(),
      strategy: z.string().max(50_000).optional(),
      assignees: assigneeSelectionSchema.optional()
        .describe('Owners of the task. Jeffrey is exclusive: he cannot be listed alongside codex or claude.'),
      blockedByIds: z.array(z.string().uuid()).max(200).optional()
        .describe('Full replacement set of prerequisite task ids. An empty array clears them. Cycles and self-references are rejected.'),
      actor: actorSchema.optional().describe('Optional. Attributes the resulting activity-log entry to the calling assistant instead of the system.'),
    },
    annotations: mutationAnnotations(true),
  }, async ({ workItemId, actor, ...changes }) => runTool('update_work_item', () => {
    const item = requireWorkItem(repository, workItemId);
    if (Object.values(changes).every((value) => value === undefined)) throw new ToolFailure('INVALID_ARGUMENT', 'Provide at least one locally owned field to update.');
    try {
      const updated = repository.update(workItemId, changes);
      // Every field change an assistant makes shows up in the same activity log
      // Jeffrey's own edits land in, so the task history has one timeline.
      const edits = updated ? summarizeWorkItemChanges(item, updated) : [];
      if (updated && edits.length) repository.addActivity(workItemId, actor ?? 'system', 'edited', `${edits.join(' · ')}.`);
      return { item: updated };
    } catch (error) {
      // Graph rejections are the caller's fault, not a server fault, so they
      // surface as CONFLICT rather than a generic INTERNAL_ERROR.
      if (error instanceof WorkItemDependencyError) throw new ToolFailure('CONFLICT', error.message);
      throw error;
    }
  }));

  server.registerTool('set_work_item_lifecycle', {
    title: 'Archive, complete, or restore a work item',
    description: 'Applies the recoverable Workbench lifecycle transition. complete records completion and archives; archive preserves incomplete state; restore requeues the item.',
    inputSchema: {
      workItemId: z.string().uuid(),
      action: z.enum(['archive', 'complete', 'restore']),
      actor: actorSchema.optional().describe('Optional. Attributes the resulting activity-log entry to the calling assistant instead of the system.'),
    },
    annotations: mutationAnnotations(),
  }, async ({ workItemId, action, actor }) => runTool('set_work_item_lifecycle', () => {
    requireWorkItem(repository, workItemId);
    const context = { actor };
    const item = action === 'restore' ? repository.restore(workItemId, false, context) : repository.archive(workItemId, action === 'complete', false, context);
    if (!item) throw new ToolFailure('CONFLICT', 'Workbench could not apply the lifecycle transition.');
    return { item };
  }));

  server.registerTool('reorder_stack', {
    title: 'Replace an active stack order',
    description: 'Atomically replaces one active stack order. orderedWorkItemIds must contain every active item in that stack exactly once.',
    inputSchema: {
      stack: activeStackSchema,
      orderedWorkItemIds: z.array(z.string().uuid()).min(1).max(1_000),
    },
    annotations: mutationAnnotations(true),
  }, async ({ stack, orderedWorkItemIds }) => runTool('reorder_stack', () => {
    try {
      return { items: repository.reorder(orderedWorkItemIds, stack, { actor: 'agent', reason: 'Assistant replaced the stack order.' }) };
    } catch {
      throw new ToolFailure('CONFLICT', 'Stack order must contain every active item in the selected stack exactly once.');
    }
  }));

  server.registerTool('add_activity', {
    title: 'Record work-item activity',
    description: 'Appends an assistant-authored note, progress update, decision, blocker, or handoff. Existing activity is immutable.',
    inputSchema: {
      workItemId: z.string().uuid(),
      actor: actorSchema,
      kind: activityKindSchema,
      body: z.string().trim().min(1).max(50_000),
    },
    annotations: mutationAnnotations(),
  }, async ({ workItemId, actor, kind, body }) => runTool('add_activity', () => {
    requireWorkItem(repository, workItemId);
    return { activity: repository.addActivity(workItemId, actor, kind, body) };
  }));

  server.registerTool('list_discoveries', {
    title: 'List discovery inbox state',
    description: 'Returns pending or reviewed discovery candidates with counts and latest scan status. This never starts a provider scan.',
    inputSchema: { view: z.enum(['pending', 'reviewed']).default('pending') },
    annotations: readOnlyAnnotations,
  }, async ({ view }) => runTool('list_discoveries', () => repository.getDiscoveryInbox(view)));

  server.registerTool('resolve_discovery', {
    title: 'Resolve one pending discovery',
    description: 'Converts to a new local task, merges into an existing task, dismisses, or snoozes one pending candidate. merge requires workItemId.',
    inputSchema: {
      discoveryId: z.string().uuid(),
      action: z.enum(['convert', 'merge', 'dismiss', 'snooze']),
      workItemId: z.string().uuid().optional(),
    },
    annotations: mutationAnnotations(),
  }, async ({ discoveryId, action, workItemId }) => runTool('resolve_discovery', () => {
    const pending = repository.getDiscoveryInbox('pending').candidates.find((candidate) => candidate.id === discoveryId);
    if (!pending) throw new ToolFailure('NOT_FOUND', 'Pending discovery not found.');
    if (action === 'merge' && !workItemId) throw new ToolFailure('INVALID_ARGUMENT', 'workItemId is required when merging a discovery.');
    if (workItemId) requireWorkItem(repository, workItemId);
    const candidate = repository.resolveDiscoveryCandidate(discoveryId, action, workItemId);
    if (!candidate) throw new ToolFailure('CONFLICT', 'Workbench could not resolve the discovery.');
    return { candidate, item: candidate.workItemId ? repository.get(candidate.workItemId) : null };
  }));

  server.registerTool('list_conversations', {
    title: 'List shared conversations',
    description: 'Lists active or archived shared conversations with stable cursor pagination.',
    inputSchema: {
      view: z.enum(['active', 'archive']).default('active'),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z.string().max(4_000).nullable().default(null),
    },
    annotations: readOnlyAnnotations,
  }, async ({ view, limit, cursor }) => runTool('list_conversations', () => {
    try {
      return repository.listConversationPage(limit, cursor, view);
    } catch {
      throw new ToolFailure('INVALID_ARGUMENT', 'Invalid conversation cursor.');
    }
  }));

  server.registerTool('get_conversation', {
    title: 'Get one shared conversation',
    description: 'Returns conversation metadata and its most recent messages in chronological order.',
    inputSchema: {
      conversationId: z.string().uuid(),
      messageLimit: z.number().int().min(1).max(1_000).default(200),
    },
    annotations: readOnlyAnnotations,
  }, async ({ conversationId, messageLimit }) => runTool('get_conversation', () => {
    const conversation = repository.getConversation(conversationId);
    if (!conversation) throw new ToolFailure('NOT_FOUND', 'Conversation not found.');
    return { conversation, messages: repository.listSharedMessages(messageLimit, null, conversationId).messages };
  }));

  server.registerTool('create_conversation', {
    title: 'Create a shared conversation',
    description: 'Creates an empty shared conversation, optionally linked to a work item. It does not dispatch an agent.',
    inputSchema: {
      title: z.string().trim().min(1).max(200),
      workItemId: z.string().uuid().nullable().default(null),
    },
    annotations: mutationAnnotations(),
  }, async ({ title, workItemId }) => runTool('create_conversation', () => {
    if (workItemId) requireWorkItem(repository, workItemId);
    return { conversation: repository.createConversation(title, workItemId) };
  }));

  server.registerTool('add_conversation_message', {
    title: 'Append an assistant conversation message',
    description: 'Appends a completed Codex or Claude message to a shared conversation. It cannot impersonate Jeffrey/system, queue work, dispatch agents, or alter existing messages.',
    inputSchema: {
      conversationId: z.string().uuid(),
      actor: actorSchema,
      body: z.string().trim().min(1).max(50_000),
    },
    annotations: mutationAnnotations(),
  }, async ({ conversationId, actor, body }) => runTool('add_conversation_message', () => {
    if (!repository.getConversation(conversationId)) throw new ToolFailure('NOT_FOUND', 'Conversation not found.');
    return { message: repository.createSharedMessage(actor, body, 'completed', conversationId, [], 'none') };
  }));

  server.registerTool('list_execution_plans', {
    title: 'List work-item execution plans',
    description: 'Returns pending and resolved execution-plan proposals for one work item. Plan approval remains a Jeffrey-controlled action outside MCP.',
    inputSchema: {
      workItemId: z.string().uuid(),
      status: z.enum(['pending', 'accepted', 'rejected']).optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ workItemId, status }) => runTool('list_execution_plans', () => {
    requireWorkItem(repository, workItemId);
    return { plans: repository.listExecutionPlans(workItemId, status) };
  }));

  server.registerTool('propose_execution_plan', {
    title: 'Propose a work-item execution plan',
    description: 'Creates a pending decomposition proposal and supersedes any older pending plan for the same work item. It does not approve the plan or create child tasks.',
    inputSchema: {
      workItemId: z.string().uuid(),
      summary: z.string().trim().min(1).max(20_000),
      tasks: z.array(plannedTaskSchema).min(1).max(50),
    },
    annotations: mutationAnnotations(),
  }, async ({ workItemId, summary, tasks }) => runTool('propose_execution_plan', () => {
    requireWorkItem(repository, workItemId);
    return { plan: repository.createExecutionPlan(workItemId, summary, tasks) };
  }));

  server.registerTool('list_results', {
    title: 'List immutable execution results',
    description: 'Returns agent-run results and operational metadata for one work item. MCP cannot create, cancel, retry, or rewrite runs/results.',
    inputSchema: {
      workItemId: z.string().uuid(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ workItemId, status }) => runTool('list_results', () => {
    requireWorkItem(repository, workItemId);
    const results = repository.listRuns(workItemId).filter((run) => !status || run.status === status);
    return { results };
  }));

  return server;
}

export function createWorkbenchMcpHandler(repository: WorkItemRepository): RequestHandler {
  return async (request, response) => {
    const server = createWorkbenchMcpServer(repository);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await server.close();
    };
    response.once('close', () => { void close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
      }
      await close();
    }
  };
}

export const rejectUnsupportedMcpMethod: RequestHandler = (_request, response) => {
  response.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
