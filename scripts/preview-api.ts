import 'dotenv/config';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { WorkItemRepository } from '../src/server/repository.js';
import { warmFastTaskDraftModel } from '../src/server/fast-task-draft-ai.js';
import { previewRuntimeCapabilities } from '../src/server/runtime-capabilities.js';

const port = Number(process.env.PORT ?? 45175);
const database = openDatabase();
// Cost backfill is idempotent and only fills a derived column, so it is safe for
// preview to run against shared state. Without it the preview's cost history would
// be empty until the stable runtime restarts.
new WorkItemRepository(database).backfillEstimatedCosts();
const app = createApp(database, previewRuntimeCapabilities);
warmFastTaskDraftModel();

// Preview shares live state, but deliberately does not start a second scheduler.
// Agent ownership remains with the stable runtime while preview exercises the
// matching source API and client together.
app.listen(port, '127.0.0.1', () => {
  console.log(`Workbench preview API listening on http://127.0.0.1:${port}`);
});
