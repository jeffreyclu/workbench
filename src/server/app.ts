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
  createWorkItemLinkSchema,
  createWorkItemReferenceSchema,
  createWorkItemSchema,
  generateTaskDraftSchema,
  createQueueProposalSchema,
  createSharedMessageSchema,
  createSharedConversationSchema,
  setConversationTaskSchema,
  updateSharedBriefSchema,
  reorderQueueSchema,
  runKindSchema,
  resolveSourceUrlSchema,
  searchSourcesSchema,
  sourceProviderSchema,
  updateSharedMessageSchema,
  updateDiscoveryCandidateSchema,
  resolveDiscoveryCandidateSchema,
  updateWorkItemSchema,
  providerSyncFieldSchema,
  providerSyncConflictResolutionSchema,
  bulkWorkItemActionSchema,
  createSavedWorkItemFilterSchema,
  savedWorkItemFilterViewSchema,
  updateSavedWorkItemFilterSchema,
  workItemFilterSchema,
  listAuditLogQuerySchema,
  isSelfAssigned,
  SELF_ASSIGNED_EXECUTION_MESSAGE,
} from '../shared/contracts.js';
import { generateFastAiTaskDraft } from './fast-task-draft-ai.js';
import type { AgentRun, WorkItem } from '../shared/contracts.js';
import { z } from 'zod';
import type { WorkbenchDatabase } from './database.js';
import { LinearProvider } from './providers/linear.js';
import { WorkItemDependencyError, WorkItemRepository } from './repository.js';
import { cancelAgentRun, classificationForKind, classifyExecutionRobust, executeAgentRun, resolveAgents, resolveWorkingDirectory, runAgentCommandWithFallback } from './agent-runner.js';
import { describeExecutionRouting, summarizeWorkItemChanges } from './activity-log.js';
import { cancelSharedReply, dispatchNextSharedTurn, interjectQueuedSharedMessage, replyInSharedRoom, runSharedBackgroundJob } from './shared-room.js';
import { createAuthGate } from './auth.js';
import { describeSlackConfig, escapeSlackText, resolveSlackConfig, sendSlackMessage } from './slack-notify.js';
import { finishRemoteMcpOAuth, startRemoteMcpOAuth } from './remote-mcp.js';
import { OutboundPolicyError } from './outbound-policy.js';
import { contextForPrompt, listBrokerConnections, resolveBrokerUrl, searchBrokerSources } from './connection-broker.js';
import { artifactContentHash, CloudflarePagesPublisher, createArtifactId, renderArtifactPage, repairLegacyArtifactSnapshots } from './artifact-publisher.js';
import { ArtifactLibrary, artifactFeedbackConfig, createCommentRateLimiter } from './artifact-library.js';
import { runDiscovery, shouldRunDiscoveryCatchUp } from './discovery.js';
import { isRuntimeApproval, promoteRuntime } from './runtime-promotion.js';
import { runtimePreviewStatus } from './runtime-preview.js';
import { startManagedMcpLogin } from './managed-mcp-login.js';
import { isArtifactAllowed } from './artifact-access.js';
import { LEASE_MS, OWNER_ID } from './scheduler.js';
import { createWorkbenchMcpHandler, rejectUnsupportedMcpMethod } from './workbench-mcp.js';
import { setAuditSink } from './audit-log.js';
import { liveRuntimeCapabilities, type RuntimeCapabilities } from './runtime-capabilities.js';

/**
 * Tagging Jeffrey as an owner claims the task for him, so no agent may execute it
 * until he is unassigned. This guards every durable-run entry point, not just the
 * Execute button, so a direct API call or a retry cannot slip past the rule.
 */
function rejectSelfAssignedExecution(item: WorkItem, response: Response): boolean {
  if (!isSelfAssigned(item.assignees)) return false;
  response.status(409).json({ error: SELF_ASSIGNED_EXECUTION_MESSAGE, code: 'SELF_ASSIGNED' });
  return true;
}

const followUpPlanSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20_000),
    workspacePath: z.string().trim().max(1_000).nullable(),
  })).min(1).max(100),
});

/** Agents sometimes omit the requested XML wrapper but still return valid JSON. */
export function parseFollowUpPlan(output: string): z.infer<typeof followUpPlanSchema> {
  const wrapped = output.match(/<workbench-plan>([\s\S]*?)<\/workbench-plan>/)?.[1];
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (wrapped ?? fenced ?? output).trim();
  return followUpPlanSchema.parse(JSON.parse(candidate));
}

/**
 * The request's Host header is client-controlled and must never seed a
 * security-sensitive OAuth redirect URI. APP_API_ORIGIN is the only source for
 * a public callback base, and only when it parses as an absolute http(s) URL;
 * anything else falls back to a fixed local origin rather than trusting Host.
 */
export function oauthCallbackBase(): string {
  const configured = process.env.APP_API_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'http:' || url.protocol === 'https:') return configured;
    } catch { /* falls through to the local origin */ }
  }
  return `http://localhost:${process.env.PORT ?? 4317}/api/source-connections`;
}

function rejectOpenPrerequisites(repository: WorkItemRepository, workItemId: string, response: Response): boolean {
  const blockedBy = repository.listOpenDependencies(workItemId);
  if (!blockedBy.length) return false;
  response.status(409).json({
    error: 'Task is blocked by open prerequisites.',
    code: 'OPEN_PREREQUISITES',
    blockedBy,
  });
  return true;
}

