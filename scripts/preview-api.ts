import 'dotenv/config';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { WorkItemRepository } from '../src/server/repository.js';
import { warmFastTaskDraftModel } from '../src/server/fast-task-draft-ai.js';
import { previewRuntimeCapabilities } from '../src/server/runtime-capabilities.js';
import { createServer } from 'node:http';
import { attachRealtimeServer } from '../src/server/realtime.js';

const port = Number(process.env.PORT ?? 45175);
const database = openDatabase();
// Preview always runs against the disposable snapshot prepared immediately before
// startup. It may exercise schema migrations without mutating production state.
new WorkItemRepository(database).backfillEstimatedCosts();
const app = createApp(database, previewRuntimeCapabilities);
warmFastTaskDraftModel();

// Preview starts from a fresh production snapshot but deliberately does not start
// a second scheduler. Agent ownership and durable mutations remain with live.
const server = createServer(app);
attachRealtimeServer(server);
server.listen(port, '127.0.0.1', () => {
  console.log(`Workbench preview API listening on http://127.0.0.1:${port}`);
});
