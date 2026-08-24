import type { WorkbenchDatabase } from './database.js';
import type { ArtifactLibrary } from './artifact-library.js';
import type { WorkItemRepository } from './repository.js';
import type { RuntimeCapabilities } from './runtime-capabilities.js';
import type { ArtifactService } from './services/artifact-service.js';
import type { WorkbenchAdminService } from './services/workbench-admin-service.js';

/** One dependency bundle is created by createApp and injected into every router. */
export interface RouteContext {
  database: WorkbenchDatabase;
  capabilities: RuntimeCapabilities;
  repository: WorkItemRepository;
  artifacts: ArtifactLibrary;
  artifactService: ArtifactService;
  admin: WorkbenchAdminService;
  buildId: string;
  allowArtifactComment: (artifactId: string) => boolean;
}
