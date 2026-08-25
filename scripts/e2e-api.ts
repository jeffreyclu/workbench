import express from 'express';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { WorkItemRepository } from '../src/server/repository.js';
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
harness.use(app);

const server = createServer(harness);
attachRealtimeServer(server);
server.listen(port, '127.0.0.1', () => {
  console.log(`Workbench e2e API listening on http://127.0.0.1:${port}`);
});
