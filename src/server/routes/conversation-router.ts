import { Router } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createSessionFeedbackSchema, createSharedConversationSchema, createSharedMessageSchema, setConversationTaskSchema, updateSharedBriefSchema, updateSharedConversationDraftSchema, updateSharedMessageSchema } from '../../shared/contracts.js';
import { runAgentCommandWithFallback } from '../agent-runner.js';
import { searchMemory } from '../memory-index.js';
import { cancelSharedReply, dispatchNextSharedTurn, interjectQueuedSharedMessage, replyInSharedRoom, resolveSharedReplyWorkingDirectory, runSharedBackgroundJob } from '../shared-room.js';
import { commitAndPushWorkspace, getWorkspaceDiff, getWorkspaceDiffRevision } from '../workspace-diff.js';
import { captureRecordedWorkspaceDiffSnapshots } from '../workspace-diff-history.js';
import { parseFollowUpPlan } from '../app-exports.js';
import { isRuntimeApproval } from '../runtime-promotion.js';
import { PROMOTION_QUEUED_MESSAGE } from '../promotion-messages.js';
import type { RouteContext } from '../route-context.js';

export function createConversationRouter({ repository, database, capabilities }: RouteContext) {
  const router = Router();
  router.get('/api/shared/conversations', (request, response) => {
    repository.ensureDefaultConversation();
    const limit = z.coerce.number().int().min(1).max(100).default(30).parse(request.query.limit);
    const cursor = z.string().optional().parse(request.query.cursor) ?? null;
    const view = request.query.view === 'archive' ? 'archive' : 'active';
    response.json(repository.listConversationPage(limit, cursor, view));
  });

  router.get('/api/shared/conversations/:id', (request, response) => {
    const conversation = repository.getConversation(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  router.get('/api/shared/conversations/:id/agent-events', (request, response) => {
    if (!repository.getConversation(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ events: repository.listAgentStreamEvents(request.params.id) });
  });

  router.get('/api/shared/conversations/:id/feedback', (request, response) => {
    if (!repository.getConversation(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ feedback: repository.getSessionFeedback(request.params.id) });
  });

  // A conversation without a linked task still runs its agent turns somewhere
  // (see resolveSharedReplyWorkingDirectory: the Workbench server cwd), so it
  // has real, reviewable changes even though there is no task workspace.
  const conversationWorkingDirectory = (conversationId: string) => {
    const conversation = repository.getConversation(conversationId);
    if (!conversation) return null;
    const linkedItem = conversation.workItemId ? repository.get(conversation.workItemId) : null;
    return resolveSharedReplyWorkingDirectory(linkedItem ?? null);
  };

  router.get('/api/shared/conversations/:id/workspace-diff', async (request, response, next) => {
    try {
      const workingDirectory = conversationWorkingDirectory(request.params.id);
      if (!workingDirectory) return response.status(404).json({ error: 'Conversation not found.' });
      const diff = await getWorkspaceDiff(workingDirectory);
      if (diff.changedFiles > 0) repository.captureWorkspaceDiffSnapshot({ conversationId: request.params.id }, diff);
      response.json({ diff });
    } catch (error) { next(error); }
  });
  router.get('/api/shared/conversations/:id/workspace-diff/snapshots', async (request, response, next) => {
    try {
      const workingDirectory = conversationWorkingDirectory(request.params.id);
      if (!workingDirectory) return response.status(404).json({ error: 'Conversation not found.' });
      await captureRecordedWorkspaceDiffSnapshots(repository, { conversationId: request.params.id }, workingDirectory, [request.params.id]);
      response.json({ snapshots: repository.listWorkspaceDiffSnapshots({ conversationId: request.params.id }) });
    } catch (error) { next(error); }
  });

  router.get('/api/shared/conversations/:id/workspace-diff/status', async (request, response, next) => {
    try {
      const workingDirectory = conversationWorkingDirectory(request.params.id);
      if (!workingDirectory) return response.status(404).json({ error: 'Conversation not found.' });
      const revision = await getWorkspaceDiffRevision(workingDirectory);
      response.json({ changed: revision !== request.query.revision });
    } catch (error) { next(error); }
  });

  router.post('/api/shared/conversations/:id/workspace-diff/commit-and-push', async (request, response, next) => {
    try {
      const workingDirectory = conversationWorkingDirectory(request.params.id);
      if (!workingDirectory) return response.status(404).json({ error: 'Conversation not found.' });
      const { revision } = z.object({ revision: z.string().trim().min(1) }).parse(request.body);
      const conversation = repository.getConversation(request.params.id)!;
      const result = await commitAndPushWorkspace(workingDirectory, `chore: ${conversation.title}`, revision);
      response.json({ result });
    } catch (error) { next(error); }
  });

  router.post('/api/shared/session-feedback', (request, response) => {
    const input = createSessionFeedbackSchema.parse(request.body);
    const feedback = repository.createSessionFeedback(input);
    if (!feedback) return response.status(404).json({ error: 'Conversation or task not found.' });
    response.status(201).json({ feedback });
  });

  router.get('/api/shared/conversations-unread-count', (_request, response) => {
    response.json({ count: repository.countUnreadConversations() });
  });

  router.get('/api/shared/conversations-attention-count', (_request, response) => {
    response.json({ count: repository.countAttentionConversations() });
  });

  router.get('/api/shared/conversations-count', (_request, response) => {
    response.json({ count: repository.countActiveConversations() });
  });

  router.post('/api/shared/conversations', (request, response) => {
    const input = createSharedConversationSchema.parse(request.body);
    response.status(201).json({ conversation: repository.createConversation(input.title) });
  });

  router.delete('/api/shared/conversations/:id', (request, response) => {
    const conversation = repository.getConversation(request.params.id);
    if (conversation?.workItemId) return response.status(409).json({ error: 'Task-linked conversations can only be deleted by deleting their task.' });
    if (!repository.deleteConversation(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
    repository.addAuditEntry('destructive_action', 'workbench', `Deleted conversation ${request.params.id}`);
    repository.ensureDefaultConversation();
    response.status(204).end();
  });

  router.post('/api/shared/conversations/:id/undelete', (request, response) => {
    const conversation = repository.undeleteConversation(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found or not deleted.' });
    repository.addAuditEntry('api_mutation', 'workbench', `Restored deleted conversation ${request.params.id}`);
    response.json({ conversation });
  });

  router.post('/api/shared/conversations/:id/archive', (request, response) => {
    const conversation = repository.setConversationArchived(request.params.id, true);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  router.post('/api/shared/conversations/:id/restore', (request, response) => {
    const conversation = repository.setConversationArchived(request.params.id, false);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  router.patch('/api/shared/conversations/:id/preferences', (request, response) => {
    const preferences = z.object({
      executionProfile: z.enum(['economy', 'standard', 'deep']).nullable(),
      accountProfile: z.string().trim().min(1).max(120).nullable(),
      dispatchTarget: z.enum(['both', 'codex', 'claude']).nullable(),
    }).parse(request.body);
    const conversation = repository.setConversationComposerPreferences(request.params.id, {
      preferredExecutionProfile: preferences.executionProfile,
      preferredAccountProfile: preferences.accountProfile,
      preferredDispatchTarget: preferences.dispatchTarget,
    });
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  router.patch('/api/shared/conversations/:id/brief', (request, response) => {
    const { brief } = updateSharedBriefSchema.parse(request.body);
    const conversation = repository.setConversationSharedBrief(request.params.id, brief);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  router.patch('/api/shared/conversations/:id/draft', (request, response) => {
    const { body } = updateSharedConversationDraftSchema.parse(request.body);
    const conversation = repository.setConversationDraft(request.params.id, body);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  router.patch('/api/shared/conversations/:id/task', (request, response) => {
    const { workItemId } = setConversationTaskSchema.parse(request.body);
    const conversation = repository.setConversationWorkItem(request.params.id, workItemId);
    if (!conversation) return response.status(404).json({ error: workItemId ? 'Conversation or task not found.' : 'Conversation not found.' });
    response.json({ conversation });
  });

  router.post('/api/shared/conversations/:id/read', (request, response) => {
    const conversation = repository.markConversationRead(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  router.post('/api/shared/conversations/:id/fork', (request, response) => {
    const conversation = repository.forkConversation(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.status(201).json({ conversation });
  });

  router.get('/api/shared/search', (request, response) => {
    const query = z.string().trim().min(1).optional().parse(request.query.q);
    if (!query) return response.status(400).json({ error: 'Query parameter "q" is required.' });
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(request.query.limit);
    response.json({ results: repository.searchShared(query, limit) });
  });

  // This is intentionally read-only. Both CLI agents can retrieve the full
  // durable Workbench record instead of relying on their private chat memory.
  router.get('/api/activity-memory', async (request, response) => {
    const query = z.string().trim().min(2).max(500).parse(request.query.q);
    const limit = z.coerce.number().int().min(1).max(100).default(100).parse(request.query.limit);
    response.json({ results: await repository.searchActivityMemory(query, limit) });
  });

  // Same durable record as /api/activity-memory, but exposing the raw
  // memory-index.ts hybrid-search result shape (per-source-document fields,
  // relevance score, optional `source` filter) instead of the legacy
  // collapsed {source,title,body,createdAt} shape that endpoint preserves
  // for its existing callers.
  router.get('/api/memory/search', async (request, response) => {
    const query = z.string().trim().min(2).max(500).parse(request.query.q);
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(request.query.limit);
    const sourceParam = z.string().trim().min(1).optional().parse(request.query.source);
    const sources = sourceParam ? sourceParam.split(',').map((value) => value.trim()).filter(Boolean) : undefined;
    const matches = await searchMemory(database, query, { limit: limit + 1, sources });
    response.json({ results: matches.slice(0, limit), hasMore: matches.length > limit });
  });

  router.get('/api/shared/messages', (request, response) => {
    const conversationId = z.string().uuid().optional().parse(request.query.conversationId);
    // Recovery of runs whose owner process died is the scheduler's job (lease
    // expiry + reclaimExpired), not this request handler's: canceling anything
    // this process doesn't recognize as "active" would wrongly kill legitimate
    // work owned by another instance, and would fire on every request right
    // after a restart before the scheduler gets a chance to reclaim it properly.
    // A browser on the preview port reads this same live API through a
    // read-only proxy. Its refresh must never be the event that dispatches a
    // queued production agent turn.
    const previewMirror = request.header('X-Workbench-Preview-Mirror') === '1';
    if (!previewMirror && capabilities.executeAgents && conversationId) dispatchNextSharedTurn(repository, conversationId);
    else if (!previewMirror && capabilities.executeAgents) {
      for (const queuedConversationId of repository.listQueuedConversationIds()) dispatchNextSharedTurn(repository, queuedConversationId);
    }
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(request.query.limit);
    const cursor = z.string().optional().parse(request.query.cursor) ?? null;
    try {
      response.json(repository.listSharedMessages(limit, cursor, conversationId));
    } catch {
      response.status(400).json({ error: 'Invalid message cursor.' });
    }
  });

  router.post('/api/shared/messages', (request, response) => {
    const input = createSharedMessageSchema.parse(request.body);
    const attachmentDirectory = resolve('data/attachments');
    mkdirSync(attachmentDirectory, { recursive: true });
    const attachments = input.attachments.map((attachment) => {
      const safeName = basename(attachment.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = resolve(attachmentDirectory, `${randomUUID()}-${safeName}`);
      writeFileSync(path, Buffer.from(attachment.dataBase64, 'base64'));
      return { name: attachment.name, path, mimeType: attachment.mimeType, size: attachment.size };
    });
    if (isRuntimeApproval(input.body)) {
      const message = repository.createSharedMessage('jeffrey', input.body, 'completed', input.conversationId, attachments, 'none');
      const reply = repository.createSharedMessage('system', PROMOTION_QUEUED_MESSAGE, 'queued', input.conversationId, [], 'promotion');
      response.status(202).json({ message, replies: [reply] });
      return;
    }
    const agents = input.dispatchTo === 'both' ? ['codex', 'claude'] as const
      : input.dispatchTo === 'none' ? [] : [input.dispatchTo];
    const message = repository.createSharedMessage('jeffrey', input.body, agents.length ? 'queued' : 'completed', input.conversationId, attachments, input.dispatchTo, input.executionProfile, input.accountProfile ?? null);
    const replies = agents.length ? dispatchNextSharedTurn(repository, input.conversationId) : [];
    // Dispatch claims the queued human turn synchronously. Return the
    // persisted post-dispatch state rather than the pre-claim object; callers
    // use this status to decide whether an explicit interjection is needed.
    response.status(202).json({ message: repository.getSharedMessageById(message.id) ?? message, replies });
  });

  router.patch('/api/shared/messages/:id', (request, response) => {
    const input = updateSharedMessageSchema.parse(request.body);
    const message = repository.updateSharedMessage(request.params.id, input);
    if (!message) return response.status(404).json({ error: 'Shared message not found.' });
    response.json({ message });
  });

  router.get('/api/shared/messages/:id/retrieved-memory', (request, response) => {
    const message = repository.getSharedMessageById(request.params.id);
    if (!message) return response.status(404).json({ error: 'Shared message not found.' });
    response.json({ detail: repository.getRetrievedMemoryDetail(request.params.id) });
  });

  router.post('/api/shared/messages/:id/cancel', (request, response) => {
    const message = cancelSharedReply(repository, request.params.id);
    if (!message) return response.status(404).json({ error: 'Running or queued message not found.' });
    response.json({ message });
  });

  router.post('/api/shared/messages/:id/retry', (request, response) => {
    const prior = repository.getSharedMessageById(request.params.id);
    if (!prior) return response.status(404).json({ error: 'Chat response not found.' });
    if ((prior.author !== 'codex' && prior.author !== 'claude') || (prior.status !== 'failed' && prior.status !== 'canceled')) {
      return response.status(409).json({ error: 'Only failed or canceled agent responses can be continued.' });
    }
    if (repository.getRunByMessage(prior.id)) return response.status(409).json({ error: 'Retry this response from its related task run.' });
    const retryGroup = prior.dispatchGroupId
      ? repository.listAllSharedMessages(prior.conversationId).filter((message) => message.dispatchGroupId === prior.dispatchGroupId && (message.author === 'codex' || message.author === 'claude') && (message.status === 'failed' || message.status === 'canceled'))
      : [prior];
    const retryIds = new Set(retryGroup.map((message) => message.id));
    if (repository.listAllSharedMessages(prior.conversationId).some((message) => !retryIds.has(message.id) && (message.status === 'running' || message.status === 'queued'))) {
      return response.status(409).json({ error: 'Wait for the active response to finish before continuing this one.' });
    }
    const replies = retryGroup.map((message) => {
      const executionProfile = message.executionProfile === 'routing' ? null : message.executionProfile;
      const reply = repository.prepareSharedMessageRetry(message.id);
      if (!reply) return null;
      return executionProfile !== message.executionProfile ? repository.updateSharedMessage(reply.id, { executionProfile }) ?? reply : reply;
    });
    if (replies.some((reply) => !reply)) return response.status(409).json({ error: 'This response is no longer retryable.' });
    for (const reply of replies) void replyInSharedRoom(repository, reply!.author as 'codex' | 'claude', reply!.id);
    response.status(202).json({ reply: replies[0], replies });
  });

  router.post('/api/shared/messages/:id/interject', async (request, response) => {
    const replies = await interjectQueuedSharedMessage(repository, request.params.id);
    if (!replies) return response.status(404).json({ error: 'Queued message not found.' });
    // A queued interjection is intentional, not an error. This happens while
    // Codex is still opening its live turn, and when Claude cannot accept live
    // input; in both cases the original stream continues and the message keeps
    // its priority for automatic delivery or normal dispatch.
    response.status(replies.length ? 200 : 202).json({ replies, pending: !replies.length });
  });

  router.post('/api/shared/messages/:id/create-tasks', (request, response) => {
    try {
      const message = repository.getSharedMessageById(request.params.id);
      const conversation = message && repository.listConversations('all').find((item) => item.id === message.conversationId);
      if (!message || !conversation) return response.status(400).json({ error: 'Message or conversation not found.' });
      const item = conversation.workItemId ? repository.get(conversation.workItemId) : null;
      if (conversation.workItemId && !item) return response.status(404).json({ error: 'Linked task not found.' });
      if (item) {
        const existingPlan = repository.getPendingExecutionPlan(item.id);
        if (existingPlan) return response.json({ plan: existingPlan });
      }
      const existingJob = repository.listSharedMessages(100, null, conversation.id).messages.find((entry) => entry.status === 'running' && entry.author === 'system' && entry.body.startsWith('Turning findings into tasks'));
      if (existingJob) return response.status(202).json({ jobMessage: existingJob });
      const jobMessage = repository.createSharedMessage('system', 'Turning findings into tasks…', 'running', conversation.id);
      void runSharedBackgroundJob(repository, jobMessage.id, async (signal) => {
        const promptPrefix = item
          ? `Original task: ${item.title}\n${item.description}\n\n`
          : '';
        const { output } = await runAgentCommandWithFallback('claude', process.cwd(), `Convert this agent report into independently executable follow-up tasks for Jeffrey's attention stack. Preserve concrete findings, affected files, constraints, and verification in each task. Order tasks by attention. Do not create vague coordination tasks.\n\n${promptPrefix}Report:\n${message.body}\n\nReturn exactly <workbench-plan>{"summary":"...","tasks":[{"title":"...","description":"...","workspacePath":${JSON.stringify(item?.workspacePath ?? null)}}]}</workbench-plan>`, undefined, signal);
        const parsed = parseFollowUpPlan(output);
        if (item) {
          repository.createExecutionPlan(item.id, parsed.summary, parsed.tasks);
        } else {
          for (const task of parsed.tasks) {
            repository.create({
              title: task.title, description: task.description, priority: 2, status: 'ready',
              projectName: null, workspacePath: task.workspacePath ?? null, dueDate: null,
            });
          }
        }
        return `Follow-up task proposal ready: ${parsed.summary}`;
      });
      response.status(202).json({ jobMessage });
    } catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : 'Could not start task extraction.' }); }
  });

  return router;
}
