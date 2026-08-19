import express, { type ErrorRequestHandler } from 'express';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  createActivitySchema,
  createAgentRunSchema,
  createWorkItemSchema,
  generateTaskDraftSchema,
  createQueueProposalSchema,
  createSharedMessageSchema,
  createSharedConversationSchema,
  reorderQueueSchema,
  resolveSourceUrlSchema,
  sourceConnectionInputSchema,
  sourceProviderSchema,
  updateSharedMessageSchema,
  updateWorkItemSchema,
} from '../shared/contracts.js';
import { z } from 'zod';
import type { WorkbenchDatabase } from './database.js';
import { LinearProvider } from './providers/linear.js';
import { WorkItemRepository } from './repository.js';
import { cancelAgentRun, classifyExecution, executeAgentRun, isAgentRunActive, resolveAgents, runAgentCommandWithFallback } from './agent-runner.js';
import { cancelSharedReply, dispatchNextSharedTurn, isSharedReplyActive, runSharedBackgroundJob } from './shared-room.js';
import { resolveSourceUrl } from './source-resolver.js';
import { scanSlackWithCodex } from './slack-codex.js';
import { scanConnectedSources, scanSource } from './source-scanner.js';
import { createAgentDailyProposal } from './daily-planner.js';
import { createSlackAuthorizationUrl, exchangeSlackAuthorization, slackOAuthConfigured } from './slack-mcp.js';
import { createAuthGate } from './auth.js';
import { describeSlackConfig, escapeSlackText, resolveSlackConfig, sendSlackMessage } from './slack-notify.js';

