import 'dotenv/config';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { OWNER_ID, startScheduler } from './scheduler.js';
import { startRuntimePromotionWorker } from './runtime-promotion-worker.js';
import { shutdownFastTaskDraftModel } from './fast-task-draft-ai.js';
import { shutdownDiffConfidenceModel, warmDiffConfidenceModel } from './diff-confidence-ai.js';
import { shutdownReviewAssist, warmReviewAssist } from './review-assist-ai.js';
import { liveRuntimeCapabilities } from './runtime-capabilities.js';
import { createServer } from 'node:http';
import { attachRealtimeServer, retireRealtimeClients } from './realtime.js';
import { createApplicationSocketHandler } from './socket-application.js';
import { shutdownActiveAgentProcesses } from './agent-runner.js';
import { reattachAll as reattachAgentSessions } from './agent-session.js';
import { hasLiveSessionTurn, persistentSessionsEnabled, recoverSharedSessionTurns } from './shared-room.js';
import { shutdownTurnGroundingClassifier, warmTurnGroundingClassifier } from './turn-grounding-ai.js';
import { configureRuntimeRetirement } from './runtime-retirement.js';
import { shutdownMemorySemanticWorker } from './memory-semantic-worker.js';
import { requestMemoryIndexRefresh, shutdownMemoryIndexMaintenance } from './memory-index-maintenance.js';
import { readMcpQualityHistory } from './mcp-quality-history.js';
import { startMcpQualityMonitor } from './mcp-quality-monitor.js';
import { ensureWorkbenchDocumentRoot } from './local-documents.js';
import { startKnowledgeDriftMonitor } from './knowledge-drift-monitor.js';
import { startConsolidationMonitor } from './consolidation-monitor.js';
import { startTerminalSessionSync } from './terminal-session-sync.js';

const port = Number(process.env.PORT ?? 4317);
ensureWorkbenchDocumentRoot();
const database = openDatabase();
const app = createApp(database, liveRuntimeCapabilities);

// Recover in-flight work left behind by a previous process (crash, deploy, restart)
// and keep retrying/dispatching queued work going forward. Must start before the
// server accepts traffic so nothing queued while the process was down sits idle.
const repository = new WorkItemRepository(database);
// Session hosts are detached and outlive the previous runtime. Adopt the live
// ones and mark the rest stopped; their provider sessions resume on next use.
// A reply that was streaming when the last runtime stopped finishes into its
// own message once its host is adopted. Recovery claims every live session's
// turn slot synchronously, so it must run before the scheduler can dispatch a
// task run onto a session whose unfinished reply is still being recovered.
if (liveRuntimeCapabilities.ownScheduler) {
  const reattached = reattachAgentSessions(database).catch((error: unknown) => {
    console.error('Agent session reattach failed:', error instanceof Error ? error.message : error);
  });
  recoverSharedSessionTurns(repository, { ready: reattached })
    .catch((error: unknown) => {
      console.error('Agent session reattach failed:', error instanceof Error ? error.message : error);
    });
}
const scheduler = liveRuntimeCapabilities.ownScheduler ? startScheduler(repository) : null;
const promotionWorker = liveRuntimeCapabilities.promoteRuntime ? startRuntimePromotionWorker(repository) : null;
const mcpQualityMonitor = liveRuntimeCapabilities.ownScheduler ? startMcpQualityMonitor(repository, {
  latest: () => readMcpQualityHistory().latest,
}) : null;
const knowledgeDriftMonitor = liveRuntimeCapabilities.ownScheduler ? startKnowledgeDriftMonitor(database) : null;
const consolidationMonitor = liveRuntimeCapabilities.ownScheduler ? startConsolidationMonitor(repository) : null;
// Claude Code and Codex sessions Jeffrey starts in a terminal appear as
// conversations; only the scheduler-owning runtime imports them.
const terminalSessionSync = liveRuntimeCapabilities.ownScheduler ? startTerminalSessionSync(database) : null;
configureRuntimeRetirement(() => {
  scheduler?.stop();
  promotionWorker?.stop();
  mcpQualityMonitor?.stop();
  knowledgeDriftMonitor?.stop();
  consolidationMonitor?.stop();
  terminalSessionSync?.stop();
  retireRealtimeClients();
});
warmDiffConfidenceModel();
warmReviewAssist();
warmTurnGroundingClassifier();

const server = createServer(app);
attachRealtimeServer(server, { handleRequest: createApplicationSocketHandler(app) });
server.listen(port, () => {
  console.log(`Workbench API listening on http://localhost:${port}`);
  console.log(persistentSessionsEnabled()
    ? 'Persistent sessions: ON (Claude and Codex room replies run as turns on one live session per conversation; set WORKBENCH_PERSISTENT_SESSIONS=0 to opt out)'
    : 'Persistent sessions: OFF (WORKBENCH_PERSISTENT_SESSIONS=0; every reply starts its own CLI process)');
  requestMemoryIndexRefresh();
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // A promotion is an intentional interruption, not a crash. Persist the
  // terminal state before killing child process groups so the next runtime
  // never displays ghost work for the lease-recovery grace period.
  scheduler?.stop();
  const interrupted = repository.interruptOwnedWork(OWNER_ID, 'Workbench runtime promoted while this agent was running. Retry or continue the conversation.', {
    hasLiveSessionTurn: (messageId) => hasLiveSessionTurn(repository, messageId),
  });
  for (const runId of interrupted.requeuedRunIds) {
    try {
      const run = repository.getRun(runId);
      if (run) repository.addActivity(run.workItemId, 'system', 'progress', `Interrupted ${run.kind} by a runtime promotion; re-queued to resume on the new runtime.`);
    } catch { /* The interruption itself is durable; the note is best effort while stopping. */ }
  }
  // Only per-run children stop here. Agent session hosts (agent-session.ts)
  // are detached on purpose and must survive this runtime; the next one
  // reattaches to them at boot.
  shutdownActiveAgentProcesses();
  shutdownTurnGroundingClassifier();
  shutdownDiffConfidenceModel();
  shutdownReviewAssist();
  shutdownFastTaskDraftModel();
  shutdownMemorySemanticWorker();
  shutdownMemoryIndexMaintenance();
  mcpQualityMonitor?.stop();
  knowledgeDriftMonitor?.stop();
  consolidationMonitor?.stop();
  terminalSessionSync?.stop();
  // Do not exit immediately after the graceful signal: provider CLIs create
  // detached process groups, so the owning runtime must remain alive long
  // enough to escalate any group that ignores SIGTERM. This is also used when
  // the HTTP server closes promptly (the normal promotion case).
  const forceExit = setTimeout(() => {
    shutdownActiveAgentProcesses('SIGKILL');
    process.exit(0);
  }, 3_500);
  forceExit.unref();
  server.close(() => {
    // The force-exit timer owns final termination. Closing the listener only
    // stops new traffic; it must not discard responsibility for agent children.
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
// A crash can bypass the signal path entirely. Synchronous process-group
// termination here prevents a detached provider child from surviving without
// a Workbench runtime to supervise it.
process.once('exit', () => shutdownActiveAgentProcesses('SIGKILL'));
