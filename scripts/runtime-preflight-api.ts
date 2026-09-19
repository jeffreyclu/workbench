import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { e2eRuntimeCapabilities } from '../src/server/runtime-capabilities.js';
import { shutdownMemoryIndexMaintenance } from '../src/server/memory-index-maintenance.js';
import { shutdownMemorySemanticWorker } from '../src/server/memory-semantic-worker.js';

const port = Number(process.env.PORT);
const database = openDatabase();
const server = createServer(createApp(database, e2eRuntimeCapabilities));

server.listen(port, '127.0.0.1', () => {
  console.log(`Workbench runtime preflight listening on http://127.0.0.1:${port}`);
});

const shutdown = () => server.close(() => {
  shutdownMemoryIndexMaintenance();
  shutdownMemorySemanticWorker();
  database.close();
  process.exit(0);
});

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
