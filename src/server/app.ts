import express, { type ErrorRequestHandler, type Response } from 'express';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  createActivitySchema,
  bulkDiscoveryActionSchema,
  createAgentRunSchema,
  createArtifactCommentSchema,
  updateArtifactSchema,
  artifactLibraryViewSchema,
  createWorkItemReferenceSchema,
  createWorkItemSchema,
  generateTaskDraftSchema,
  createQueueProposalSchema,
  createSharedMessageSchema,
  createSharedConversationSchema,
  createMemorySchema,
  listMemoriesQuerySchema,
  supersedeMemorySchema,
  updateMemorySchema,
  reorderQueueSchema,
  runKindSchema,
  resolveSourceUrlSchema,
  searchSourcesSchema,
  sourceProviderSchema,
  updateSharedMessageSchema,
  updateDiscoveryCandidateSchema,
  resolveDiscoveryCandidateSchema,
  updateWorkItemSchema,
} from '../shared/contracts.js';
import { z } from 'zod';
import type { WorkbenchDatabase } from './database.js';
import { LinearProvider } from './providers/linear.js';
import { WorkItemRepository } from './repository.js';
import { cancelAgentRun, classificationForKind, classifyExecutionRobust, executeAgentRun, resolveAgents, resolveWorkingDirectory, runAgentCommandWithFallback } from './agent-runner.js';
import { cancelSharedReply, dispatchNextSharedTurn, interjectQueuedSharedMessage, runSharedBackgroundJob } from './shared-room.js';
import { createAuthGate } from './auth.js';
import { describeSlackConfig, escapeSlackText, resolveSlackConfig, sendSlackMessage } from './slack-notify.js';
import { finishRemoteMcpOAuth, startRemoteMcpOAuth } from './remote-mcp.js';
import { contextForPrompt, listBrokerConnections, resolveBrokerUrl, searchBrokerSources } from './connection-broker.js';
import { artifactContentHash, CloudflarePagesPublisher, createArtifactId } from './artifact-publisher.js';
import { ArtifactLibrary, artifactFeedbackConfig, createCommentRateLimiter } from './artifact-library.js';
import { runDiscovery, shouldRunDiscoveryCatchUp } from './discovery.js';
import { isRuntimeApproval, promoteRuntime } from './runtime-promotion.js';
import { isArtifactAllowed } from './artifact-access.js';
import { LEASE_MS, OWNER_ID } from './scheduler.js';
import { createWorkbenchMcpHandler, rejectUnsupportedMcpMethod } from './workbench-mcp.js';

