import { Router } from 'express';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createSessionFeedbackSchema, createSharedConversationSchema, createSharedMessageSchema, setConversationPinnedSchema, setConversationTaskSchema, updateSharedBriefSchema, updateSharedConversationDraftSchema, updateSharedMessageSchema, upsertDiffHunkReviewsSchema } from '../../shared/contracts.js';
import type { AgentRun, SharedMessage } from '../../shared/contracts.js';
import { runAgentCommandWithFallback } from '../agent-runner.js';
import { searchMemory } from '../memory-index.js';
import { cancelSharedReply, dispatchNextSharedTurn, interjectQueuedSharedMessage, replyInSharedRoom, resolveSharedReplyWorkingDirectory, runSharedBackgroundJob } from '../shared-room.js';
import { commitAndPushWorkspace, getWorkspaceDiff, getWorkspaceDiffRevision, getWorkspaceHeadCommit } from '../workspace-diff.js';
import { captureRecordedWorkspaceDiffSnapshots } from '../workspace-diff-history.js';
import { parseFollowUpPlan } from '../app-exports.js';
import { isRuntimeApproval } from '../runtime-promotion.js';
import { PROMOTION_QUEUED_MESSAGE } from '../promotion-messages.js';
import type { RouteContext } from '../route-context.js';

