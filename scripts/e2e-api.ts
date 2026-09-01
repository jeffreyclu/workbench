import express from 'express';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { WorkItemRepository } from '../src/server/repository.js';
import { classificationForKind } from '../src/server/agent-runner.js';
import { e2eRuntimeCapabilities } from '../src/server/runtime-capabilities.js';
import { createServer } from 'node:http';
import { attachRealtimeServer } from '../src/server/realtime.js';

const port = Number(process.env.PORT ?? 45176);
// Always an in-memory, freshly migrated database: Playwright runs must never
// touch data/workbench.db or leave state behind between runs.
const database = openDatabase(':memory:');
const app = createApp(database, e2eRuntimeCapabilities);

// Test-only seeding, mounted ahead of the real app and living only in this
// script — never in the shipped server. Agent-authored and mid-run messages
// can't be produced over the public API here (executeAgents is off for e2e),
// but those are precisely the bubbles whose phone layout has to be asserted.
const harness = express();
const seedRepository = new WorkItemRepository(database);
harness.use(express.json({ limit: '10mb' }));
harness.post('/api/e2e/seed-message', (request, response) => {
  const { conversationId, author, body, status } = request.body ?? {};
  response.status(201).json({ message: seedRepository.createSharedMessage(author, body, status ?? 'completed', conversationId) });
});
harness.post('/api/e2e/update-message', (request, response) => {
  const { id, body, status } = request.body ?? {};
  response.status(200).json({ message: seedRepository.updateSharedMessage(id, { body, status }) });
});
harness.post('/api/work-items/:id/execute', (request, response) => {
  const item = seedRepository.get(request.params.id);
  if (!item) return response.status(404).json({ error: 'Work item not found.' });
  if (request.body?.fail) return response.status(503).json({ error: 'Agent service is unavailable.' });
  const kind = ['research', 'analysis', 'strategy', 'execute', 'review', 'bugfix'].includes(item.classificationKind ?? '')
    ? item.classificationKind as 'research' | 'analysis' | 'strategy' | 'execute' | 'review' | 'bugfix'
    : 'execute';
  const classification = classificationForKind(item, kind);
  const conversation = seedRepository.getOrCreateWorkConversation(item.id, item.title);
  const reply = seedRepository.createSharedMessage(classification.agent, '', 'running', conversation.id);
  const run = seedRepository.createRun(item.id, classification.kind, 'auto', classification.agent, classification.instructions, conversation.id, reply.id);
  seedRepository.update(item.id, { status: 'in_progress' }, false, { actor: 'system', source: 'e2e' });
  const activity = seedRepository.addActivity(item.id, 'system', 'execution_started', 'E2E simulated agent execution started.');
  response.json({ run, runs: [run], classification, conversation, activity });
});
harness.post('/api/e2e/complete-run', (request, response) => {
  const run = seedRepository.getRun(request.body?.runId);
  if (!run || !run.messageId) return response.status(404).json({ error: 'Run not found.' });
  const output = typeof request.body?.output === 'string' ? request.body.output : 'E2E agent output completed.';
  seedRepository.updateRun(run.id, { status: 'completed', output, completedAt: new Date().toISOString() });
  const message = seedRepository.updateSharedMessage(run.messageId, { body: output, status: 'completed' });
  response.json({ message });
});
harness.get('/api/github/pull-request-diff', (request, response) => {
  if (request.query.url === 'https://github.com/example/workbench/pull/404') return response.status(404).json({ error: 'Pull request not found.' });
  response.json({ diff: {
    url: String(request.query.url), repository: 'example/workbench', number: 42, title: 'Add reliable reconnect handling', baseRef: 'main', headRef: 'feature/reconnect', headSha: 'e2e-pr-head', revision: 'e2e-pr-head', state: 'open', draft: false, mergeableState: 'clean', reviewDecision: 'review_required', reviewDecisionError: null, changedFiles: 1, additions: 2, deletions: 1, comments: { available: true, total: 0, partial: false, byPath: {}, comments: [], error: null }, files: [{ path: 'src/realtime.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1, isBinary: false, patch: '@@ -1,2 +1,3 @@\n-export const reconnect = false;\n+export const reconnect = true;\n+export const retryDelay = 1000;' }], nextPage: null,
  } });
});
harness.post('/api/e2e/commit-and-push', (request, response) => {
  if (request.body?.fail) return response.status(502).json({ error: 'Commit created, but push failed. remote: permission denied' });
  response.json({ result: { committed: true, pushed: true, commit: 'e2e1234' } });
});
harness.use(app);

const server = createServer(harness);
attachRealtimeServer(server);
server.listen(port, '127.0.0.1', () => {
  console.log(`Workbench e2e API listening on http://127.0.0.1:${port}`);
});
