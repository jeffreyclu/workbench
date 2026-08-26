import { Router } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { ZodError, z } from 'zod';
import {
  bulkWorkItemActionSchema,
  createActivitySchema,
  createSavedWorkItemFilterSchema,
  createWorkItemLinkSchema,
  createWorkItemReferenceSchema,
  createWorkItemSchema,
  diffConfidenceRequestSchema,
  generateTaskDraftSchema,
  providerSyncConflictResolutionSchema,
  providerSyncFieldSchema,
  runKindSchema,
  savedWorkItemFilterViewSchema,
  unblockWorkItemSchema,
  updateSavedWorkItemFilterSchema,
  updateWorkItemSchema,
  VERSION_CONFLICT_CODE,
  workItemFilterSchema,
  resolveSourceUrlSchema,
  searchSourcesSchema,
} from '../../shared/contracts.js';
import { classificationForKind } from '../agent-runner.js';
import { resolveWorkingDirectory } from '../agent-runner.js';
import { summarizeWorkItemChanges } from '../activity-log.js';
import { resolveBrokerUrl, searchBrokerSources } from '../connection-broker.js';
import { generateFastAiTaskDraft } from '../fast-task-draft-ai.js';
import { assessDiffBlocks } from '../diff-confidence-ai.js';
import { commitAndPushWorkspace, getWorkspaceDiff, getWorkspaceDiffRevision } from '../workspace-diff.js';
import { WorkItemDependencyError, WorkItemVersionConflictError } from '../repository.js';
import type { RouteContext } from '../route-context.js';