export function createConversationRouter({ repository, database, capabilities, admin }: RouteContext) {
  const router = Router();
  const unpinConversationAndLinkedItem = (conversationId: string) => repository.unpinConversationAndLinkedItem(conversationId);
  const conversationWorkspaces = (conversationId: string) => {
    const conversation = repository.getConversation(conversationId);
    if (!conversation) return null;
    const linkedItem = conversation.workItemId ? repository.get(conversation.workItemId) : null;
    // A conversation can be linked to an imported/ad-hoc task before the
    // task itself has a workspacePath. Its completed or active agent run has
    // already resolved the repository it actually used; Changes must follow
    // that real workspace instead of incorrectly demanding a manual picker.
    // Run worktrees are deliberately short-lived. Never let a completed run
    // whose worktree has already been integrated and collected become the
    // selected repository for Changes.
    const usableWorkspace = (workspacePath: string | null | undefined) => {
      if (!workspacePath) return null;
      const path = resolve(workspacePath);
      try { return existsSync(path) && statSync(path).isDirectory() ? path : null; }
      catch { return null; } // The collector may remove a run worktree mid-request.
    };
    const isRunWorktree = (workspacePath: string | null) => Boolean(workspacePath?.includes('/.workbench/run-worktrees/'));
    const conversationRuns = linkedItem
      ? repository.listRuns(linkedItem.id).filter((run) => run.conversationId === conversationId && (run.status === 'queued' || run.status === 'running') && usableWorkspace(run.resolvedWorkspace))
      : [];
    const activeRunWorkspace = conversationRuns
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.resolvedWorkspace ?? null;
    const selected = database.prepare('SELECT workspace_path FROM shared_conversation_workspace_selection WHERE conversation_id = ?').get(conversationId) as { workspace_path: string } | undefined;
    const root = dirname(process.cwd());
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .filter((path) => existsSync(join(path, '.git')) || existsSync(join(path, 'package.json')))
      .map((path) => resolve(path));
    const sourcePath = usableWorkspace(linkedItem?.workspacePath);
    const activePath = usableWorkspace(activeRunWorkspace);
    const linkedPath = activePath ?? sourcePath;
    if (linkedPath && !candidates.includes(linkedPath)) candidates.unshift(linkedPath);
    const defaultPath = linkedPath ?? (!linkedItem || linkedItem.projectName === 'Workbench' ? resolve(process.cwd()) : null);
    // An active run is authoritative: its uncommitted files live in a detached
    // worktree, so a prior source-checkout selection must not hide them.
    // Completed runs are integrated or recorded as snapshots. They must not
    // keep an old worktree selected after the run exits.
    const savedPath = usableWorkspace(selected?.workspace_path);
    const savedPathIsUsable = Boolean(savedPath && candidates.includes(savedPath) && !isRunWorktree(savedPath));
    const selectedPath = linkedPath ?? (savedPathIsUsable ? savedPath : defaultPath);
    // A stored choice may point to a garbage-collected run worktree. Repair
    // it server-side so every client converges on the usable checkout.
    if (selected && !savedPathIsUsable) {
      if (selectedPath) database.prepare(`INSERT INTO shared_conversation_workspace_selection (conversation_id, workspace_path, updated_at)
        VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`)
        .run(conversationId, selectedPath, new Date().toISOString());
      else database.prepare('DELETE FROM shared_conversation_workspace_selection WHERE conversation_id = ?').run(conversationId);
    }
    return { selectedPath, workspaces: candidates.map((path) => ({ path, label: path === linkedPath ? `${basename(sourcePath ?? path)} · agent worktree` : basename(path), selected: path === selectedPath })) };
  };
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

  const conversationWorkingDirectory = (conversationId: string) => {
    const explorer = conversationWorkspaces(conversationId);
    return explorer?.selectedPath ?? null;
  };

  router.get('/api/shared/conversations/:id/workspaces', (request, response) => {
    const explorer = conversationWorkspaces(request.params.id);
    if (!explorer) return response.status(404).json({ error: 'Conversation not found.' });
    response.json(explorer);
  });
  router.put('/api/shared/conversations/:id/workspaces/selection', (request, response) => {
    const explorer = conversationWorkspaces(request.params.id);
    if (!explorer) return response.status(404).json({ error: 'Conversation not found.' });
    const workspacePath = resolve(z.object({ workspacePath: z.string().trim().min(1).max(1_000) }).parse(request.body).workspacePath);
    if (!explorer.workspaces.some((workspace) => workspace.path === workspacePath) || !existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
      return response.status(400).json({ error: 'Select a repository from this local workspace.' });
    }
    database.prepare(`INSERT INTO shared_conversation_workspace_selection (conversation_id, workspace_path, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`)
      .run(request.params.id, workspacePath, new Date().toISOString());
    response.json({ selectedPath: workspacePath, workspaces: explorer.workspaces.map((workspace) => ({ ...workspace, selected: workspace.path === workspacePath })) });
  });

  router.get('/api/shared/conversations/:id/workspace-diff', async (request, response, next) => {
    try {
      const workingDirectory = conversationWorkingDirectory(request.params.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      const [diff, commitHash] = await Promise.all([getWorkspaceDiff(workingDirectory), getWorkspaceHeadCommit(workingDirectory)]);
      if (diff.changedFiles > 0) repository.captureWorkspaceDiffSnapshot({ conversationId: request.params.id }, diff, { originatingAgentRunId: repository.latestAgentRunForSnapshot({ conversationId: request.params.id })?.id ?? null, commitHash });
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
      const { revision, message } = z.object({ revision: z.string().trim().min(1), message: z.string().trim().min(1).optional() }).parse(request.body);
      const conversation = repository.getConversation(request.params.id)!;
      const result = await commitAndPushWorkspace(workingDirectory, message ?? `chore: ${conversation.title}`, revision);
      response.json({ result });
    } catch (error) { next(error); }
  });

  router.get('/api/shared/conversations/:id/workspace-diff/hunk-reviews', (request, response, next) => {
    try {
      if (!conversationWorkingDirectory(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
      const revision = z.string().trim().min(1).parse(request.query.revision);
      response.json({ reviews: repository.listDiffHunkReviews({ conversationId: request.params.id }, revision) });
    } catch (error) { next(error); }
  });
  router.put('/api/shared/conversations/:id/workspace-diff/hunk-reviews', (request, response, next) => {
    try {
      if (!conversationWorkingDirectory(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
      const input = z.object({
        revision: z.string().trim().min(1),
        filePath: z.string().trim().min(1),
        hunkRange: z.string().trim().min(1),
        state: z.enum(['reviewed', 'needs_changes', 'commented']),
        note: z.string().trim().min(1).optional(),
      }).parse(request.body);
      response.json({ review: repository.upsertDiffHunkReview({ conversationId: request.params.id }, input) });
    } catch (error) { next(error); }
  });
  router.put('/api/shared/conversations/:id/workspace-diff/hunk-reviews/batch', (request, response, next) => {
    try {
      if (!conversationWorkingDirectory(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
      const input = upsertDiffHunkReviewsSchema.parse(request.body);
      response.json({ reviews: repository.upsertDiffHunkReviews({ conversationId: request.params.id }, input) });
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
    const restored = repository.setConversationArchived(request.params.id, false);
    if (!restored) return response.status(404).json({ error: 'Conversation not found.' });
    unpinConversationAndLinkedItem(restored.id);
    const conversation = repository.getConversation(restored.id) ?? restored;
    response.json({ conversation });
  });

  router.patch('/api/shared/conversations/:id/preferences', (request, response) => {
    const preferences = z.object({
      executionProfile: z.enum(['economy', 'standard', 'deep']).nullable().optional(),
      accountProfile: z.string().trim().min(1).max(120).nullable().optional(),
      dispatchTarget: z.enum(['both', 'codex', 'claude']).nullable().optional(),
    }).refine((value) => Object.values(value).some((entry) => entry !== undefined), 'Choose at least one preference.').parse(request.body);
    const conversation = repository.setConversationComposerPreferences(request.params.id, {
      ...(preferences.executionProfile === undefined ? {} : { preferredExecutionProfile: preferences.executionProfile }),
      ...(preferences.accountProfile === undefined ? {} : { preferredAccountProfile: preferences.accountProfile }),
      ...(preferences.dispatchTarget === undefined ? {} : { preferredDispatchTarget: preferences.dispatchTarget }),
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

  router.patch('/api/shared/conversations/:id/pin', (request, response) => {
    const { pinned } = setConversationPinnedSchema.parse(request.body);
    const conversation = repository.setConversationPinned(request.params.id, pinned);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
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
    const activityOnly = z.literal('1').optional().parse(request.query.activity);
    if (activityOnly) return response.json({ messages: repository.listSharedMessageActivity() });
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
    if (agents.length) unpinConversationAndLinkedItem(input.conversationId);
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

  router.post('/api/shared/messages/:id/retry', async (request, response) => {
    const prior = repository.getSharedMessageById(request.params.id);
    if (!prior) return response.status(404).json({ error: 'Chat response not found.' });
    if ((prior.author !== 'codex' && prior.author !== 'claude') || (prior.status !== 'failed' && prior.status !== 'canceled')) {
      return response.status(409).json({ error: 'Only failed or canceled agent responses can be continued.' });
    }
    // A retry button owns exactly the response it is rendered on. A paired
    // Codex/Claude dispatch has two independently cancellable/retryable
    // streams; reopening every terminal sibling here meant the first click
    // silently consumed both and the second click got a misleading 409.
    const targets = [prior];

    // The terminal message is the retry lock: prepareSharedMessageRetry and
    // prepareRunRetry both conditionally reopen only failed/canceled rows.
    // Do not turn another live reply in this conversation into a global lock.
    // That rejected valid retries after an unrelated follow-up had already
    // started, while a repeat click on this exact message remains atomic.

    const replies = [] as SharedMessage[];
    const runs = [] as AgentRun[];
    for (const target of targets) {
      const linkedRun = repository.getRunByMessage(target.id);
      if (linkedRun) {
        const retried = await admin.retryRun(linkedRun.id, { force: false });
        if ('body' in retried) return response.status(retried.status).json(retried.body);
        const reply = repository.getSharedMessageById(target.id);
        if (!reply) return response.status(409).json({ error: 'Retry did not restore its conversation reply.' });
        replies.push(reply);
        runs.push(retried.run);
        continue;
      }
      const executionProfile = target.executionProfile === 'routing' ? null : target.executionProfile;
      const reply = repository.prepareSharedMessageRetry(target.id);
      if (!reply) return response.status(409).json({ error: 'This response is no longer retryable.' });
      replies.push(executionProfile !== target.executionProfile ? repository.updateSharedMessage(reply.id, { executionProfile }) ?? reply : reply);
    }
    for (const reply of replies.filter((reply) => !repository.getRunByMessage(reply.id))) void replyInSharedRoom(repository, reply.author as 'codex' | 'claude', reply.id);
    response.status(202).json({ reply: replies[0], replies, runs });
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
