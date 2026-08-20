import 'dotenv/config';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { startScheduler } from './scheduler.js';

const port = Number(process.env.PORT ?? 4317);
const database = openDatabase();
const app = createApp(database);

// Recover in-flight work left behind by a previous process (crash, deploy, restart)
// and keep retrying/dispatching queued work going forward. Must start before the
// server accepts traffic so nothing queued while the process was down sits idle.
startScheduler(new WorkItemRepository(database));

app.listen(port, () => {
  console.log(`Workbench API listening on http://localhost:${port}`);
});
