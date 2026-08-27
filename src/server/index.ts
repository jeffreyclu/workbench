import 'dotenv/config';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { OWNER_ID, startScheduler } from './scheduler.js';
import { startRuntimePromotionWorker } from './runtime-promotion-worker.js';
import { shutdownFastTaskDraftModel, warmFastTaskDraftModel } from './fast-task-draft-ai.js';
import { shutdownDiffConfidenceModel, warmDiffConfidenceModel } from './diff-confidence-ai.js';
import { liveRuntimeCapabilities } from './runtime-capabilities.js';
import { createServer } from 'node:http';
import { attachRealtimeServer } from './realtime.js';
import { collectMemoryDocuments, indexPendingMemory } from './memory-index.js';
import { shutdownActiveAgentProcesses } from './agent-runner.js';

const port = Number(process.env.PORT ?? 4317);
const database = openDatabase();
const app = createApp(database, liveRuntimeCapabilities);

// Recover in-flight work left behind by a previous process (crash, deploy, restart)
// and keep retrying/dispatching queued work going forward. Must start before the
// server accepts traffic so nothing queued while the process was down sits idle.
const repository = new WorkItemRepository(database);
if (liveRuntimeCapabilities.ownScheduler) startScheduler(repository);
if (liveRuntimeCapabilities.promoteRuntime) startRuntimePromotionWorker(repository);
warmFastTaskDraftModel();
warmDiffConfidenceModel();

// Keeps the vectorized memory index (memory-index.ts) warm so the very first
// /api/activity-memory or /api/memory/search call after a restart does not
// pay for a cold collect+embed pass. Deliberately not awaited: embedding the
// full corpus can take longer than an acceptable boot time, and this is a
// best-effort enrichment on top of the repository's own per-call refresh
// (searchActivityMemory), never a dependency the server needs to start
// serving traffic. Runs in this process only -- no detached process, no
// background spawn -- so it stops the instant this process exits.
void (async () => {
  try {
    collectMemoryDocuments(database);
    await indexPendingMemory(database, { limit: 2_000 });
  } catch (error) {
    console.error('[memory-index] startup indexing failed; will retry on next search', error);
  }
})();

const server = createServer(app);
attachRealtimeServer(server);
server.listen(port, () => {
  console.log(`Workbench API listening on http://localhost:${port}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // A promotion is an intentional interruption, not a crash. Persist the
  // terminal state before killing child process groups so the next runtime
  // never displays ghost work for the lease-recovery grace period.
  repository.interruptOwnedWork(OWNER_ID, 'Workbench runtime promoted while this agent was running. Retry or continue the conversation.');
  shutdownActiveAgentProcesses();
  shutdownDiffConfidenceModel();
  shutdownFastTaskDraftModel();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
