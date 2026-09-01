import { Router } from 'express';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
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
  reviewAssistRequestSchema,
  runKindSchema,
  savedWorkItemFilterViewSchema,
  unblockWorkItemSchema,
  upsertDiffBlockReviewSchema,
  upsertDiffHunkReviewsSchema,
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
import { assessDiffBlocks, lookupDiffConfidenceBlocks } from '../diff-confidence-ai.js';
import { lookupReviewAssist, requestReviewAssist } from '../review-assist-ai.js';
import { ensureReviewAutoScore, reviewAutoScoreView } from '../review-auto-score.js';
import { findStaleReferences } from '../stale-references.js';
import { commitAndPushWorkspace, getWorkspaceCommitDiff, getWorkspaceDiff, getWorkspaceDiffRevision, getWorkspaceFileSource, getWorkspaceHeadCommit, getWorkspaceRefDiff, listWorkspaceRefCommits, listWorkspaceRefs, repositoryIdentity, snapshotsForRepository } from '../workspace-diff.js';
import { captureRecordedWorkspaceDiffSnapshots } from '../workspace-diff-history.js';
import { WorkItemDependencyError, WorkItemVersionConflictError } from '../repository.js';
import type { RouteContext } from '../route-context.js';

export function createWorkItemRouter({ repository, database }: RouteContext) {
  const router = Router();
  const taskWorkspaces = (workItemId: string) => {
    const item = repository.get(workItemId);
    if (!item) return null;
    const usableWorkspace = (workspacePath: string | null | undefined) => {
      if (!workspacePath) return null;
      const path = resolve(workspacePath);
      try { return existsSync(path) && statSync(path).isDirectory() ? path : null; }
      catch { return null; } // The collector may remove a run worktree mid-request.
    };
    const isRunWorktree = (workspacePath: string | null) => Boolean(workspacePath?.includes('/.workbench/run-worktrees/'));
    const selected = database.prepare('SELECT workspace_path FROM work_item_workspace_selection WHERE work_item_id = ?').get(workItemId) as { workspace_path: string } | undefined;
    const root = dirname(process.cwd());
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(join(root, entry.name)))
      .filter((path) => existsSync(join(path, '.git')) || existsSync(join(path, 'package.json')));
    const runWorkspaces = repository.listRuns(item.id)
      .filter((run) => (run.status === 'queued' || run.status === 'running') && usableWorkspace(run.resolvedWorkspace))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const activeRunWorkspace = runWorkspaces.find((run) => run.status === 'queued' || run.status === 'running')?.resolvedWorkspace ?? null;
    const latestRunWorkspace = usableWorkspace(activeRunWorkspace) ?? usableWorkspace(runWorkspaces[0]?.resolvedWorkspace);
    const defaultPath = latestRunWorkspace ?? usableWorkspace(resolveWorkingDirectory(item));
    if (defaultPath && !candidates.includes(defaultPath)) candidates.unshift(defaultPath);
    const savedPath = usableWorkspace(selected?.workspace_path);
    const savedPathIsUsable = Boolean(savedPath && candidates.includes(savedPath) && !isRunWorktree(savedPath));
    const selectedPath = latestRunWorkspace ?? (savedPathIsUsable ? savedPath : defaultPath);
    // Persist recovery from a garbage-collected run worktree. Otherwise one
    // device can keep reintroducing a dead selection on every other device.
    if (selected && !savedPathIsUsable) {
      if (selectedPath) database.prepare(`INSERT INTO work_item_workspace_selection (work_item_id, workspace_path, updated_at)
        VALUES (?, ?, ?) ON CONFLICT(work_item_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`)
        .run(workItemId, selectedPath, new Date().toISOString());
      else database.prepare('DELETE FROM work_item_workspace_selection WHERE work_item_id = ?').run(workItemId);
    }
    return { selectedPath, workspaces: candidates.map((path) => ({ path, label: path === defaultPath && latestRunWorkspace ? `${basename(resolveWorkingDirectory(item))} · agent worktree` : basename(path), selected: path === selectedPath })) };
  };
  const taskWorkingDirectory = (workItemId: string) => taskWorkspaces(workItemId)?.selectedPath ?? null;
  router.post('/api/diff-confidence', async (request, response, next) => {
    try {
      const { blocks } = diffConfidenceRequestSchema.parse(request.body);
      response.json({ assessments: await assessDiffBlocks(database, blocks) });
    } catch (error) { next(error); }
  });
  // Cache-only: never spawns a model turn. Lets the client show an
  // already-computed score the instant a hunk is opened, without the on-demand
  // "Score risk (AI)" flow turning ambient just because a cache exists.
  router.post('/api/diff-confidence/lookup', (request, response, next) => {
    try {
      const { blocks } = diffConfidenceRequestSchema.parse(request.body);
      response.json({ assessments: lookupDiffConfidenceBlocks(database, blocks) });
    } catch (error) { next(error); }
  });
  router.post('/api/review-assist', async (request, response, next) => {
    try {
      const { action, decision, taskIntent, tier } = reviewAssistRequestSchema.parse(request.body);
      response.json({ answer: await requestReviewAssist(database, action, decision, taskIntent, undefined, tier) });
    } catch (error) { next(error); }
  });
  // Streams the answer token by token over SSE. The full turn still takes a
  // couple of seconds, but the reviewer starts reading after the first one
  // instead of watching a spinner; the completed answer is persisted by
  // requestReviewAssist exactly as the non-streaming route does.
  router.post('/api/review-assist/stream', async (request, response, next) => {
    let parsed;
    try {
      parsed = reviewAssistRequestSchema.parse(request.body);
    } catch (error) { next(error); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();
    const send = (event: { type: 'delta'; text: string } | { type: 'done'; answer: string } | { type: 'error'; message: string }) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      const answer = await requestReviewAssist(database, parsed.action, parsed.decision, parsed.taskIntent, (text) => send({ type: 'delta', text }), parsed.tier);
      send({ type: 'done', answer });
    } catch (error) {
      // A failed turn must stay a visible failure the reviewer can retry, not
      // an empty answer that reads like the model had nothing to say.
      send({ type: 'error', message: error instanceof Error ? error.message : 'AI review assist failed.' });
    }
    response.end();
  });
  // What a Changes pane should show for one revision: every score already
  // persisted in the assist cache, plus the live job's progress and failures.
  // Reading the cache here is what stops a reopened tab, or a pane that
  // outlived a runtime restart, from paying for answers it already has.
  router.get('/api/review-assist/auto-score', async (request, response, next) => {
    try {
      const query = z.object({
        workItemId: z.string().trim().min(1).optional(),
        conversationId: z.string().trim().min(1).optional(),
        revision: z.string().trim().min(1),
      }).refine((value) => Boolean(value.workItemId) !== Boolean(value.conversationId), 'Provide exactly one of workItemId or conversationId.')
        .parse(request.query);
      const scope = query.workItemId ? { workItemId: query.workItemId } : { conversationId: query.conversationId! };
      ensureReviewAutoScore(repository, scope, query.revision);
      response.json({ snapshot: await reviewAutoScoreView(repository, scope, query.revision) });
    } catch (error) { next(error); }
  });
  // Cache-only: never spawns a model turn. See /api/diff-confidence/lookup.
  router.post('/api/review-assist/lookup', (request, response, next) => {
    try {
      const { action, decision, taskIntent, tier } = reviewAssistRequestSchema.parse(request.body);
      response.json({ answer: lookupReviewAssist(database, action, decision, taskIntent, tier) });
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
  router.get('/api/work-items/:id/workspaces', (request, response) => {
    const explorer = taskWorkspaces(request.params.id);
    if (!explorer) return response.status(404).json({ error: 'Work item not found.' });
    response.json(explorer);
  });
  router.put('/api/work-items/:id/workspaces/selection', (request, response) => {
    const explorer = taskWorkspaces(request.params.id);
    if (!explorer) return response.status(404).json({ error: 'Work item not found.' });
    const workspacePath = resolve(z.object({ workspacePath: z.string().trim().min(1).max(1_000) }).parse(request.body).workspacePath);
    if (!explorer.workspaces.some((workspace) => workspace.path === workspacePath) || !existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) return response.status(400).json({ error: 'Select a repository from this local workspace.' });
    database.prepare(`INSERT INTO work_item_workspace_selection (work_item_id, workspace_path, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(work_item_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`)
      .run(request.params.id, workspacePath, new Date().toISOString());
    response.json({ selectedPath: workspacePath, workspaces: explorer.workspaces.map((workspace) => ({ ...workspace, selected: workspace.path === workspacePath })) });
  });
  router.get('/api/work-items/:id/workspace-diff', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      const [diff, commitHash, identity] = await Promise.all([getWorkspaceDiff(workingDirectory), getWorkspaceHeadCommit(workingDirectory), repositoryIdentity(workingDirectory)]);
      if (diff.changedFiles > 0) repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff, { originatingAgentRunId: repository.latestAgentRunForSnapshot({ workItemId: item.id })?.id ?? null, commitHash, repositoryIdentity: identity });
      response.json({ diff });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/snapshots', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id) ?? resolveWorkingDirectory(item);
      await captureRecordedWorkspaceDiffSnapshots(
        repository,
        { workItemId: item.id },
        workingDirectory,
        repository.listConversationsForWorkItem(item.id).map((conversation) => conversation.id),
      );
      response.json({ snapshots: await snapshotsForRepository(repository.listWorkspaceDiffSnapshots({ workItemId: item.id }), workingDirectory) });
    } catch (error) { next(error); }
  });

  // Branches and worktrees are more review sources, not another view: both
  // answer with the same WorkspaceDiff the working tree does.
  router.get('/api/work-items/:id/workspace-diff/refs', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      response.json({ refs: await listWorkspaceRefs(workingDirectory) });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/ref', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      const ref = typeof request.query.ref === 'string' ? request.query.ref : '';
      if (!ref) return response.status(400).json({ error: 'Specify which branch or worktree to review.' });
      response.json({ diff: await getWorkspaceRefDiff(workingDirectory, ref) });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/ref/commits', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      const ref = typeof request.query.ref === 'string' ? request.query.ref : '';
      if (!ref) return response.status(400).json({ error: 'Specify which branch to list commits for.' });
      response.json({ commits: await listWorkspaceRefCommits(workingDirectory, ref) });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/commit', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      const commit = z.string().trim().min(1).max(200).parse(request.query.commit);
      response.json({ diff: await getWorkspaceCommitDiff(workingDirectory, commit) });
    } catch (error) { next(error); }
  });
  // The one review check that has to read outside the patch: a reference the
  // change forgot to update is, by definition, in a file the diff does not
  // contain. Served separately from the diff itself because it spawns a grep
  // per changed symbol and the diff must stay fast.
  router.get('/api/work-items/:id/workspace-diff/stale-references', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      response.json({ report: await findStaleReferences(workingDirectory) });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/status', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      const revision = await getWorkspaceDiffRevision(workingDirectory);
      response.json({ changed: revision !== request.query.revision });
    } catch (error) { next(error); }
  });

  router.get('/api/work-items/:id/workspace-diff/file', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before viewing changes.' });
      const path = typeof request.query.path === 'string' ? request.query.path : '';
      const revision = typeof request.query.revision === 'string' && request.query.revision ? request.query.revision : null;
      response.json({ file: await getWorkspaceFileSource(workingDirectory, path, revision) });
    } catch (error) { next(error); }
  });
  router.post('/api/work-items/:id/workspace-diff/commit-and-push', async (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const { revision, message } = z.object({ revision: z.string().trim().min(1), message: z.string().trim().min(1).optional() }).parse(request.body);
      const workingDirectory = taskWorkingDirectory(item.id);
      if (!workingDirectory) return response.status(409).json({ error: 'Select a repository in Repo Explorer before committing.' });
      const result = await commitAndPushWorkspace(workingDirectory, message ?? `chore: ${item.title}`, revision);
      response.json({ result });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/hunk-reviews', (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const revision = z.string().trim().min(1).parse(request.query.revision);
      response.json({ reviews: repository.listDiffHunkReviews({ workItemId: item.id }, revision) });
    } catch (error) { next(error); }
  });
  router.put('/api/work-items/:id/workspace-diff/hunk-reviews', (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const input = z.object({
        revision: z.string().trim().min(1),
        filePath: z.string().trim().min(1),
        hunkRange: z.string().trim().min(1),
        contentHash: z.string().trim().min(1).max(64),
        state: z.enum(['reviewed', 'needs_changes', 'commented']),
        note: z.string().trim().min(1).optional(),
      }).parse(request.body);
      response.json({ review: repository.upsertDiffHunkReview({ workItemId: item.id }, input) });
    } catch (error) { next(error); }
  });
  router.put('/api/work-items/:id/workspace-diff/hunk-reviews/batch', (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const input = upsertDiffHunkReviewsSchema.parse(request.body);
      response.json({ reviews: repository.upsertDiffHunkReviews({ workItemId: item.id }, input) });
    } catch (error) { next(error); }
  });
  router.get('/api/work-items/:id/workspace-diff/block-reviews', (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const revision = z.string().trim().min(1).parse(request.query.revision);
      response.json({ reviews: repository.listDiffBlockReviews({ workItemId: item.id }, revision) });
    } catch (error) { next(error); }
  });
  router.put('/api/work-items/:id/workspace-diff/block-reviews', (request, response, next) => {
    try {
      const item = repository.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'Work item not found.' });
      const input = upsertDiffBlockReviewSchema.parse(request.body);
      response.json({ review: repository.upsertDiffBlockReview({ workItemId: item.id }, input) });
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

  router.post('/api/work-items/:id/undelete', (request, response) => {
    const item = repository.undeleteWorkItem(request.params.id);
    if (!item) return response.status(404).json({ error: 'Work item not found.' });
    repository.addAuditEntry('destructive_action', 'workbench', `Restored deleted work item ${request.params.id}`, request.params.id);
    response.json({ item });
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
