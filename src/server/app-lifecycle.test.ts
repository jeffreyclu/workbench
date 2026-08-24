import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import type { RuntimeCapabilities } from './runtime-capabilities.js';
import { startAppLifecycle } from './services/app-lifecycle.js';
import type { ArtifactService } from './services/artifact-service.js';

const capabilities = (overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities => ({
  mode: 'preview',
  allowMutations: false,
  runDiscoveryCatchUp: false,
  ownScheduler: false,
  promoteRuntime: false,
  executeAgents: false,
  ...overrides,
});

describe('app startup lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('runs repository backfill but skips mutating recovery in a read-only runtime', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const backfill = vi.spyOn(repository, 'backfillConversationRunAdoptions');
    const artifactService = {
      repairSnapshotsOnStartup: vi.fn(),
      recoverPendingDeployments: vi.fn(),
    } as unknown as ArtifactService;

    const result = startAppLifecycle({ database, repository, capabilities: capabilities(), artifactService });

    expect(backfill).toHaveBeenCalledOnce();
    expect(artifactService.repairSnapshotsOnStartup).not.toHaveBeenCalled();
    expect(artifactService.recoverPendingDeployments).not.toHaveBeenCalled();
    expect(result.discoveryCatchUpScheduled).toBe(false);
    database.close();
  });

  it('starts artifact repair/recovery and schedules discovery catch-up only when enabled', () => {
    vi.useFakeTimers();
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const artifactService = {
      repairSnapshotsOnStartup: vi.fn(() => ({ restored: [], missing: [] })),
      recoverPendingDeployments: vi.fn(async () => undefined),
    } as unknown as ArtifactService;

    const result = startAppLifecycle({
      database,
      repository,
      capabilities: capabilities({ allowMutations: true, runDiscoveryCatchUp: true }),
      artifactService,
    });

    expect(artifactService.repairSnapshotsOnStartup).toHaveBeenCalledOnce();
    expect(artifactService.recoverPendingDeployments).toHaveBeenCalledOnce();
    expect(result.discoveryCatchUpScheduled).toBe(true);
    database.close();
    expect(() => vi.advanceTimersByTime(1_500)).not.toThrow();
  });
});
