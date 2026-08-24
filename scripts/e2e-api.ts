import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { e2eRuntimeCapabilities } from '../src/server/runtime-capabilities.js';
import { createServer } from 'node:http';
import { attachRealtimeServer } from '../src/server/realtime.js';

const port = Number(process.env.PORT ?? 45176);
// Always an in-memory, freshly migrated database: Playwright runs must never
// touch data/workbench.db or leave state behind between runs.
const database = openDatabase(':memory:');
const app = createApp(database, e2eRuntimeCapabilities);

const server = createServer(app);
attachRealtimeServer(server);
server.listen(port, '127.0.0.1', () => {
  console.log(`Workbench e2e API listening on http://127.0.0.1:${port}`);
});