export function createWorkItemRouter({ repository }: RouteContext) {
  const router = Router();
  router.post('/api/diff-confidence', async (request, response, next) => {
    try {
      const { blocks } = diffConfidenceRequestSchema.parse(request.body);
      response.json({ assessments: await assessDiffBlocks(blocks) });
    } catch (error) { next(error); }
  });
  const persistAttachments = (attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }>) => {
    const directory = resolve('data/attachments');
    mkdirSync(directory, { recursive: true });
    return attachments.map((attachment) => {
      const safeName = basename(attachment.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = resolve(directory, `${randomUUID()}-${safeName}`);
      writeFileSync(path, Buffer.from(attachment.dataBase64, 'base64'));
      return { name: attachment.name, path, mimeType: attachment.mimeType, size: attachment.size };
    });
  };
  router.get('/api/work-items/:id/workspace-diff', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const diff = await getWorkspaceDiff(resolveWorkingDirectory(item));
      repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff);
      response.json({ diff });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/snapshots', (request, response) => {
    if (!repository.get(request.params.id)) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ snapshots: repository.listWorkspaceDiffSnapshots({ workItemId: request.params.id }) });
  });
  router.get('/api/work-items/:id/workspace-diff/status', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const revision = await getWorkspaceDiffRevision(resolveWorkingDirectory(item));
      response.json({ changed: revision !== request.query.revision });
    } catch (error) { next(error); }
  });
  router.post('/api/work-items/:id/workspace-diff/commit-and-push', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const { revision } = z.object({ revision: z.string().trim().min(1) }).parse(request.body);
      const result = await commitAndPushWorkspace(resolveWorkingDirectory(item), `chore: ${item.title}`, revision);
      response.json({ result });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items', (request, response) => {
    const view = request.query.view === 'workbench-archive' ? 'workbench-archive' : request.query.view === 'archive' ? 'archive' : request.query.view === 'workbench' ? 'workbench' : 'active';
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

  router.get('/api/work-item-filters', (request, response) => {
    const view = request.query.view === undefined ? undefined : savedWorkItemFilterViewSchema.parse(request.query.view);
    response.json({ filters: repository.listSavedFilters(view) });
  });

  router.post('/api/work-item-filters', (request, response) => {
    try { response.status(201).json({ filter: repository.createSavedFilter(createSavedWorkItemFilterSchema.parse(request.body)) }); }
    catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return response.status(409).json({ error: 'A saved filter with this name already exists in this view.' });
      throw error;
    }
  });

  router.patch('/api/work-item-filters/:id', (request, response) => {
    try {
      const filter = repository.updateSavedFilter(request.params.id, updateSavedWorkItemFilterSchema.parse(request.body));
      if (!filter) return response.status(404).json({ error: 'Saved filter not found.' });
      response.json({ filter });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return response.status(409).json({ error: 'A saved filter with this name already exists in this view.' });
      throw error;
    }
  });

  router.delete('/api/work-item-filters/:id', (request, response) => {
    if (!repository.deleteSavedFilter(request.params.id)) return response.status(404).json({ error: 'Saved filter not found.' });
    response.status(204).end();
  });

  router.get('/api/work-item-counts', (_request, response) => {
    response.json(repository.getWorkItemCounts());
  });

  // The canonical project vocabulary. Backs the picker, so choosing an existing
  // project is a tap rather than a retyped name.
  router.get('/api/projects', (_request, response) => {
    response.json({ projects: repository.listProjects() });
  });

  router.get('/api/work-items-archive', (_request, response) => {
    response.json({ items: repository.listArchived() });
  });

  // Phase 1a of docs/autonomy-strategy.md: measure this week's Sonnet-equivalent
  // token spend per provider, split manual vs autonomous. No dispatch or
  // guardrail logic reads this yet — it exists to prove the number is real
  // before anything is built against it.
  router.get('/api/work-items/:id', (request, response) => {
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

  router.get('/api/work-items/:id/dependency-candidates', (request, response) => {
    if (!repository.get(request.params.id)) return response.status(404).json({ error: 'Work item not found.' });
    const query = z.string().trim().max(500).catch('').parse(request.query.q);
    response.json({ items: repository.searchDependencyCandidates(request.params.id, query) });
  });

  router.post('/api/work-items/:id/references', (request, response) => {
    const input = createWorkItemReferenceSchema.parse(request.body);
    try {
      response.status(201).json({ reference: repository.addReference(request.params.id, input) });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : 'Task not found.' });
    }
  });

  router.post('/api/work-items/:id/linked-tasks', (request, response) => {
    try {
      const linkedTask = repository.addTaskLink(request.params.id, createWorkItemLinkSchema.parse(request.body).linkedWorkItemId);
      response.status(201).json({ item: linkedTask });
    } catch (error) {
      response.status(error instanceof ZodError ? 400 : 404).json({ error: error instanceof Error ? error.message : 'Could not link task.' });
    }
  });

  router.delete('/api/work-items/:id/linked-tasks/:linkedTaskId', (request, response) => {
    if (!repository.removeTaskLink(request.params.id, request.params.linkedTaskId)) return response.status(404).json({ error: 'Task link not found.' });
    response.status(204).end();
  });

  router.delete('/api/work-items/:id/references/:referenceId', (request, response) => {
    const removed = repository.removeReference(request.params.id, request.params.referenceId);
    if (!removed) return response.status(404).json({ error: 'Reference not found.' });
    response.status(204).end();
  });

  router.post('/api/work-items/:id/classify', (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    const { kind } = z.object({ kind: runKindSchema }).parse(request.body);
    const classification = repository.setClassification(item.id, classificationForKind(item, kind), 'manual');
    repository.addActivity(item.id, 'jeffrey', 'classification', `Set task type to ${classification.kind}.`);
    response.json({ classification });
  });

  router.post('/api/work-items', (request, response) => {
    const input = createWorkItemSchema.parse(request.body);
    const { classificationKind, attachments, ...workItemInput } = input;
    const item = repository.create({ ...workItemInput, attachments: persistAttachments(attachments) });
    if (classificationKind) {
      repository.setClassification(item.id, classificationForKind(item, classificationKind), 'manual');
      repository.addActivity(item.id, 'jeffrey', 'classification', `Set task type to ${classificationKind}.`);
    }
    response.status(201).json({ item: { ...item, classificationKind: classificationKind ?? null, classificationComplex: false } });
  });

  router.post('/api/work-items/:id/follow-ups', (request, response) => {
    const input = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(20_000).default('') }).parse(request.body);
    const item = repository.createFollowUp(request.params.id, input.title, input.description);
    if (!item) return response.status(404).json({ error: 'Parent task not found.' });
    response.status(201).json({ item });
  });

  router.post('/api/work-items/:id/attachments', (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    const attachments = createWorkItemSchema.shape.attachments.parse(request.body.attachments);
    const existingAttachments = item.attachments ?? [];
    if (existingAttachments.length + attachments.length > 10) return response.status(400).json({ error: 'A task can have at most 10 attachments.' });
    const updated = repository.update(item.id, { attachments: [...existingAttachments, ...persistAttachments(attachments)] }, false, { actor: 'jeffrey', source: 'http' })!;
    repository.addActivity(item.id, 'jeffrey', 'attachment_added', `Added ${attachments.length} task attachment${attachments.length === 1 ? '' : 's'}.`);
    response.status(201).json({ item: updated });
  });

  router.delete('/api/work-items/:id/attachments/:attachmentPath', (request, response) => {
    const item = repository.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    const existingAttachments = item.attachments ?? [];
    const attachments = existingAttachments.filter((attachment) => attachment.path !== request.params.attachmentPath);
    if (attachments.length === existingAttachments.length) return response.status(404).json({ error: 'Attachment not found.' });
    const updated = repository.update(item.id, { attachments }, false, { actor: 'jeffrey', source: 'http' })!;
    repository.addActivity(item.id, 'jeffrey', 'attachment_removed', 'Removed a task attachment.');
    response.json({ item: updated });
  });

  router.get('/api/work-items/:id/attachments/:attachmentPath', (request, response) => {
    const item = repository.get(request.params.id);
    const attachment = item?.attachments?.find((entry) => entry.path === request.params.attachmentPath);
    if (!attachment) return response.status(404).json({ error: 'Attachment not found.' });
    response.type(attachment.mimeType);
    response.setHeader('Content-Disposition', `inline; filename="${basename(attachment.name).replace(/["\\]/g, '_')}"`);
    response.sendFile(attachment.path);
  });

  router.post('/api/work-items/bulk', (request, response) => {
    response.json(repository.bulkUpdate(bulkWorkItemActionSchema.parse(request.body)));
  });

  router.post('/api/work-items/generate-draft', async (request, response, next) => {
    try {
      const input = generateTaskDraftSchema.parse(request.body);
      response.json({ draft: await generateFastAiTaskDraft(input.prompt) });
    } catch (error) { next(error); }
  });

  router.post('/api/sources/resolve', async (request, response, next) => {
    try {
      const input = resolveSourceUrlSchema.parse(request.body);
      response.json({ draft: await resolveBrokerUrl(repository, input.url) });
    } catch (error) { next(error); }
  });

  router.post('/api/sources/search', async (request, response, next) => {
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const input = searchSourcesSchema.parse(request.body);
      response.json(await searchBrokerSources(repository, input.query, input.sources, controller.signal));
    } catch (error) { if (!controller.signal.aborted) next(error); }
  });

  router.patch('/api/work-items/:id', (request, response) => {
    const input = updateWorkItemSchema.parse(request.body);
    const existing = repository.get(request.params.id);
    if (!existing) return response.status(404).json({ error: 'Work item not found.' });
    let item;
    try {
      item = repository.update(request.params.id, input, false, { actor: 'jeffrey', source: 'http' });
    } catch (error) {
      if (error instanceof WorkItemVersionConflictError) {
        return response.status(409).json({ error: error.message, code: VERSION_CONFLICT_CODE, item: error.item });
      }
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

  router.post('/api/work-items/:id/unblock', (request, response) => {
    const input = unblockWorkItemSchema.parse(request.body);
    let item;
    try {
      item = repository.unblock(request.params.id, input.reason);
    } catch (error) {
      if (error instanceof WorkItemDependencyError) {
        return response.status(409).json({ error: error.message, code: error.code });
      }
      throw error;
    }
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  router.post('/api/work-items/:id/provider-conflicts/:field/resolve', (request, response) => {
    const field = providerSyncFieldSchema.parse(request.params.field);
    const { resolution } = providerSyncConflictResolutionSchema.parse(request.body);
    const item = repository.resolveProviderConflict(request.params.id, field, resolution);
    if (!item) return response.status(404).json({ error: 'Provider conflict not found.' });
    response.json({ item, providerConflicts: repository.listProviderConflicts(item.id) });
  });

  router.post('/api/work-items/:id/archive', (request, response) => {
    const item = repository.archive(request.params.id, false, false, { actor: 'jeffrey' });
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  router.post('/api/work-items/:id/restore', (request, response) => {
    const item = repository.restore(request.params.id, false, { actor: 'jeffrey' });
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  router.post('/api/work-items/:id/complete', (request, response) => {
    const item = repository.archive(request.params.id, true, false, { actor: 'jeffrey' });
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    response.json({ item });
  });

  router.delete('/api/work-items/:id', (request, response) => {
    if (!repository.delete(request.params.id)) return response.status(404).json({ error: 'Work item not found.' });
    repository.addAuditEntry('destructive_action', 'workbench', `Deleted work item ${request.params.id}`, request.params.id);
    response.status(204).end();
  });

  router.post('/api/work-items/:id/activity', (request, response) => {
    if (!repository.get(request.params.id)) {
      return response.status(404).json({ error: 'Work item not found.' });
    }
    const input = createActivitySchema.parse(request.body);
    response.status(201).json({ activity: repository.addActivity(request.params.id, input.actor, input.kind, input.body) });
  });

  return router;
}
