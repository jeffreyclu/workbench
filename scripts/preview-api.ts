import 'dotenv/config';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { warmFastTaskDraftModel } from '../src/server/fast-task-draft-ai.js';

const port = Number(process.env.PORT ?? 45175);
const app = createApp(openDatabase());
warmFastTaskDraftModel();

// Preview shares live state, but deliberately does not start a second scheduler.
// Agent ownership remains with the stable runtime while preview exercises the
// matching source API and client together.
app.listen(port, '127.0.0.1', () => {
  console.log(`Workbench preview API listening on http://127.0.0.1:${port}`);
});
