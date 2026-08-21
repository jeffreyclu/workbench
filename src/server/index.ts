import 'dotenv/config';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { startScheduler } from './scheduler.js';
import { startRuntimePromotionWorker } from './runtime-promotion-worker.js';
import { warmFastTaskDraftModel } from './fast-task-draft-ai.js';

const port = Number(process.env.PORT ?? 4317);
const database = openDatabase();
const app = createApp(database);

// Recover in-flight work left behind by a previous process (crash, deploy, restart)
// and keep retrying/dispatching queued work going forward. Must start before the
// server accepts traffic so nothing queued while the process was down sits idle.
const repository = new WorkItemRepository(database);
startScheduler(repository);
startRuntimePromotionWorker(database, repository);
warmFastTaskDraftModel();

app.listen(port, () => {
  console.log(`Workbench API listening on http://localhost:${port}`);
});
