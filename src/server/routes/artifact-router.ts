import { Router, type Response } from 'express';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { ZodError, z } from 'zod';
import { artifactLibraryViewSchema, createArtifactCommentSchema, updateArtifactSchema } from '../../shared/contracts.js';
import { artifactContentHash, repairLegacyArtifactSnapshots } from '../artifact-publisher.js';
import { artifactFeedbackConfig } from '../artifact-library.js';
import { isArtifactAllowed } from '../artifact-access.js';
import { resolveWorkingDirectory } from '../agent-runner.js';
import { isActionFailure } from '../action-result.js';
import type { RouteContext } from '../route-context.js';

export function createArtifactRouter({ repository, artifacts, artifactService, allowArtifactComment }: RouteContext) {
  const router = Router();
  router.get('/api/artifacts/open', (request, response) => {
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

  router.get('/api/artifacts/raw', (request, response) => {
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

  router.post('/api/artifacts/publish', async (request, response) => {
    try {
      const input = artifactPathSchema.parse(request.body);
      const resolved = artifactService.resolveFile(input);
      if ('error' in resolved) return response.status(resolved.status).json({ error: resolved.error });
      const title = input.title ?? basename(resolved.path).replace(/\.[^.]+$/, '');
      const conversation = input.conversationId ? repository.listConversations('all').find((entry) => entry.id === input.conversationId) : null;
      const item = repository.get(input.workItemId ?? conversation?.workItemId ?? '');
      const result = await artifactService.publish({ sourcePath: resolved.path, title, workItemId: item?.id ?? null, conversationId: input.conversationId ?? null });
      response.status(result.published && result.kind === 'published' ? 201 : 200).json(result);
    } catch (error) {
      response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not publish artifact.' });
    }
  });

  /**
   * Repairs immutable rendered snapshots left blank by the pre-migration
   * publisher. This deliberately does not deploy anything: callers can see
   * exactly which historical pages were restored or remain unrecoverable
   * before attempting a publish that would replace the Pages directory.
   */
  router.post('/api/artifacts/repair-snapshots', async (_request, response) => {
    try {
      const result = await artifactService.serialize(async () => repairLegacyArtifactSnapshots(
        process.env.ARTIFACT_OUTPUT_DIRECTORY ?? 'data/published',
        artifacts.listSnapshotCandidates(),
        (artifactId, version, content) => artifacts.recordRenderedSnapshot(artifactId, version, content),
      ));
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : 'Could not repair artifact snapshots.' });
    }
  });

  router.get('/api/artifacts/status', (request, response) => {
    try {
      const input = artifactPathSchema.parse(request.query);
      const resolved = artifactService.resolveFile(input);
      if ('error' in resolved) return response.status(resolved.status).json({ error: resolved.error });
      const plan = artifacts.planPublication(resolved.path, artifactContentHash(resolved.path, input.title ?? basename(resolved.path).replace(/\.[^.]+$/, '')), '');
      if (!plan.existing || plan.existing.revokedAt) return response.json({ artifact: null, changed: false });
      response.json({ artifact: { id: plan.existing.id, title: plan.existing.title, url: plan.existing.url }, changed: plan.kind === 'republished' });
    } catch (error) { response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not inspect artifact.' }); }
  });

  router.get('/api/artifacts', (request, response) => {
    const view = artifactLibraryViewSchema.parse(request.query.view);
    response.json({ artifacts: artifacts.list(view), counts: artifacts.counts() });
  });

  router.get('/api/artifacts/:id', (request, response) => {
    const artifact = artifacts.get(request.params.id);
    if (!artifact) return response.status(404).json({ error: 'Published artifact not found.' });
    const available = existsSync(artifact.sourcePath) && statSync(artifact.sourcePath).isFile();
    const latest = artifacts.latestVersion(artifact.id);
    const changed = available && latest ? artifactContentHash(artifact.sourcePath, artifact.title) !== latest.contentHash : false;
    response.json(artifacts.detail(artifact.id, { available, changed }));
  });

  router.post('/api/artifacts/:id/republish', async (request, response) => {
    try {
      const artifact = artifacts.get(request.params.id);
      if (!artifact) return response.status(404).json({ error: 'Published artifact not found.' });
      if (!existsSync(artifact.sourcePath) || !statSync(artifact.sourcePath).isFile()) {
        return response.status(409).json({ error: `The source file is gone (${artifact.sourcePath}). Publish it again from the file it came from.` });
      }
      const result = await artifactService.publish({ sourcePath: artifact.sourcePath, title: artifact.title });
      response.json({ ...result, artifact: artifacts.get(artifact.id) });
    } catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : 'Could not republish artifact.' }); }
  });

  router.patch('/api/artifacts/:id', (request, response) => {
    try {
      const input = updateArtifactSchema.parse(request.body);
      const artifact = artifacts.link(request.params.id, input);
      if (!artifact) return response.status(404).json({ error: 'Published artifact not found.' });
      response.json({ artifact });
    } catch (error) { response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not update artifact.' }); }
  });
  router.delete('/api/artifacts/:id', async (request, response) => {
    const result = await artifactService.revoke(request.params.id);
    if (isActionFailure(result)) return response.status(result.status).json(result.body);
    response.json(result);
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

  router.options('/api/artifacts/:id/comments', (_request, response) => {
    applyFeedbackCors(response);
    response.status(204).end();
  });

  router.post('/api/artifacts/:id/comments', (request, response) => {
    try {
      applyFeedbackCors(response);
      const input = createArtifactCommentSchema.parse(request.body);
      const artifact = artifacts.get(request.params.id);
      if (!artifact || artifact.revokedAt) return response.status(404).json({ error: 'This shared page is no longer accepting feedback.' });
      if (!allowArtifactComment(artifact.id)) return response.status(429).json({ error: 'Too much feedback too quickly. Try again shortly.' });
      response.status(201).json({ comment: artifacts.addComment(artifact.id, input) });
    } catch (error) { response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Could not record feedback.' }); }
  });

  router.get('/api/artifacts/:id/comments', (request, response) => {
    if (!artifacts.get(request.params.id)) return response.status(404).json({ error: 'Published artifact not found.' });
    response.json({ comments: artifacts.listComments(request.params.id) });
  });

  router.patch('/api/artifacts/:id/comments/:commentId', (request, response) => {
    const resolved = z.object({ resolved: z.boolean() }).parse(request.body).resolved;
    const comment = artifacts.resolveComment(request.params.id, request.params.commentId, resolved);
    if (!comment) return response.status(404).json({ error: 'Feedback not found.' });
    response.json({ comment });
  });

  return router;
}