export function createApp(database: WorkbenchDatabase) {
  const app = express();
  const repository = new WorkItemRepository(database);
  app.use(createAuthGate(undefined));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/shared/conversations', (request, response) => {
    repository.ensureDefaultConversation();
    const limit = z.coerce.number().int().min(1).max(100).default(30).parse(request.query.limit);
    const cursor = z.string().optional().parse(request.query.cursor) ?? null;
    response.json(repository.listConversationPage(limit, cursor));
  });

  app.post('/api/shared/conversations', (request, response) => {
    const input = createSharedConversationSchema.parse(request.body);
    response.status(201).json({ conversation: repository.createConversation(input.title) });
  });

  app.delete('/api/shared/conversations/:id', (request, response) => {
    if (!repository.deleteConversation(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
    repository.ensureDefaultConversation();
    response.status(204).end();
  });

  app.get('/api/shared/messages', (request, response) => {
    const conversationId = z.string().uuid().optional().parse(request.query.conversationId);
    for (const message of repository.listSharedMessages(1_000, conversationId).filter((item) => item.status === 'running')) {
      const run = repository.getRunByMessage(message.id);
      if (run && !isAgentRunActive(run.id) && !isSharedReplyActive(message.id)) cancelAgentRun(repository, run.id);
      else if (!run && !isSharedReplyActive(message.id)) cancelSharedReply(repository, message.id);
    }
    response.json({ messages: repository.listSharedMessages(100, conversationId) });
  });

  app.post('/api/shared/messages', (request, response) => {
    const input = createSharedMessageSchema.parse(request.body);
    const attachmentDirectory = resolve('data/attachments');
    mkdirSync(attachmentDirectory, { recursive: true });
    const attachments = input.attachments.map((attachment) => {
      const safeName = basename(attachment.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = resolve(attachmentDirectory, `${randomUUID()}-${safeName}`);
      writeFileSync(path, Buffer.from(attachment.dataBase64, 'base64'));
      return { name: attachment.name, path, mimeType: attachment.mimeType, size: attachment.size };
    });
    const agents = input.dispatchTo === 'both' ? ['codex', 'claude'] as const
      : input.dispatchTo === 'none' ? [] : [input.dispatchTo];
    const message = repository.createSharedMessage('jeffrey', input.body, agents.length ? 'queued' : 'completed', input.conversationId, attachments, input.dispatchTo);
    const replies = agents.length ? dispatchNextSharedTurn(repository, input.conversationId) : [];
    response.status(202).json({ message, replies });
  });

  app.patch('/api/shared/messages/:id', (request, response) => {
    const input = updateSharedMessageSchema.parse(request.body);
    const message = repository.updateSharedMessage(request.params.id, input);
    if (!message) return response.status(404).json({ error: 'Shared message not found.' });
    response.json({ message });
  });

  app.post('/api/shared/messages/:id/cancel', (request, response) => {
    const message = cancelSharedReply(repository, request.params.id);
    if (!message) return response.status(404).json({ error: 'Running response not found.' });
    response.json({ message });
  });

  app.post('/api/shared/messages/:id/create-tasks', (request, response) => {
    try {
      const message = repository.listSharedMessages(1_000).find((item) => item.id === request.params.id);
      const conversation = message && repository.listConversations().find((item) => item.id === message.conversationId);
      if (!message || !conversation?.workItemId) return response.status(400).json({ error: 'This report is not linked to a task execution.' });
      const item = repository.get(conversation.workItemId);
      if (!item) return response.status(404).json({ error: 'Linked task not found.' });
      const existingPlan = repository.getPendingExecutionPlan(item.id);
      if (existingPlan) return response.json({ plan: existingPlan });
      const existingJob = repository.listSharedMessages(100, conversation.id).find((entry) => entry.status === 'running' && entry.author === 'system' && entry.body.startsWith('Turning findings into tasks'));
      if (existingJob) return response.status(202).json({ jobMessage: existingJob });
      const jobMessage = repository.createSharedMessage('system', 'Turning findings into tasks…', 'running', conversation.id);
      void runSharedBackgroundJob(repository, jobMessage.id, async (signal, onProgress) => {
        const { output } = await runAgentCommandWithFallback('claude', process.cwd(), `Convert this agent report into independently executable follow-up tasks for Jeffrey's attention stack. Preserve concrete findings, affected files, constraints, and verification in each task. Order tasks by attention. Do not create vague coordination tasks.\n\nOriginal task: ${item.title}\n${item.description}\n\nReport:\n${message.body}\n\nReturn exactly <workbench-plan>{"summary":"...","tasks":[{"title":"...","description":"...","workspacePath":${JSON.stringify(item.workspacePath)}}]}</workbench-plan>`, onProgress, signal);
        const match = output.match(/<workbench-plan>([\s\S]*?)<\/workbench-plan>/);
        if (!match) throw new Error('Agent did not return a valid follow-up task plan.');
        const parsed = JSON.parse(match[1]) as { summary: string; tasks: Array<{ title: string; description: string; workspacePath: string | null }> };
        repository.createExecutionPlan(item.id, parsed.summary, parsed.tasks);
        return `Follow-up task proposal ready: ${parsed.summary}`;
      });
      response.status(202).json({ jobMessage });
    } catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : 'Could not start task extraction.' }); }
  });

  app.get('/api/work-items', (request, response) => {
    const view = request.query.view === 'archive' ? 'archive' : 'active';
    const limit = Number(request.query.limit ?? 50);
    if (!Number.isFinite(limit)) return response.status(400).json({ error: 'Invalid page limit.' });
    response.json(repository.listPage(view, limit, typeof request.query.cursor === 'string' ? request.query.cursor : null, typeof request.query.query === 'string' ? request.query.query : ''));
  });

  app.get('/api/work-item-counts', (_request, response) => {
    response.json(repository.getWorkItemCounts());
  });

  app.get('/api/work-items-archive', (_request, response) => {
    response.json({ items: repository.listArchived() });
  });

  app.put('/api/queue/order', (request, response) => {
    const input = reorderQueueSchema.parse(request.body);
    response.json({ items: repository.move(input.itemId, input) });
  });

  app.post('/api/queue/proposals', (request, response) => {
    const input = createQueueProposalSchema.parse(request.body);
    response.status(201).json({ proposal: repository.createProposal(input.orderedItemIds, input.rationale) });
  });

  app.post('/api/queue/plan', async (_request, response, next) => {
    try {
      const config = repository.getLinearConfig();
      if (process.env.LINEAR_API_KEY && config.teamIds.length) {
        const provider = new LinearProvider(process.env.LINEAR_API_KEY, config.teamIds, config.projectIds);
        for (const issue of await provider.fetchOpenIssues()) repository.upsertLinearItem(issue);
      }
      const scan = await scanConnectedSources(repository);
      if (!repository.listSourceConnections().some((connection) => connection.provider === 'slack')) {
        try {
          scan.signals.push(...await scanSlackWithCodex());
        } catch (error) {
          scan.errors.push(`slack: ${error instanceof Error ? error.message : 'Codex-hosted scan failed.'}`);
        }
      }
      const linearSignals = repository.list().filter((item) => item.source === 'linear').map((item) => ({
        provider: 'linear', title: `${item.sourceIdentifier}: ${item.title}`,
        summary: `Status: ${item.status}; due: ${item.dueDate ?? 'none'}\n${item.description}`,
        url: item.sourceUrl, occurredAt: item.providerUpdatedAt,
      }));
      const signals = [...linearSignals, ...scan.signals];
      const proposal = await createAgentDailyProposal(repository, signals, scan.errors);
      response.status(201).json({ proposal, items: repository.list(), scan: { ...scan, signals } });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/integrations/slack', (_request, response) => {
    response.json({ notifications: describeSlackConfig() });
  });

  app.post('/api/integrations/slack/test', async (request, response, next) => {
    try {
      const input = z.object({ message: z.string().trim().max(2_000).default('') }).parse(request.body ?? {});
      const status = describeSlackConfig();
      if (!status.configured) return response.status(400).json({ error: status.problem });
      const body = input.message || 'Workbench outbound Slack notifications are configured and working.';
      // A workflow trigger renders its variable literally, so mrkdwn would show as punctuation.
      const text = resolveSlackConfig()?.mode === 'workflow'
        ? `:satellite_antenna: Workbench test message\n${body}`
        : `:satellite_antenna: *Workbench test message*\n${escapeSlackText(body)}`;
      const result = await sendSlackMessage(text);
      if (!result.ok) return response.status(502).json({ error: result.error, mode: result.mode, attempts: result.attempts });
      response.json({ delivered: true, mode: result.mode, channel: result.channel, attempts: result.attempts });
    } catch (error) { next(error); }
  });

  app.get('/api/source-connections', (_request, response) => {
    response.json({ connections: repository.listSourceConnections(), slackOAuthConfigured: slackOAuthConfigured() });
  });

  app.get('/api/source-connections/slack/oauth/start', (_request, response, next) => {
    try { response.json({ url: createSlackAuthorizationUrl() }); } catch (error) { next(error); }
  });

  app.get('/api/source-connections/slack/oauth/callback', async (request, response) => {
    try {
      const error = z.string().optional().parse(request.query.error);
      if (error) throw new Error(`Slack authorization failed: ${error}`);
      const code = z.string().min(1).parse(request.query.code);
      const state = z.string().min(1).parse(request.query.state);
      const auth = await exchangeSlackAuthorization(code, state);
      repository.setSourceConnection('slack', auth.label, { accessToken: auth.accessToken, query: 'to:me' });
      const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:5173';
      response.type('html').send(`<!doctype html><title>Slack connected</title><script>window.opener?.postMessage({type:'workbench:slack-connected'},${JSON.stringify(appOrigin)});window.close()</script><p>Slack is connected. You can close this window.</p>`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Slack authorization failed.';
      response.status(400).type('html').send(`<p>Slack connection failed: ${message.replace(/[<>&]/g, '')}</p>`);
    }
  });

  app.put('/api/source-connections/:provider', async (request, response, next) => {
    try {
      const provider = sourceProviderSchema.parse(request.params.provider);
      const input = sourceConnectionInputSchema.parse({ ...request.body, provider });
      const signals = await scanSource(provider, input.settings);
      const connection = repository.setSourceConnection(provider, input.label, input.settings);
      repository.updateSourceScan(provider, null);
      response.json({ connection: { ...connection, lastScannedAt: new Date().toISOString() }, sampleCount: signals.length });
    } catch (error) { next(error); }
  });

  app.delete('/api/source-connections/:provider', (request, response) => {
    const provider = sourceProviderSchema.parse(request.params.provider);
    repository.removeSourceConnection(provider);
    response.status(204).end();
  });

  app.post('/api/queue/proposals/:id/:resolution', (request, response) => {
    const resolution = z.enum(['accepted', 'rejected']).parse(request.params.resolution);
    const proposal = repository.resolveProposal(request.params.id, resolution);
    if (!proposal) return response.status(404).json({ error: 'Pending proposal not found.' });
    response.json({ proposal, items: repository.list() });
  });

  app.get('/api/work-items/:id', (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item, parentItem: item.parentWorkItemId ? repository.get(item.parentWorkItemId) : null, activity: repository.listActivity(item.id), runs: repository.listRuns(item.id), executionPlan: repository.getPendingExecutionPlan(item.id) });
  });

  app.post('/api/work-items', (request, response) => {
    const input = createWorkItemSchema.parse(request.body);
    response.status(201).json({ item: repository.create(input) });
  });

  app.post('/api/work-items/:id/follow-ups', (request, response) => {
    const input = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(20_000).default('') }).parse(request.body);
    const item = repository.createFollowUp(request.params.id, input.title, input.description);
    if (!item) return response.status(404).json({ error: 'Parent task not found.' });
    response.status(201).json({ item });
  });

  app.post('/api/work-items/generate-draft', async (request, response, next) => {
    try {
      const input = generateTaskDraftSchema.parse(request.body);
      const { output } = await runAgentCommandWithFallback('claude', process.cwd(), `Turn Jeffrey's rough task description into one independently executable Workbench task. Infer only what is strongly supported. Preserve every supplied link, constraint, expected outcome, and relevant detail. The description must give a future agent enough context to execute without asking what the task means. Include explicit verification when it is inferable. Do not invent acceptance criteria or claim facts not present in the input.\n\nShared working context:\n${repository.getSharedContext()}\n\nRough description:\n${input.prompt}\n\nReturn exactly: <task-draft>{"title":"concise action-oriented title","description":"self-contained task context and outcome","projectName":null,"workspacePath":null}</task-draft>`);
      const match = output.match(/<task-draft>([\s\S]*?)<\/task-draft>/);
      if (!match) throw new Error('AI did not return a valid task draft.');
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      if (typeof parsed.title !== 'string' || typeof parsed.description !== 'string') throw new Error('AI returned an incomplete task draft.');
      response.json({ draft: {
        title: parsed.title, description: parsed.description,
        projectName: typeof parsed.projectName === 'string' ? parsed.projectName : null,
        workspacePath: typeof parsed.workspacePath === 'string' ? parsed.workspacePath : null,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/sources/resolve', async (request, response, next) => {
    try {
      const input = resolveSourceUrlSchema.parse(request.body);
      response.json({ draft: await resolveSourceUrl(input.url) });
    } catch (error) { next(error); }
  });

  app.patch('/api/work-items/:id', (request, response) => {
    const input = updateWorkItemSchema.parse(request.body);
    const item = repository.update(request.params.id, input);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  app.post('/api/work-items/:id/archive', (request, response) => {
    const item = repository.archive(request.params.id, false);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  app.post('/api/work-items/:id/complete', (request, response) => {
    const item = repository.archive(request.params.id, true);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  app.delete('/api/work-items/:id', (request, response) => {
    if (!repository.delete(request.params.id)) return response.status(404).json({ error: 'Work item not found.' });
    response.status(204).end();
  });

  app.post('/api/work-items/:id/activity', (request, response) => {
    if (!repository.get(request.params.id)) {
      return response.status(404).json({ error: 'Work item not found.' });
    }
    const input = createActivitySchema.parse(request.body);
    response.status(201).json({ activity: repository.addActivity(request.params.id, input.actor, input.kind, input.body) });
  });

  app.post('/api/work-items/:id/runs', (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    const input = createAgentRunSchema.parse(request.body);
    const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
    repository.createSharedMessage('system', `Requested ${input.kind}: ${input.instructions || item.description}`, 'completed', conversation.id);
    const resolvedAgents = resolveAgents(input.kind, input.target);
    const agents = input.target === 'auto' ? [repository.selectBalancedAgent(resolvedAgents[0])] : resolvedAgents;
    const runs = agents.map((agent) =>
      repository.createRun(item.id, input.kind, input.target, agent, input.instructions, conversation.id, repository.createSharedMessage(agent, '', 'running', conversation.id).id),
    );
    for (const run of runs) void executeAgentRun(repository, run);
    response.status(202).json({ runs });
  });

  app.post('/api/agent-runs/:id/cancel', (request, response) => {
    const run = cancelAgentRun(repository, request.params.id);
    if (!run) return response.status(404).json({ error: 'Active agent run not found.' });
    response.json({ run });
  });

  app.post('/api/work-items/:id/execute', (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    const classified = classifyExecution(item);
    const explicitlyAssigned = repository.getExplicitAgentAssignees(item.id);
    const agents = explicitlyAssigned.length ? explicitlyAssigned : [repository.selectBalancedAgent(classified.agent)];
    const classification = { ...classified, agent: agents[0] };
    if (!explicitlyAssigned.length) repository.updateAutomaticAgentAssignees(item.id, agents);
    const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
    repository.createSharedMessage('system', `Execute: ${item.title}`, 'completed', conversation.id);
    const runs = agents.map((agent) => {
      const reply = repository.createSharedMessage(agent, '', 'running', conversation.id);
      return repository.createRun(item.id, classification.kind, explicitlyAssigned.length ? agent : 'auto', agent, classification.instructions, conversation.id, reply.id);
    });
    for (const run of runs) void executeAgentRun(repository, run);
    response.status(202).json({ run: runs[0], runs, classification, conversation });
  });

  app.post('/api/execution-plans/:id/:resolution', (request, response) => {
    const resolution = z.enum(['accepted', 'rejected']).parse(request.params.resolution);
    const { selectedTaskIndexes } = z.object({ selectedTaskIndexes: z.array(z.number().int().nonnegative()).optional() }).parse(request.body ?? {});
    const plan = repository.resolveExecutionPlan(request.params.id, resolution, selectedTaskIndexes);
    if (!plan) return response.status(404).json({ error: 'Pending execution plan not found.' });
    response.json({ plan, items: repository.list() });
  });

  app.post('/api/providers/linear/sync', async (_request, response, next) => {
    try {
      const provider = new LinearProvider(
        process.env.LINEAR_API_KEY ?? '',
        repository.getLinearConfig().teamIds,
        repository.getLinearConfig().projectIds,
      );
      const issues = await provider.fetchOpenIssues();
      const counts = { imported: 0, updated: 0, skipped: 0 };
      for (const issue of issues) counts[repository.upsertLinearItem(issue)] += 1;
      response.json({ ...counts, syncedAt: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/providers/linear/search', async (request, response, next) => {
    try {
      const query = z.string().trim().min(1).max(500).parse(request.query.q);
      let items = repository.searchLinear(query);
      const identifier = query.match(/(?:\/issue\/)?([A-Za-z]+-\d+)/i)?.[1]?.toUpperCase();
      if (items.length === 0 && identifier) {
        const provider = new LinearProvider(process.env.LINEAR_API_KEY ?? '');
        repository.upsertLinearItem(await provider.fetchIssue(identifier));
        items = repository.searchLinear(identifier);
      }
      response.json({ items });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/providers/linear/queue/:id', (request, response) => {
    const item = repository.queueLinearItem(request.params.id);
    if (!item) return response.status(404).json({ error: 'Linear issue not found.' });
    response.json({ item });
  });

  app.get('/api/providers/linear/teams', async (_request, response, next) => {
    try {
      const provider = new LinearProvider(process.env.LINEAR_API_KEY ?? '');
      response.json({ teams: await provider.fetchTeams(), config: repository.getLinearConfig() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/providers/linear/teams/:id/projects', async (request, response, next) => {
    try {
      const provider = new LinearProvider(process.env.LINEAR_API_KEY ?? '');
      response.json({ projects: await provider.fetchTeamProjects(request.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/providers/linear/config', (request, response) => {
    const config = z.object({
      teamIds: z.array(z.string()).max(100),
      projectIds: z.array(z.string()).max(250),
    }).parse(request.body);
    response.json({ config: repository.setLinearConfig(config) });
  });

  const clientPath = resolve('dist/client');
  if (existsSync(clientPath)) {
    app.use(express.static(clientPath));
    app.get('*splat', (_request, response) => response.sendFile(resolve(clientPath, 'index.html')));
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    if (error instanceof ZodError) {
      response.status(400).json({ error: 'Invalid request.', details: error.issues });
      return;
    }
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error.' });
  };
  app.use(errorHandler);
  return app;
}