export function createApp(database: WorkbenchDatabase) {
  const app = express();
  const repository = new WorkItemRepository(database);
  const artifactPublisher = new CloudflarePagesPublisher();
  const artifacts = new ArtifactLibrary(database);
  const allowComment = createCommentRateLimiter();
  app.use(createAuthGate(undefined));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.post('/mcp', createWorkbenchMcpHandler(repository));
  app.get('/mcp', rejectUnsupportedMcpMethod);
  app.delete('/mcp', rejectUnsupportedMcpMethod);

  app.get('/api/discovery', (request, response) => {
    const view = z.enum(['pending', 'reviewed']).catch('pending').parse(request.query.view);
    response.json(repository.getDiscoveryInbox(view));
  });

  app.post('/api/discovery/scan', (_request, response) => {
    const inbox = repository.getDiscoveryInbox();
    if (!inbox.running) void runDiscovery(repository).catch((error) => console.error('Discovery scan failed:', error));
    response.status(202).json({ started: !inbox.running });
  });

  app.post('/api/discovery/:id/restore', (request, response) => {
    const candidate = repository.restoreDiscoveryCandidate(request.params.id);
    if (!candidate) return response.status(409).json({ error: 'Only dismissed or snoozed discoveries can be restored.' });
    response.json({ candidate });
  });

  app.post('/api/discovery/:id/:action', (request, response) => {
    const action = z.enum(['convert', 'dismiss', 'snooze', 'merge']).parse(request.params.action);
    const body = resolveDiscoveryCandidateSchema.parse(request.body ?? {});
    const candidate = repository.resolveDiscoveryCandidate(request.params.id, action, body.workItemId);
    if (!candidate) return response.status(404).json({ error: 'Discovery candidate not found.' });
    response.json({ candidate, item: candidate.workItemId ? repository.get(candidate.workItemId) : null });
  });

  app.patch('/api/discovery/:id', (request, response) => {
    const candidate = repository.updateDiscoveryCandidate(request.params.id, updateDiscoveryCandidateSchema.parse(request.body));
    if (!candidate) return response.status(404).json({ error: 'Pending discovery candidate not found.' });
    response.json({ candidate });
  });

  app.post('/api/discovery/bulk', (request, response) => {
    const input = bulkDiscoveryActionSchema.parse(request.body);
    response.json({ candidates: repository.resolveDiscoveryCandidates(input.ids, input.action) });
  });

  setTimeout(() => {
    const lastRun = repository.getDiscoveryInbox().lastRun?.completedAt ?? null;
    if (shouldRunDiscoveryCatchUp(lastRun)) void runDiscovery(repository).catch((error) => console.error('Discovery catch-up failed:', error));
  }, 1_500).unref();

  app.get('/api/artifacts/open', (request, response) => {
    const input = z.object({
      path: z.string().min(1).max(8_000),
      conversationId: z.string().uuid().optional(),
      workItemId: z.string().uuid().optional(),
    }).parse(request.query);
    const conversation = input.conversationId
      ? repository.listConversations('all').find((entry) => entry.id === input.conversationId)
      : null;
    const item = repository.get(input.workItemId ?? conversation?.workItemId ?? '');
    const workspace = realpathSync(item ? resolveWorkingDirectory(item) : process.cwd());
    let requestedPath = input.path.replace(/^file:\/\//, '');
    let candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspace, requestedPath);
    if (!existsSync(candidate)) {
      requestedPath = requestedPath.replace(/:(\d+)(?::\d+)?$/, '');
      candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspace, requestedPath);
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return response.status(404).json({ error: 'Artifact file not found.' });
    const realCandidate = realpathSync(candidate);
    if (!isArtifactAllowed(realCandidate, workspace)) return response.status(403).json({ error: 'Artifact is outside the allowed development roots.' });
    if (['.html', '.htm'].includes(extname(realCandidate).toLowerCase())) {
      const rawQuery = new URLSearchParams({ path: input.path });
      if (input.conversationId) rawQuery.set('conversationId', input.conversationId);
      if (input.workItemId) rawQuery.set('workItemId', input.workItemId);
      const publishInput = JSON.stringify({ path: input.path, conversationId: input.conversationId, workItemId: input.workItemId, title: basename(realCandidate).replace(/\.[^.]+$/, '') }).replace(/</g, '\\u003c');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      return response.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${basename(realCandidate).replace(/[&<>"']/g, '')}</title><style>*{box-sizing:border-box}html,body{height:100%;margin:0;background:#0e0e0d;color:#e8e7df;font-family:ui-sans-serif,system-ui,sans-serif}body{display:grid;grid-template-rows:52px minmax(0,1fr)}header{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#151513;border-bottom:1px solid #32322e}strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}button,a{padding:8px 12px;border-radius:7px;font-weight:700;text-decoration:none;cursor:pointer}button{margin-left:auto;color:#111;background:#c6f432;border:0}button:disabled{color:#777;background:#2b2b28;cursor:wait}a{display:none;color:#d7d6cf;background:#282824;border:1px solid #41413b}#revoke{display:none;margin-left:0;color:#ef8888;background:transparent;border:1px solid #5b3535}span{color:#aaa;font-size:12px}iframe{width:100%;height:100%;border:0;background:#fff}@media(max-width:520px){strong{font-size:11px}header{gap:7px;padding-inline:9px}button,a{padding:7px 9px;font-size:11px}#status{display:none}}</style></head><body><header><strong>${basename(realCandidate).replace(/[&<>"']/g, '')}</strong><span id="status">Checking publication…</span><button id="share" type="button" disabled>Share</button><a id="published" target="_blank" rel="noreferrer">Open shared page</a><button id="revoke" type="button">Revoke</button></header><iframe title="Artifact preview" sandbox="allow-scripts allow-same-origin" src="/api/artifacts/raw?${rawQuery.toString()}"></iframe><script>const input=${publishInput};const query=new URLSearchParams(Object.entries(input).filter(([,value])=>value));const button=document.querySelector('#share');const status=document.querySelector('#status');const link=document.querySelector('#published');const revoke=document.querySelector('#revoke');let artifact=null;let changed=false;function show(state){artifact=state.artifact;changed=state.changed;button.disabled=false;if(!artifact){button.textContent='Share';status.textContent='Private preview';link.style.display='none';revoke.style.display='none';return}link.href=artifact.url;link.style.display='inline-block';revoke.style.display='inline-block';button.textContent=changed?'Republish':'Copy link';status.textContent=changed?'Local changes not published':'Published'}async function inspect(){try{const response=await fetch('/api/artifacts/status?'+query);const result=await response.json();if(!response.ok)throw new Error(result.error||'Status failed');show(result)}catch(error){button.disabled=false;button.textContent='Share';status.textContent=error instanceof Error?error.message:'Status failed'}}button.onclick=async()=>{if(artifact&&!changed){await navigator.clipboard.writeText(artifact.url);button.textContent='Copied';setTimeout(()=>button.textContent='Copy link',1200);return}button.disabled=true;button.textContent=changed?'Republishing…':'Publishing…';status.textContent='Deploying read-only snapshot';try{const response=await fetch('/api/artifacts/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Publish failed');await navigator.clipboard.writeText(result.artifact.url);show({artifact:result.artifact,changed:false});button.textContent='Link copied';setTimeout(()=>button.textContent='Copy link',1200)}catch(error){button.disabled=false;button.textContent=changed?'Try republish again':'Try again';status.textContent=error instanceof Error?error.message:'Publish failed'}};revoke.onclick=async()=>{if(!artifact||!confirm('Revoke this shared artifact?'))return;revoke.disabled=true;status.textContent='Revoking…';try{const response=await fetch('/api/artifacts/'+artifact.id,{method:'DELETE'});if(!response.ok){const result=await response.json();throw new Error(result.error||'Revoke failed')}show({artifact:null,changed:false})}catch(error){revoke.disabled=false;status.textContent=error instanceof Error?error.message:'Revoke failed'}};void inspect();</script></body></html>`);
    }
    response.setHeader('Content-Disposition', `inline; filename="${basename(realCandidate).replace(/["\\]/g, '_')}"`);
    response.sendFile(realCandidate);
  });

  app.get('/api/artifacts/raw', (request, response) => {
    const input = z.object({ path: z.string().min(1).max(8_000), conversationId: z.string().uuid().optional(), workItemId: z.string().uuid().optional() }).parse(request.query);
    const conversation = input.conversationId ? repository.listConversations('all').find((entry) => entry.id === input.conversationId) : null;
    const item = repository.get(input.workItemId ?? conversation?.workItemId ?? '');
    const workspace = realpathSync(item ? resolveWorkingDirectory(item) : process.cwd());
    let requestedPath = input.path.replace(/^file:\/\//, '');
    let candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspace, requestedPath);
    if (!existsSync(candidate)) {
      requestedPath = requestedPath.replace(/:(\d+)(?::\d+)?$/, '');
      candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspace, requestedPath);
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return response.status(404).json({ error: 'Artifact file not found.' });
    const realCandidate = realpathSync(candidate);
    if (!isArtifactAllowed(realCandidate, workspace)) return response.status(403).json({ error: 'Artifact is outside the allowed development roots.' });
    response.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-same-origin; default-src 'self' data: https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Content-Disposition', `inline; filename="${basename(realCandidate).replace(/["\\]/g, '_')}"`);
    response.sendFile(realCandidate);
  });

  const artifactPathSchema = z.object({
    path: z.string().min(1).max(8_000),
    title: z.string().trim().min(1).max(300).optional(),
    conversationId: z.string().uuid().optional(),
    workItemId: z.string().uuid().optional(),
  });

  /**
   * Artifact links arrive as agent prose ("see notes/report.md:12"), so the same
   * normalization — strip file://, strip a trailing :line:column, resolve against
   * the task workspace, then re-check the real path against the allowed roots —
   * has to run for every artifact route.
   */
  function resolveArtifactFile(input: { path: string; conversationId?: string; workItemId?: string }): { path: string } | { status: number; error: string } {
    const conversation = input.conversationId ? repository.listConversations('all').find((entry) => entry.id === input.conversationId) : null;
    const item = repository.get(input.workItemId ?? conversation?.workItemId ?? '');
    const workspace = realpathSync(item ? resolveWorkingDirectory(item) : process.cwd());
    const requestedPath = input.path.replace(/^file:\/\//, '').replace(/:(\d+)(?::\d+)?$/, '');
    const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspace, requestedPath);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return { status: 404, error: 'Artifact file not found.' };
    const realCandidate = realpathSync(candidate);
    if (!isArtifactAllowed(realCandidate, workspace)) return { status: 403, error: 'Artifact is outside the allowed development roots.' };
    return { path: realCandidate };
  }

  /**
   * One publish path for first publications, republishes, and restores of a
   * revoked share. The plan is decided from the content hash before anything is
   * deployed, so an unchanged file costs nothing and a changed one always gets
   * its own version snapshot.
   */
  async function publishArtifact(input: { sourcePath: string; title: string; workItemId?: string | null; conversationId?: string | null }) {
    const contentHash = artifactContentHash(input.sourcePath, input.title);
    const plan = artifacts.planPublication(input.sourcePath, contentHash, createArtifactId());
    if (!plan.needsDeploy && plan.existing) {
      return { artifact: { id: plan.existing.id, title: plan.existing.title, url: plan.existing.url }, changed: false, published: false, kind: plan.kind };
    }
    for (const supersededId of plan.supersededIds) artifactPublisher.removeLocal(supersededId);
    const feedback = artifactFeedbackConfig();
    const published = await artifactPublisher.publish({
      id: plan.id, title: input.title, sourcePath: input.sourcePath, version: plan.version,
      feedback: feedback ? { artifactId: plan.id, endpointOrigin: feedback.endpointOrigin } : null,
    });
    artifacts.supersede(plan.supersededIds);
    const summary = artifacts.recordPublication({
      id: plan.id, sourcePath: input.sourcePath, title: input.title, url: published.url, contentHash,
      version: plan.version, workItemId: input.workItemId ?? null, conversationId: input.conversationId ?? null,
    }, plan.kind);
    return { artifact: { id: summary.id, title: summary.title, url: summary.url }, changed: plan.kind === 'republished', published: true, kind: plan.kind, created: plan.kind === 'published' };
  }

  app.post('/api/artifacts/publish', async (request, response) => {
    try {
      const input = artifactPathSchema.parse(request.body);
      const resolved = resolveArtifactFile(input);
      if ('error' in resolved) return response.status(resolved.status).json({ error: resolved.error });
      const title = input.title ?? basename(resolved.path).replace(/\.[^.]+$/, '');
      const conversation = input.conversationId ? repository.listConversations('all').find((entry) => entry.id === input.conversationId) : null;
      const item = repository.get(input.workItemId ?? conversation?.workItemId ?? '');
      const result = await publishArtifact({ sourcePath: resolved.path, title, workItemId: item?.id ?? null, conversationId: input.conversationId ?? null });
      response.status(result.published && result.kind === 'published' ? 201 : 200).json(result);
    } catch (error) {
      response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not publish artifact.' });
    }
  });

  app.get('/api/artifacts/status', (request, response) => {
    try {
      const input = artifactPathSchema.parse(request.query);
      const resolved = resolveArtifactFile(input);
      if ('error' in resolved) return response.status(resolved.status).json({ error: resolved.error });
      const plan = artifacts.planPublication(resolved.path, artifactContentHash(resolved.path, input.title ?? basename(resolved.path).replace(/\.[^.]+$/, '')), '');
      if (!plan.existing || plan.existing.revokedAt) return response.json({ artifact: null, changed: false });
      response.json({ artifact: { id: plan.existing.id, title: plan.existing.title, url: plan.existing.url }, changed: plan.kind === 'republished' });
    } catch (error) { response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not inspect artifact.' }); }
  });

  app.get('/api/artifacts', (request, response) => {
    const view = artifactLibraryViewSchema.parse(request.query.view);
    response.json({ artifacts: artifacts.list(view), counts: artifacts.counts() });
  });

  app.get('/api/artifacts/:id', (request, response) => {
    const artifact = artifacts.get(request.params.id);
    if (!artifact) return response.status(404).json({ error: 'Published artifact not found.' });
    const available = existsSync(artifact.sourcePath) && statSync(artifact.sourcePath).isFile();
    const latest = artifacts.latestVersion(artifact.id);
    const changed = available && latest ? artifactContentHash(artifact.sourcePath, artifact.title) !== latest.contentHash : false;
    response.json(artifacts.detail(artifact.id, { available, changed }));
  });

  app.post('/api/artifacts/:id/republish', async (request, response) => {
    try {
      const artifact = artifacts.get(request.params.id);
      if (!artifact) return response.status(404).json({ error: 'Published artifact not found.' });
      if (!existsSync(artifact.sourcePath) || !statSync(artifact.sourcePath).isFile()) {
        return response.status(409).json({ error: `The source file is gone (${artifact.sourcePath}). Publish it again from the file it came from.` });
      }
      const result = await publishArtifact({ sourcePath: artifact.sourcePath, title: artifact.title });
      response.json({ ...result, artifact: artifacts.get(artifact.id) });
    } catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : 'Could not republish artifact.' }); }
  });

  app.patch('/api/artifacts/:id', (request, response) => {
    try {
      const input = updateArtifactSchema.parse(request.body);
      const artifact = artifacts.link(request.params.id, input);
      if (!artifact) return response.status(404).json({ error: 'Published artifact not found.' });
      response.json({ artifact });
    } catch (error) { response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not update artifact.' }); }
  });

  app.delete('/api/artifacts/:id', async (request, response) => {
    try {
      const artifact = artifacts.get(request.params.id);
      if (!artifact || artifact.revokedAt) return response.status(404).json({ error: 'Published artifact not found.' });
      await artifactPublisher.revoke(request.params.id);
      response.json({ artifact: artifacts.markRevoked(request.params.id) });
    } catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : 'Could not revoke artifact.' }); }
  });

  // Coworker feedback. The published page lives on another origin and its reader
  // holds no Workbench token, so this endpoint answers CORS preflight, allows only
  // the artifact host, and is rate limited per artifact.
  function applyFeedbackCors(response: Response): boolean {
    const feedback = artifactFeedbackConfig();
    if (!feedback) return false;
    response.setHeader('Access-Control-Allow-Origin', feedback.pageOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Vary', 'Origin');
    return true;
  }

  app.options('/api/artifacts/:id/comments', (_request, response) => {
    applyFeedbackCors(response);
    response.status(204).end();
  });

  app.post('/api/artifacts/:id/comments', (request, response) => {
    try {
      applyFeedbackCors(response);
      const input = createArtifactCommentSchema.parse(request.body);
      const artifact = artifacts.get(request.params.id);
      if (!artifact || artifact.revokedAt) return response.status(404).json({ error: 'This shared page is no longer accepting feedback.' });
      if (!allowComment(artifact.id)) return response.status(429).json({ error: 'Too much feedback too quickly. Try again shortly.' });
      response.status(201).json({ comment: artifacts.addComment(artifact.id, input) });
    } catch (error) { response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not record feedback.' }); }
  });

  app.get('/api/artifacts/:id/comments', (request, response) => {
    if (!artifacts.get(request.params.id)) return response.status(404).json({ error: 'Published artifact not found.' });
    response.json({ comments: artifacts.listComments(request.params.id) });
  });

  app.patch('/api/artifacts/:id/comments/:commentId', (request, response) => {
    const resolved = z.object({ resolved: z.boolean() }).parse(request.body).resolved;
    const comment = artifacts.resolveComment(request.params.id, request.params.commentId, resolved);
    if (!comment) return response.status(404).json({ error: 'Feedback not found.' });
    response.json({ comment });
  });

  app.get('/api/shared/conversations', (request, response) => {
    repository.ensureDefaultConversation();
    const limit = z.coerce.number().int().min(1).max(100).default(30).parse(request.query.limit);
    const cursor = z.string().optional().parse(request.query.cursor) ?? null;
    const view = request.query.view === 'archive' ? 'archive' : 'active';
    response.json(repository.listConversationPage(limit, cursor, view));
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

  app.post('/api/shared/conversations/:id/archive', (request, response) => {
    const conversation = repository.setConversationArchived(request.params.id, true);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  app.post('/api/shared/conversations/:id/restore', (request, response) => {
    const conversation = repository.setConversationArchived(request.params.id, false);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  app.post('/api/shared/conversations/:id/fork', (request, response) => {
    const conversation = repository.forkConversation(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.status(201).json({ conversation });
  });

  app.get('/api/shared/messages', (request, response) => {
    const conversationId = z.string().uuid().optional().parse(request.query.conversationId);
    // Recovery of runs whose owner process died is the scheduler's job (lease
    // expiry + reclaimExpired), not this request handler's: canceling anything
    // this process doesn't recognize as "active" would wrongly kill legitimate
    // work owned by another instance, and would fire on every request right
    // after a restart before the scheduler gets a chance to reclaim it properly.
    if (conversationId) dispatchNextSharedTurn(repository, conversationId);
    else {
      const queuedConversationIds = new Set(repository.listSharedMessages(1_000).filter((message) => message.status === 'queued').map((message) => message.conversationId));
      for (const queuedConversationId of queuedConversationIds) dispatchNextSharedTurn(repository, queuedConversationId);
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
    if (isRuntimeApproval(input.body)) {
      const message = repository.createSharedMessage('jeffrey', input.body, 'completed', input.conversationId, attachments, 'none');
      const reply = repository.createSharedMessage('system', 'Approval received. Preparing the Workbench preview for promotion…', 'running', input.conversationId);
      // DB-backed rather than process-local: queued/running rows are the source of
      // truth for "is there live work," including work owned by another process.
      void runSharedBackgroundJob(repository, reply.id, (signal, onProgress) => promoteRuntime(database, signal, onProgress, () => repository.hasLiveWork()));
      response.status(202).json({ message, replies: [reply] });
      return;
    }
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
    if (!message) return response.status(404).json({ error: 'Running or queued message not found.' });
    response.json({ message });
  });

  app.post('/api/shared/messages/:id/interject', (request, response) => {
    const replies = interjectQueuedSharedMessage(repository, request.params.id);
    if (!replies) return response.status(404).json({ error: 'Queued message not found.' });
    response.json({ replies });
  });

  app.post('/api/shared/messages/:id/create-tasks', (request, response) => {
    try {
      const message = repository.listSharedMessages(1_000).find((item) => item.id === request.params.id);
      const conversation = message && repository.listConversations('all').find((item) => item.id === message.conversationId);
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

  // --- Structured memories (Phase 1) -----------------------------------------
  app.get('/api/memories', (request, response) => {
    const input = listMemoriesQuerySchema.parse(request.query);
    response.json({ memories: repository.listMemoriesStructured(input) });
  });

  app.post('/api/memories', (request, response) => {
    const input = createMemorySchema.parse(request.body);
    response.status(201).json({ memory: repository.createMemory(input) });
  });

  // Declared before /api/memories/:id/:action-style routes so "supersede" is
  // never mistaken for a dynamic :id segment.
  app.post('/api/memories/:id/supersede', (request, response) => {
    const input = supersedeMemorySchema.parse(request.body);
    const memory = repository.supersedeMemory(request.params.id, input);
    if (!memory) return response.status(404).json({ error: 'Memory not found.' });
    response.status(201).json({ memory });
  });

  app.patch('/api/memories/:id', (request, response) => {
    const input = updateMemorySchema.parse(request.body);
    const memory = repository.updateMemory(request.params.id, input);
    if (!memory) return response.status(404).json({ error: 'Memory not found.' });
    response.json({ memory });
  });

  // Soft delete: sets status to 'rejected' and returns the row so the client
  // doesn't need a refetch. Never 204 — the row still carries provenance.
  app.delete('/api/memories/:id', (request, response) => {
    const memory = repository.rejectMemory(request.params.id);
    if (!memory) return response.status(404).json({ error: 'Memory not found.' });
    response.json({ memory });
  });

  app.get('/api/work-items', (request, response) => {
    const view = request.query.view === 'archive' ? 'archive' : request.query.view === 'workbench' ? 'workbench' : 'active';
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

  app.post('/api/queue/plan', (_request, response, next) => {
    try {
      const proposal = repository.buildDailyProposal();
      response.status(201).json({ proposal, items: repository.list() });
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
    response.json({ connections: listBrokerConnections(repository) });
  });

  app.post('/api/source-connections/:provider/mcp/oauth/start', async (request, response, next) => {
    try {
      const provider = z.enum(['confluence', 'slack', 'gmail']).parse(request.params.provider);
      const defaultUrl = provider === 'confluence' ? 'https://mcp.atlassian.com/v1/mcp/authv2' : null;
      const serverUrl = z.string().url().parse(request.body?.serverUrl || defaultUrl);
      const callbackBase = process.env.APP_API_ORIGIN ?? `http://localhost:${process.env.PORT ?? 4317}/api/source-connections`;
      response.json({ url: await startRemoteMcpOAuth(provider, serverUrl, callbackBase) });
    } catch (error) { next(error); }
  });

  app.get('/api/source-connections/:provider/mcp/oauth/callback', async (request, response) => {
    try {
      const provider = z.enum(['confluence', 'slack', 'gmail']).parse(request.params.provider);
      const code = z.string().min(1).parse(request.query.code);
      const state = z.string().min(1).parse(request.query.state);
      const settings = await finishRemoteMcpOAuth(provider, code, state);
      repository.setSourceConnection(provider, 'Atlassian MCP', settings as unknown as Record<string, string>);
      response.type('html').send(`<!doctype html><title>MCP connected</title><script>window.opener?.postMessage({type:'workbench:mcp-connected'},'*');window.close()</script><p>MCP connected. You can close this window.</p>`);
    } catch (error) { response.status(400).type('html').send(`<p>MCP connection failed: ${(error instanceof Error ? error.message : 'Unknown error').replace(/[<>&]/g, '')}</p>`); }
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
    response.json({
      item,
      parentItem: item.parentWorkItemId ? repository.get(item.parentWorkItemId) : null,
      children: repository.listChildren(item.id),
      activity: repository.listActivity(item.id),
      runs: repository.listRuns(item.id),
      executionPlan: repository.getPendingExecutionPlan(item.id),
      classification: repository.getClassification(item.id),
      conversations: repository.listConversationsForWorkItem(item.id),
      artifacts: repository.listArtifactsForWorkItem(item.id),
      references: repository.listReferences(item.id),
    });
  });

  app.post('/api/work-items/:id/references', (request, response) => {
    const input = createWorkItemReferenceSchema.parse(request.body);
    try {
      response.status(201).json({ reference: repository.addReference(request.params.id, input) });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : 'Task not found.' });
    }
  });

  app.delete('/api/work-items/:id/references/:referenceId', (request, response) => {
    const removed = repository.removeReference(request.params.id, request.params.referenceId);
    if (!removed) return response.status(404).json({ error: 'Reference not found.' });
    response.status(204).end();
  });

  app.post('/api/work-items/:id/classify', (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    const { kind } = z.object({ kind: runKindSchema }).parse(request.body);
    const classification = repository.setClassification(item.id, classificationForKind(item, kind));
    repository.addActivity(item.id, 'jeffrey', 'classification', `Set task type to ${classification.kind}.`);
    response.json({ classification });
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
      response.json({ draft: await resolveBrokerUrl(repository, input.url) });
    } catch (error) { next(error); }
  });

  app.post('/api/sources/search', async (request, response, next) => {
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const input = searchSourcesSchema.parse(request.body);
      response.json(await searchBrokerSources(repository, input.query, input.sources, controller.signal));
    } catch (error) { if (!controller.signal.aborted) next(error); }
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

  app.post('/api/work-items/:id/restore', (request, response) => {
    const item = repository.restore(request.params.id);
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

  app.post('/api/work-items/:id/runs', async (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    // Reject a duplicate request (client retry, double click) rather than starting a
    // second concurrent agent run against the same task: two agents editing the same
    // workspace concurrently is a correctness hazard, not just wasted work.
    if (repository.activeRunsForItem(item.id).length) return response.status(409).json({ error: 'This task already has an active agent run.' });
    const input = createAgentRunSchema.parse(request.body);
    const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
    repository.createSharedMessage('system', `Requested ${input.kind}: ${input.instructions || item.description}`, 'completed', conversation.id);
    const resolvedAgents = resolveAgents(input.kind, input.target);
    const agents = input.target === 'auto' ? [repository.selectBalancedAgent(resolvedAgents[0])] : resolvedAgents;
    const runs = agents.map((agent) =>
      repository.createRun(item.id, input.kind, input.target, agent, input.instructions, conversation.id, repository.createSharedMessage(agent, '', 'running', conversation.id).id),
    );
    const sourceContext = await contextForPrompt(repository, [item.title, item.description, item.sourceUrl, ...repository.listReferences(item.id).map((reference) => reference.url)].filter(Boolean).join('\n'));
    for (const run of runs) void executeAgentRun(repository, run, OWNER_ID, LEASE_MS, sourceContext);
    response.status(202).json({ runs });
  });

  app.post('/api/agent-runs/:id/cancel', (request, response) => {
    const run = cancelAgentRun(repository, request.params.id);
    if (!run) return response.status(404).json({ error: 'Active agent run not found.' });
    response.json({ run });
  });

  app.post('/api/work-items/:id/execute', async (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    if (repository.activeRunsForItem(item.id).length) return response.status(409).json({ error: 'This task already has an active agent run.' });
    const classified = repository.getClassification(item.id) ?? repository.setClassification(item.id, await classifyExecutionRobust(item));
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
    const activity = repository.addActivity(
      item.id,
      'system',
      'execution_started',
      `Started ${classification.kind} execution with ${agents.join(' + ')}.`,
    );
    const sourceContext = await contextForPrompt(repository, [item.title, item.description, item.sourceUrl, ...repository.listReferences(item.id).map((reference) => reference.url)].filter(Boolean).join('\n'));
    for (const run of runs) void executeAgentRun(repository, run, OWNER_ID, LEASE_MS, sourceContext);
    response.status(202).json({ run: runs[0], runs, classification, conversation, activity });
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

  const clientPath = resolve(process.env.WORKBENCH_CLIENT_PATH ?? 'dist/client');
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