export function rejectPreviewMutation(method: string, capabilities: RuntimeCapabilities): { error: string; code: string } | null {
  if (capabilities.allowMutations || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  return { error: 'Preview is read-only. Run this action from the live Workbench.', code: 'PREVIEW_READ_ONLY' };
}

export function createApp(database: WorkbenchDatabase, capabilities: RuntimeCapabilities = liveRuntimeCapabilities) {
  const app = express();
  const repository = new WorkItemRepository(database);
  repository.backfillConversationRunAdoptions();
  const artifactPublisher = new CloudflarePagesPublisher();
  const artifacts = new ArtifactLibrary(database);
  const allowComment = createCommentRateLimiter();
  let artifactOperation = Promise.resolve();
  const serializeArtifactOperation = <T>(work: () => Promise<T>): Promise<T> => {
    const next = artifactOperation.then(work, work);
    artifactOperation = next.then(() => undefined, () => undefined);
    return next;
  };
  // Migration 015 introduced immutable rendered pages after artifacts already
  // existed. Import the deployed pages once on a live startup before any publish
  // attempts; preview remains read-only and never mutates the shared database.
  if (capabilities.allowMutations) {
    const repaired = repairLegacyArtifactSnapshots(process.env.ARTIFACT_OUTPUT_DIRECTORY ?? 'data/published', artifacts.listSnapshotCandidates(),
      (artifactId, version, content) => artifacts.recordRenderedSnapshot(artifactId, version, content));
    if (repaired.restored.length || repaired.missing.length) {
      console.info(JSON.stringify({ event: 'artifact_snapshot_repair', restored: repaired.restored.length, missing: repaired.missing }));
    }
  }
  // A process can die after Pages accepts the staged manifest but before the
  // database commit. Replaying a staged whole-directory manifest is safe and
  // deterministic, so recovery covers a crash immediately before *or* after
  // the remote deploy call returns instead of guessing which side it reached.
  if (capabilities.allowMutations) {
    void (async () => {
      for (const operation of artifacts.pendingDeploymentOperations()) {
      try {
        const manifest = JSON.parse(operation.manifest) as Record<string, unknown>;
        if (operation.state === 'staged') {
          if (operation.kind === 'revoke') {
            const id = String(manifest.id);
            await artifactPublisher.revoke(id, artifacts.listLive().filter((live) => live.id !== id), String(manifest.url));
          } else {
            const plan = manifest.plan as { id: string; version: number };
            const input = manifest.input as { sourcePath: string; title: string };
            await artifactPublisher.publish({
              id: plan.id, title: input.title, sourcePath: input.sourcePath, version: plan.version,
              renderedContent: String(manifest.renderedContent), publishedAt: String(manifest.publishedAt),
            }, artifacts.listLive());
          }
          artifacts.updateDeploymentOperation(operation.id, 'deployed');
        }
        if (operation.kind === 'revoke') {
          const id = String(manifest.id);
          if (artifacts.get(id)?.revokedAt === null) artifacts.markRevoked(id);
        } else {
          const plan = manifest.plan as { id: string; version: number; kind: 'published' | 'republished' | 'restored' };
          const input = manifest.input as { sourcePath: string; title: string; workItemId?: string | null; conversationId?: string | null };
          artifacts.recordPublication({
            id: plan.id, sourcePath: input.sourcePath, title: input.title,
            url: artifactPublisher.publicUrl(plan.id), contentHash: String(manifest.contentHash),
            renderedContent: String(manifest.renderedContent), version: plan.version,
            workItemId: input.workItemId ?? null, conversationId: input.conversationId ?? null,
          }, plan.kind);
        }
        artifacts.updateDeploymentOperation(operation.id, 'completed');
      } catch (error) {
        artifacts.updateDeploymentOperation(operation.id, 'failed', `Recovery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      }
    })();
  }
  setAuditSink((category, source, detail, workItemId) => repository.addAuditEntry(category, source, detail, workItemId ?? null));
  app.use(createAuthGate(undefined));
  // Attachments are transported as base64 JSON today. Ten 10 MB files can expand
  // to roughly 134 MB before JSON overhead, so the parser must not reject a valid
  // request before the attachment schema can enforce its per-file limits.
  app.use(express.json({ limit: '150mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, mode: capabilities.mode });
  });

  // Some deployments use a read-only inspection runtime. The local preview is
  // intentionally interactive so its candidate UI and agents can be tested.
  app.use((request, response, next) => {
    const rejection = rejectPreviewMutation(request.method, capabilities);
    if (!rejection) return next();
    response.status(403).json(rejection);
  });

  app.get('/api/runtime/preview-status', (_request, response) => {
    response.json(runtimePreviewStatus());
  });

  app.post('/mcp', createWorkbenchMcpHandler(repository));
  app.get('/mcp', rejectUnsupportedMcpMethod);
  app.delete('/mcp', rejectUnsupportedMcpMethod);

  app.get('/api/discovery', (request, response) => {
    const view = z.enum(['pending', 'reviewed']).catch('pending').parse(request.query.view);
    response.json(repository.getDiscoveryInbox(view));
  });

  app.get('/api/insights', (request, response) => {
    const days = z.enum(['7', '30']).catch('30').parse(request.query.days);
    response.json(repository.getRunInsights(days === '7' ? 7 : 30));
  });

  app.get('/api/audit-log', (request, response) => {
    const input = listAuditLogQuerySchema.parse(request.query);
    try {
      response.json(repository.listAuditLog(input.limit, input.cursor ?? null, input.category, input.workItemId));
    } catch {
      response.status(400).json({ error: 'Invalid audit log cursor.' });
    }
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

  if (capabilities.runDiscoveryCatchUp) {
    setTimeout(() => {
      const lastRun = repository.getDiscoveryInbox().lastRun?.completedAt ?? null;
      if (shouldRunDiscoveryCatchUp(lastRun)) void runDiscovery(repository).catch((error) => console.error('Discovery catch-up failed:', error));
    }, 1_500).unref();
  }

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
    return serializeArtifactOperation(async () => {
    const contentHash = artifactContentHash(input.sourcePath, input.title);
    const plan = artifacts.planPublication(input.sourcePath, contentHash, createArtifactId());
    if (!plan.needsDeploy && plan.existing) {
      return { artifact: { id: plan.existing.id, title: plan.existing.title, url: plan.existing.url }, changed: false, published: false, kind: plan.kind };
    }
    const feedback = artifactFeedbackConfig();
    const publishedAt = new Date().toISOString();
    const renderedContent = renderArtifactPage(input.sourcePath, input.title, {
      version: plan.version, publishedAt, feedback: feedback ? { artifactId: plan.id, endpointOrigin: feedback.endpointOrigin } : null,
    });
    const operation = artifacts.beginDeploymentOperation('publish', JSON.stringify({ plan, input, contentHash, renderedContent, publishedAt }));
    try {
      const published = await artifactPublisher.publish({
        id: plan.id, title: input.title, sourcePath: input.sourcePath, version: plan.version, renderedContent, publishedAt,
        feedback: feedback ? { artifactId: plan.id, endpointOrigin: feedback.endpointOrigin } : null,
      }, artifacts.listLive());
      artifacts.updateDeploymentOperation(operation.id, 'deployed');
      const summary = artifacts.recordPublication({
        id: plan.id, sourcePath: input.sourcePath, title: input.title, url: published.url, contentHash, renderedContent,
        version: plan.version, workItemId: input.workItemId ?? null, conversationId: input.conversationId ?? null,
      }, plan.kind);
      artifacts.supersede(plan.supersededIds);
      artifacts.updateDeploymentOperation(operation.id, 'completed');
      return { artifact: { id: summary.id, title: summary.title, url: summary.url }, changed: plan.kind === 'republished', published: true, kind: plan.kind, created: plan.kind === 'published' };
    } catch (error) {
      artifacts.updateDeploymentOperation(operation.id, 'failed', error instanceof Error ? error.message : 'Unknown deployment error');
      throw error;
    }
    });
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
      await serializeArtifactOperation(async () => {
      const artifact = artifacts.get(request.params.id);
      if (!artifact) return response.status(404).json({ error: 'Published artifact not found.' });
      const operation = artifacts.beginDeploymentOperation('revoke', JSON.stringify({ id: artifact.id, url: artifact.url }));
      try {
      const result = await artifactPublisher.revoke(request.params.id, artifacts.listLive().filter((live) => live.id !== artifact.id), artifact.url);
      artifacts.updateDeploymentOperation(operation.id, 'deployed');
      if (!artifact.revokedAt) artifacts.markRevoked(request.params.id);
      artifacts.updateDeploymentOperation(operation.id, 'completed');
      repository.addAuditEntry('destructive_action', 'workbench', `Revoked artifact ${request.params.id}${result.verified ? '' : ' (could not verify the public URL stopped serving)'}`, artifact.workItemId ?? null);
      response.json({ artifact: artifacts.get(request.params.id), verified: result.verified });
      } catch (error) {
        artifacts.updateDeploymentOperation(operation.id, 'failed', error instanceof Error ? error.message : 'Unknown deployment error');
        throw error;
      }
      });
    } catch (error) {
      repository.addAuditEntry('destructive_action', 'workbench', `Revoke failed for artifact ${request.params.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      response.status(500).json({ error: error instanceof Error ? error.message : 'Could not revoke artifact.' });
    }
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

  app.get('/api/shared/conversations/:id', (request, response) => {
    const conversation = repository.getConversation(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  app.get('/api/shared/conversations-unread-count', (_request, response) => {
    response.json({ count: repository.countUnreadConversations() });
  });

  app.get('/api/shared/conversations-count', (_request, response) => {
    response.json({ count: repository.countActiveConversations() });
  });

  app.post('/api/shared/conversations', (request, response) => {
    const input = createSharedConversationSchema.parse(request.body);
    response.status(201).json({ conversation: repository.createConversation(input.title) });
  });

  app.delete('/api/shared/conversations/:id', (request, response) => {
    const conversation = repository.getConversation(request.params.id);
    if (conversation?.workItemId) return response.status(409).json({ error: 'Task-linked conversations can only be deleted by deleting their task.' });
    if (!repository.deleteConversation(request.params.id)) return response.status(404).json({ error: 'Conversation not found.' });
    repository.addAuditEntry('destructive_action', 'workbench', `Deleted conversation ${request.params.id}`);
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

  app.patch('/api/shared/conversations/:id/preferences', (request, response) => {
    const { executionProfile } = z.object({ executionProfile: z.enum(['economy', 'standard', 'deep']).nullable() }).parse(request.body);
    const conversation = repository.setConversationExecutionProfile(request.params.id, executionProfile);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  app.patch('/api/shared/conversations/:id/brief', (request, response) => {
    const { brief } = updateSharedBriefSchema.parse(request.body);
    const conversation = repository.setConversationSharedBrief(request.params.id, brief);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  app.patch('/api/shared/conversations/:id/task', (request, response) => {
    const { workItemId } = setConversationTaskSchema.parse(request.body);
    const conversation = repository.setConversationWorkItem(request.params.id, workItemId);
    if (!conversation) return response.status(404).json({ error: workItemId ? 'Conversation or task not found.' : 'Conversation not found.' });
    response.json({ conversation });
  });

  app.post('/api/shared/conversations/:id/read', (request, response) => {
    const conversation = repository.markConversationRead(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.json({ conversation });
  });

  app.post('/api/shared/conversations/:id/fork', (request, response) => {
    const conversation = repository.forkConversation(request.params.id);
    if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
    response.status(201).json({ conversation });
  });

  app.get('/api/shared/search', (request, response) => {
    const query = z.string().trim().min(1).optional().parse(request.query.q);
    if (!query) return response.status(400).json({ error: 'Query parameter "q" is required.' });
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(request.query.limit);
    response.json({ results: repository.searchShared(query, limit) });
  });

  // This is intentionally read-only. Both CLI agents can retrieve the full
  // durable Workbench record instead of relying on their private chat memory.
  app.get('/api/activity-memory', (request, response) => {
    const query = z.string().trim().min(2).max(500).parse(request.query.q);
    const limit = z.coerce.number().int().min(1).max(100).default(40).parse(request.query.limit);
    response.json({ results: repository.searchActivityMemory(query, limit) });
  });

  app.get('/api/shared/messages', (request, response) => {
    const conversationId = z.string().uuid().optional().parse(request.query.conversationId);
    // Recovery of runs whose owner process died is the scheduler's job (lease
    // expiry + reclaimExpired), not this request handler's: canceling anything
    // this process doesn't recognize as "active" would wrongly kill legitimate
    // work owned by another instance, and would fire on every request right
    // after a restart before the scheduler gets a chance to reclaim it properly.
    if (capabilities.executeAgents && conversationId) dispatchNextSharedTurn(repository, conversationId);
    else if (capabilities.executeAgents) {
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
      if (!capabilities.promoteRuntime) return response.status(403).json({ error: 'Preview cannot promote a runtime. Send this approval from the live Workbench.', code: 'PREVIEW_PROMOTION_UNAVAILABLE' });
      const conversation = input.conversationId ? repository.getConversation(input.conversationId) : null;
      const linkedItem = conversation?.workItemId ? repository.get(conversation.workItemId) : null;
      if (!linkedItem || linkedItem.stack !== 'workbench') {
        return response.status(403).json({ error: 'Runtime promotion is only available from a conversation linked to a Workbench-stack task.', code: 'PREVIEW_PROMOTION_WRONG_STACK' });
      }
      const message = repository.createSharedMessage('jeffrey', input.body, 'completed', input.conversationId, attachments, 'none');
      const reply = repository.createSharedMessage('system', 'Approval received. Preparing the Workbench preview for promotion…', 'running', input.conversationId, [], 'promotion');
      // DB-backed rather than process-local: queued/running rows are the source of
      // truth for "is there live work," including work owned by another process.
      void runSharedBackgroundJob(repository, reply.id, (signal, onProgress) => promoteRuntime(database, signal, onProgress, () => repository.hasLiveWork()));
      response.status(202).json({ message, replies: [reply] });
      return;
    }
    const agents = input.dispatchTo === 'both' ? ['codex', 'claude'] as const
      : input.dispatchTo === 'none' ? [] : [input.dispatchTo];
    const message = repository.createSharedMessage('jeffrey', input.body, agents.length ? 'queued' : 'completed', input.conversationId, attachments, input.dispatchTo, input.executionProfile);
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

  app.post('/api/shared/messages/:id/retry', (request, response) => {
    const prior = repository.getSharedMessageById(request.params.id);
    if (!prior) return response.status(404).json({ error: 'Chat response not found.' });
    if ((prior.author !== 'codex' && prior.author !== 'claude') || (prior.status !== 'failed' && prior.status !== 'canceled')) {
      return response.status(409).json({ error: 'Only failed or canceled agent responses can be continued.' });
    }
    if (repository.getRunByMessage(prior.id)) return response.status(409).json({ error: 'Retry this response from its related task run.' });
    if (repository.listAllSharedMessages(prior.conversationId).some((message) => message.status === 'running' || message.status === 'queued')) {
      return response.status(409).json({ error: 'Wait for the active response to finish before continuing this one.' });
    }
    const executionProfile = prior.executionProfile === 'routing' ? null : prior.executionProfile;
    const reply = repository.prepareSharedMessageRetry(prior.id);
    if (!reply) return response.status(409).json({ error: 'This response is no longer retryable.' });
    if (executionProfile !== prior.executionProfile) repository.updateSharedMessage(reply.id, { executionProfile });
    void replyInSharedRoom(repository, prior.author, reply.id);
    response.status(202).json({ reply });
  });

  app.post('/api/shared/messages/:id/interject', (request, response) => {
    const replies = interjectQueuedSharedMessage(repository, request.params.id);
    if (!replies) return response.status(404).json({ error: 'Queued message not found.' });
    response.json({ replies });
  });

  app.post('/api/shared/messages/:id/create-tasks', (request, response) => {
    try {
      const message = repository.getSharedMessageById(request.params.id);
      const conversation = message && repository.listConversations('all').find((item) => item.id === message.conversationId);
      if (!message || !conversation?.workItemId) return response.status(400).json({ error: 'This report is not linked to a task execution.' });
      const item = repository.get(conversation.workItemId);
      if (!item) return response.status(404).json({ error: 'Linked task not found.' });
      const existingPlan = repository.getPendingExecutionPlan(item.id);
      if (existingPlan) return response.json({ plan: existingPlan });
      const existingJob = repository.listSharedMessages(100, null, conversation.id).messages.find((entry) => entry.status === 'running' && entry.author === 'system' && entry.body.startsWith('Turning findings into tasks'));
      if (existingJob) return response.status(202).json({ jobMessage: existingJob });
      const jobMessage = repository.createSharedMessage('system', 'Turning findings into tasks…', 'running', conversation.id);
      void runSharedBackgroundJob(repository, jobMessage.id, async (signal) => {
        const { output } = await runAgentCommandWithFallback('claude', process.cwd(), `Convert this agent report into independently executable follow-up tasks for Jeffrey's attention stack. Preserve concrete findings, affected files, constraints, and verification in each task. Order tasks by attention. Do not create vague coordination tasks.\n\nOriginal task: ${item.title}\n${item.description}\n\nReport:\n${message.body}\n\nReturn exactly <workbench-plan>{"summary":"...","tasks":[{"title":"...","description":"...","workspacePath":${JSON.stringify(item.workspacePath)}}]}</workbench-plan>`, undefined, signal);
        const parsed = parseFollowUpPlan(output);
        repository.createExecutionPlan(item.id, parsed.summary, parsed.tasks);
        return `Follow-up task proposal ready: ${parsed.summary}`;
      });
      response.status(202).json({ jobMessage });
    } catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : 'Could not start task extraction.' }); }
  });

  app.get('/api/work-items', (request, response) => {
    const view = request.query.view === 'archive' ? 'archive' : request.query.view === 'workbench' ? 'workbench' : 'active';
    const limit = Number(request.query.limit ?? 50);
    if (!Number.isFinite(limit)) return response.status(400).json({ error: 'Invalid page limit.' });
    if (request.query.filter !== undefined && request.query.query !== undefined) return response.status(400).json({ error: 'Use either filter or query, not both.' });
    let filter;
    try {
      filter = request.query.filter === undefined
        ? workItemFilterSchema.parse({ query: typeof request.query.query === 'string' ? request.query.query : '' })
        : workItemFilterSchema.parse(JSON.parse(z.string().parse(request.query.filter)));
    } catch { return response.status(400).json({ error: 'Invalid work-item filter.' }); }
    try { response.json(repository.listPage(view, limit, typeof request.query.cursor === 'string' ? request.query.cursor : null, filter)); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid work-item cursor.' }); }
  });

  app.get('/api/work-item-filters', (request, response) => {
    const view = request.query.view === undefined ? undefined : savedWorkItemFilterViewSchema.parse(request.query.view);
    response.json({ filters: repository.listSavedFilters(view) });
  });

  app.post('/api/work-item-filters', (request, response) => {
    try { response.status(201).json({ filter: repository.createSavedFilter(createSavedWorkItemFilterSchema.parse(request.body)) }); }
    catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return response.status(409).json({ error: 'A saved filter with this name already exists in this view.' });
      throw error;
    }
  });

  app.patch('/api/work-item-filters/:id', (request, response) => {
    try {
      const filter = repository.updateSavedFilter(request.params.id, updateSavedWorkItemFilterSchema.parse(request.body));
      if (!filter) return response.status(404).json({ error: 'Saved filter not found.' });
      response.json({ filter });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return response.status(409).json({ error: 'A saved filter with this name already exists in this view.' });
      throw error;
    }
  });

  app.delete('/api/work-item-filters/:id', (request, response) => {
    if (!repository.deleteSavedFilter(request.params.id)) return response.status(404).json({ error: 'Saved filter not found.' });
    response.status(204).end();
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

  app.get('/api/queue/explain', (_request, response, next) => {
    try {
      response.json({ plan: repository.explainQueue(), history: repository.listQueueHistory('attention') });
    } catch (error) { next(error); }
  });

  app.post('/api/queue/undo', (request, response, next) => {
    try {
      const stack = z.enum(['attention', 'workbench']).default('attention').parse(request.body?.stack ?? 'attention');
      const undone = repository.undoLastQueueChange(stack);
      if (!undone) return response.status(404).json({ error: 'No ordering change left to undo for this stack.' });
      response.json({ change: undone.change, items: undone.items });
    } catch (error) { next(error); }
  });

  app.post('/api/queue/plan', (request, response, next) => {
    try {
      const stack = z.enum(['attention', 'workbench']).default('attention').parse(request.body?.stack ?? 'attention');
      const proposal = repository.buildDailyProposal(Date.now(), stack);
      response.status(201).json({ proposal, items: stack === 'workbench' ? repository.listWorkbench() : repository.list() });
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
      const provider = z.enum(['confluence', 'slack', 'figma', 'gmail']).parse(request.params.provider);
      const defaultUrl = provider === 'confluence' ? 'https://mcp.atlassian.com/v1/mcp/authv2' : provider === 'slack' ? 'https://mcp.slack.com/mcp' : provider === 'figma' ? 'https://mcp.figma.com/mcp' : null;
      const serverUrl = z.string().url().parse(request.body?.serverUrl || defaultUrl);
      const callbackBase = oauthCallbackBase();
      response.json({ url: await startRemoteMcpOAuth(provider, serverUrl, callbackBase) });
    } catch (error) { next(error); }
  });

  app.post('/api/source-connections/figma/managed/oauth/start', async (_request, response, next) => {
    try {
      const login = await startManagedMcpLogin('figma');
      void login.completion.then(() => repository.setSourceConnection('figma', 'Figma MCP · Codex', { mode: 'managed' })).catch(() => undefined);
      response.json({ url: login.url });
    } catch (error) { next(error); }
  });

  app.get('/api/source-connections/:provider/mcp/oauth/callback', async (request, response) => {
    try {
      const provider = z.enum(['confluence', 'slack', 'figma', 'gmail']).parse(request.params.provider);
      const code = z.string().min(1).parse(request.query.code);
      const state = z.string().min(1).parse(request.query.state);
      const settings = await finishRemoteMcpOAuth(provider, code, state);
      const label = provider === 'confluence' ? 'Atlassian MCP' : provider === 'figma' ? 'Figma MCP' : provider === 'slack' ? 'Slack MCP' : 'Google Workspace MCP';
      repository.setSourceConnection(provider, label, settings as unknown as Record<string, string>);
      response.type('html').send(`<!doctype html><title>MCP connected</title><script>window.opener?.postMessage({type:'workbench:mcp-connected'},'*');window.close()</script><p>MCP connected. You can close this window.</p>`);
    } catch (error) { response.status(400).type('html').send(`<p>MCP connection failed: ${(error instanceof Error ? error.message : 'Unknown error').replace(/[<>&]/g, '')}</p>`); }
  });

  app.delete('/api/source-connections/:provider', (request, response) => {
    const provider = sourceProviderSchema.parse(request.params.provider);
    if (!repository.removeSourceConnection(provider)) return response.status(404).json({ error: 'Source connection not found.' });
    repository.addAuditEntry('destructive_action', 'workbench', `Removed source connection ${provider}`);
    response.status(204).end();
  });

  app.post('/api/queue/proposals/:id/:resolution', (request, response) => {
    const resolution = z.enum(['accepted', 'rejected']).parse(request.params.resolution);
    const proposal = repository.resolveProposal(request.params.id, resolution);
    if (!proposal) return response.status(404).json({ error: 'Pending proposal not found.' });
    response.json({ proposal, items: proposal.stack === 'workbench' ? repository.listWorkbench() : repository.list() });
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
      linkedTasks: repository.listLinkedTasks(item.id),
      references: repository.listReferences(item.id),
      blocks: repository.listBlockedWork(item.id),
      providerConflicts: repository.listProviderConflicts(item.id),
    });
  });

  app.get('/api/work-items/:id/dependency-candidates', (request, response) => {
    if (!repository.get(request.params.id)) return response.status(404).json({ error: 'Work item not found.' });
    const query = z.string().trim().max(500).catch('').parse(request.query.q);
    response.json({ items: repository.searchDependencyCandidates(request.params.id, query) });
  });

  app.post('/api/work-items/:id/references', (request, response) => {
    const input = createWorkItemReferenceSchema.parse(request.body);
    try {
      response.status(201).json({ reference: repository.addReference(request.params.id, input) });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : 'Task not found.' });
    }
  });

  app.post('/api/work-items/:id/linked-tasks', (request, response) => {
    try {
      const linkedTask = repository.addTaskLink(request.params.id, createWorkItemLinkSchema.parse(request.body).linkedWorkItemId);
      response.status(201).json({ item: linkedTask });
    } catch (error) {
      response.status(error instanceof ZodError ? 400 : 404).json({ error: error instanceof Error ? error.message : 'Could not link task.' });
    }
  });

  app.delete('/api/work-items/:id/linked-tasks/:linkedTaskId', (request, response) => {
    if (!repository.removeTaskLink(request.params.id, request.params.linkedTaskId)) return response.status(404).json({ error: 'Task link not found.' });
    response.status(204).end();
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
    const classification = repository.setClassification(item.id, classificationForKind(item, kind), 'manual');
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

  app.post('/api/work-items/bulk', (request, response) => {
    response.json(repository.bulkUpdate(bulkWorkItemActionSchema.parse(request.body)));
  });

  app.post('/api/work-items/generate-draft', async (request, response, next) => {
    try {
      const input = generateTaskDraftSchema.parse(request.body);
      response.json({ draft: await generateFastAiTaskDraft(input.prompt) });
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
    const existing = repository.get(request.params.id);
    if (!existing) return response.status(404).json({ error: 'Work item not found.' });
    let item;
    try {
      item = repository.update(request.params.id, input);
    } catch (error) {
      if (error instanceof WorkItemDependencyError) {
        return response.status(409).json({ error: error.message, code: error.code });
      }
      throw error;
    }
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    const edits = summarizeWorkItemChanges(existing, item);
    if (edits.length) repository.addActivity(item.id, 'jeffrey', 'edited', `${edits.join(' · ')}.`);
    response.json({ item });
  });

  app.post('/api/work-items/:id/provider-conflicts/:field/resolve', (request, response) => {
    const field = providerSyncFieldSchema.parse(request.params.field);
    const { resolution } = providerSyncConflictResolutionSchema.parse(request.body);
    const item = repository.resolveProviderConflict(request.params.id, field, resolution);
    if (!item) return response.status(404).json({ error: 'Provider conflict not found.' });
    response.json({ item, providerConflicts: repository.listProviderConflicts(item.id) });
  });

  app.post('/api/work-items/:id/archive', (request, response) => {
    const item = repository.archive(request.params.id, false, false, { actor: 'jeffrey' });
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  app.post('/api/work-items/:id/restore', (request, response) => {
    const item = repository.restore(request.params.id, false, { actor: 'jeffrey' });
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  app.post('/api/work-items/:id/complete', (request, response) => {
    const item = repository.archive(request.params.id, true, false, { actor: 'jeffrey' });
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  app.delete('/api/work-items/:id', (request, response) => {
    if (!repository.delete(request.params.id)) return response.status(404).json({ error: 'Work item not found.' });
    repository.addAuditEntry('destructive_action', 'workbench', `Deleted work item ${request.params.id}`, request.params.id);
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
    if (rejectSelfAssignedExecution(item, response)) return;
    if (rejectOpenPrerequisites(repository, item.id, response)) return;
    // Reject a duplicate request (client retry, double click) rather than starting a
    // second concurrent agent run against the same task: two agents editing the same
    // workspace concurrently is a correctness hazard, not just wasted work.
    if (repository.activeRunsForItem(item.id).length) return response.status(409).json({ error: 'This task already has an active agent run.' });
    const input = createAgentRunSchema.parse(request.body);
    const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
    repository.createSharedMessage('system', `Requested ${input.kind}: ${input.instructions || item.description}`, 'completed', conversation.id);
    const resolvedAgents = resolveAgents(input.kind, input.target);
    const agents = input.target === 'auto' ? [repository.selectBalancedAgent(resolvedAgents[0])] : resolvedAgents;
    const runs = agents.map((agent) => {
      const reply = repository.createSharedMessage(agent, '', 'running', conversation.id);
      const run = repository.createRun(item.id, input.kind, input.target, agent, input.instructions, conversation.id, reply.id);
      if (!input.executionProfile) return run;
      repository.updateRun(run.id, { executionProfile: input.executionProfile });
      repository.updateSharedMessage(reply.id, { executionProfile: input.executionProfile });
      return { ...run, executionProfile: input.executionProfile };
    });
    repository.addActivity(item.id, 'jeffrey', 'execution_started', describeExecutionRouting({
      kind: input.kind,
      agents,
      reason: 'you asked for this run type',
      agentSource: input.target === 'auto' ? 'balanced' : 'assigned',
      requestedProfile: input.executionProfile,
    }));
    const sourceContext = await contextForPrompt(repository, [item.title, item.description, item.sourceUrl, ...repository.listReferences(item.id).map((reference) => reference.url)].filter(Boolean).join('\n'));
    for (const run of runs) void executeAgentRun(repository, run, OWNER_ID, LEASE_MS, sourceContext);
    response.status(202).json({ runs });
  });

  app.post('/api/agent-runs/:id/cancel', (request, response) => {
    const run = cancelAgentRun(repository, request.params.id);
    if (!run) return response.status(404).json({ error: 'Active agent run not found.' });
    response.json({ run });
  });

  app.post('/api/agent-runs/:id/retry', async (request, response) => {
    const prior = repository.getRun(request.params.id);
    if (!prior) return response.status(404).json({ error: 'Agent run not found.' });
    if (prior.status !== 'failed' && prior.status !== 'canceled') return response.status(409).json({ error: 'Only failed or canceled runs can be retried.' });
    if (repository.activeRunsForItem(prior.workItemId).length) return response.status(409).json({ error: 'This task already has an active agent run.' });
    const item = repository.get(prior.workItemId);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    if (rejectSelfAssignedExecution(item, response)) return;
    if (rejectOpenPrerequisites(repository, item.id, response)) return;
    const conversation = prior.conversationId
      ? repository.listConversations('all').find((entry) => entry.id === prior.conversationId) ?? repository.getOrCreateWorkConversation(item.id, item.title)
      : repository.getOrCreateWorkConversation(item.id, item.title);
    const run = repository.prepareRunRetry(prior.id);
    if (!run) return response.status(409).json({ error: 'This run is no longer retryable.' });
    repository.update(item.id, { status: 'in_progress' });
    const activity = repository.addActivity(item.id, 'system', 'execution_retried', `Retrying ${prior.agent} ${prior.kind} after the prior attempt ${prior.status}.`);
    const sourceContext = await contextForPrompt(repository, [item.title, item.description, item.sourceUrl, ...repository.listReferences(item.id).map((reference) => reference.url)].filter(Boolean).join('\n'));
    void executeAgentRun(repository, run, OWNER_ID, LEASE_MS, sourceContext);
    response.status(202).json({ run, conversation, activity });
  });

  app.post('/api/work-items/:id/execute', async (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    if (item.archivedAt || item.status === 'done' || item.status === 'canceled') return response.status(409).json({ error: 'Archived or completed tasks cannot be executed. Restore the task first.' });
    if (rejectSelfAssignedExecution(item, response)) return;
    if (rejectOpenPrerequisites(repository, item.id, response)) return;
    if (repository.activeRunsForItem(item.id).length) return response.status(409).json({ error: 'This task already has an active agent run.' });
    if (repository.listRuns(item.id).length) return response.status(409).json({ error: 'This task has already been executed. Create a follow-up task for additional work.' });
    const { executionProfile } = z.object({ executionProfile: z.enum(['economy', 'standard', 'deep']).nullable().default(null) }).parse(request.body ?? {});
    let classified = repository.getClassification(item.id);
    let classificationReason = classified?.source === 'manual'
      ? 'you picked this task type by hand'
      : 'reused the classification from the first routing pass';
    if (!classified) {
      const fresh = await classifyExecutionRobust(item);
      classificationReason = fresh.reason;
      classified = repository.setClassification(item.id, fresh);
    }
    const explicitlyAssigned = repository.getExplicitAgentAssignees(item.id);
    const agents = explicitlyAssigned.length ? explicitlyAssigned : [repository.selectBalancedAgent(classified.agent)];
    const classification = { ...classified, agent: agents[0] };
    if (!explicitlyAssigned.length) repository.updateAutomaticAgentAssignees(item.id, agents);
    let conversation = repository.getOrCreateWorkConversation(item.id, item.title);
    conversation = repository.setConversationExecutionProfile(conversation.id, executionProfile) ?? conversation;
    repository.createSharedMessage('system', `Execute: ${item.title}`, 'completed', conversation.id);
    const runs = agents.map((agent) => {
      const reply = repository.createSharedMessage(agent, '', 'running', conversation.id);
      const run = repository.createRun(item.id, classification.kind, explicitlyAssigned.length ? agent : 'auto', agent, classification.instructions, conversation.id, reply.id);
      if (!executionProfile) return run;
      repository.updateRun(run.id, { executionProfile });
      repository.updateSharedMessage(reply.id, { executionProfile });
      return { ...run, executionProfile };
    });
    const activity = repository.addActivity(
      item.id,
      'system',
      'execution_started',
      describeExecutionRouting({
        kind: classification.kind,
        agents,
        reason: classificationReason,
        agentSource: explicitlyAssigned.length ? 'assigned' : 'balanced',
        requestedProfile: executionProfile,
      }),
    );
    const sourceContext = await contextForPrompt(repository, [item.title, item.description, item.sourceUrl, ...repository.listReferences(item.id).map((reference) => reference.url)].filter(Boolean).join('\n'));
    for (const run of runs) void executeAgentRun(repository, run, OWNER_ID, LEASE_MS, sourceContext);
    response.status(202).json({ run: runs[0], runs, classification, conversation, activity });
  });

  app.post('/api/execution-plans/:id/:resolution', (request, response) => {
    const resolution = z.enum(['accepted', 'rejected']).parse(request.params.resolution);
    const { selectedTaskIndexes, archiveParent } = z.object({
      selectedTaskIndexes: z.array(z.number().int().nonnegative()).optional(),
      archiveParent: z.boolean().default(false),
    }).parse(request.body ?? {});
    const plan = repository.resolveExecutionPlan(request.params.id, resolution, selectedTaskIndexes, archiveParent);
    if (!plan) return response.status(404).json({ error: 'Pending execution plan not found.' });
    if (resolution === 'accepted') {
      // Accepting a decomposition supersedes all execution still aimed at the
      // parent. Cancel both durable task runs and chat replies so neither can
      // continue mutating the original task after its children become canonical.
      for (const run of repository.activeRunsForItem(plan.workItemId)) cancelAgentRun(repository, run.id);
      for (const conversation of repository.listConversationsForWorkItem(plan.workItemId)) {
        for (const message of repository.listAllSharedMessages(conversation.id)) {
          if (message.status === 'queued' || message.status === 'running') cancelSharedReply(repository, message.id);
        }
      }
    }
    response.json({ plan, items: repository.list(), parentArchived: resolution === 'accepted' && archiveParent });
  });

  app.post('/api/providers/linear/sync', async (_request, response, next) => {
    try {
      const provider = new LinearProvider(
        process.env.LINEAR_API_KEY ?? '',
        repository.getLinearConfig().teamIds,
        repository.getLinearConfig().projectIds,
      );
      const issues = await provider.fetchOpenIssues();
      const counts = { imported: 0, updated: 0, skipped: 0, conflicts: 0 };
      const conflictsBefore = repository.countProviderConflicts();
      for (const outcome of repository.upsertLinearItems(issues)) counts[outcome] += 1;
      counts.conflicts = repository.countProviderConflicts() - conflictsBefore;
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
    // Direct navigation to a client route must load the SPA entry point. The
    // release gateway serves the built client through this Express process, so
    // without this fallback `/conversations/:id` returns a server-side 404.
    app.use((request, response, next) => {
      if (request.method !== 'GET' || request.path.startsWith('/api/') || request.path === '/mcp') return next();
      response.sendFile('index.html', { root: clientPath }, (error) => error ? next(error) : undefined);
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    if (error instanceof OutboundPolicyError) {
      response.status(400).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({ error: 'Invalid request.', details: error.issues });
      return;
    }
    if (typeof error === 'object' && error !== null && ('type' in error && error.type === 'entity.too.large' || 'status' in error && error.status === 413)) {
      response.status(413).json({ error: 'Attachments are too large. Each file can be up to 10 MB, with at most 10 files per message.' });
      return;
    }
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error.' });
  };
  app.use(errorHandler);
  return app;
}
