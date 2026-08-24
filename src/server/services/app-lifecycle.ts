import type { WorkbenchDatabase } from '../database.js';
import { runDiscovery, shouldRunDiscoveryCatchUp } from '../discovery.js';
import type { WorkItemRepository } from '../repository.js';
import type { RuntimeCapabilities } from '../runtime-capabilities.js';
import { setAuditSink } from '../audit-log.js';
import type { ArtifactService } from './artifact-service.js';

export interface AppLifecycleContext {
  database: WorkbenchDatabase;
  repository: WorkItemRepository;
  capabilities: RuntimeCapabilities;
  artifactService: ArtifactService;
}

/** Starts process-local recovery and catch-up work before routes are composed. */
export function startAppLifecycle({ database, repository, capabilities, artifactService }: AppLifecycleContext) {
  repository.backfillConversationRunAdoptions();

  if (capabilities.allowMutations) {
    artifactService.repairSnapshotsOnStartup();
    void artifactService.recoverPendingDeployments();
  }

  setAuditSink((category, source, detail, workItemId) => repository.addAuditEntry(category, source, detail, workItemId ?? null));

  if (!capabilities.runDiscoveryCatchUp) return { discoveryCatchUpScheduled: false };
  const timer = setTimeout(() => {
    if (!database.isOpen) return;
    const lastRun = repository.getDiscoveryInbox().lastRun?.completedAt ?? null;
    if (shouldRunDiscoveryCatchUp(lastRun)) void runDiscovery(repository).catch((error) => console.error('Discovery catch-up failed:', error));
  }, 1_500);
  timer.unref();
  return { discoveryCatchUpScheduled: true };
}
