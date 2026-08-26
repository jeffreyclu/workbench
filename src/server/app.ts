import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { ArtifactLibrary, createCommentRateLimiter } from './artifact-library.js';
import { createAuthGate } from './auth.js';
import { OutboundPolicyError } from './outbound-policy.js';
import { liveRuntimeCapabilities, type RuntimeCapabilities } from './runtime-capabilities.js';
import { createRequestAuditMiddleware } from './request-audit.js';
import { createWorkItemActivityMiddleware } from './work-item-activity.js';
import { rejectPreviewMutation } from './app-exports.js';
import { ArtifactService } from './services/artifact-service.js';
import { WorkbenchAdminService } from './services/workbench-admin-service.js';
import { startAppLifecycle } from './services/app-lifecycle.js';
import type { RouteContext } from './route-context.js';
import { createHealthRouter, createSystemRouter } from './routes/system-router.js';
import { createDiscoveryRouter } from './routes/discovery-router.js';
import { createArtifactRouter } from './routes/artifact-router.js';
import { createConversationRouter } from './routes/conversation-router.js';
import { createWorkItemRouter } from './routes/work-item-router.js';
import { createQueueRouter } from './routes/queue-router.js';
import { createSourceConnectionRouter } from './routes/source-connection-router.js';
import { createExecutionRouter } from './routes/execution-router.js';
import { createLinearRouter } from './routes/linear-router.js';
import { createMcpRouter } from './routes/mcp-router.js';
import { createAgentAccountRouter } from './routes/agent-account-router.js';

export { oauthCallbackBase, parseFollowUpPlan, rejectPreviewMutation } from './app-exports.js';

/** Compose one Workbench HTTP application around one shared repository/context. */
export function createApp(database: WorkbenchDatabase, capabilities: RuntimeCapabilities = liveRuntimeCapabilities) {
  const app = express();
  const repository = new WorkItemRepository(database);
  const artifacts = new ArtifactLibrary(database);
  const artifactService = new ArtifactService(repository, artifacts);
  const admin = new WorkbenchAdminService(repository, capabilities, artifactService);
  const context: RouteContext = {
    database,
    capabilities,
    repository,
    artifacts,
    artifactService,
    admin,
    buildId: randomUUID(),
    allowArtifactComment: createCommentRateLimiter(),
  };

  startAppLifecycle(context);

  app.use(createAuthGate(undefined));
  app.use(express.json({ limit: '150mb' }));
  app.use(createRequestAuditMiddleware(repository));
  app.use(createWorkItemActivityMiddleware(repository));
  app.use(createHealthRouter(context));
  app.use((request, response, next) => {
    const rejection = rejectPreviewMutation(request.method, capabilities);
    if (!rejection) return next();
    response.status(403).json(rejection);
  });

  app.use(createSystemRouter(context));
  app.use(createDiscoveryRouter(context));
  app.use(createArtifactRouter(context));
  app.use(createConversationRouter(context));
  app.use(createWorkItemRouter(context));
  app.use(createQueueRouter(context));
  app.use(createSourceConnectionRouter(context));
  app.use(createMcpRouter(context));
  app.use(createAgentAccountRouter());
  app.use(createExecutionRouter(context));
  app.use(createLinearRouter(context));

  const clientPath = resolve(process.env.WORKBENCH_CLIENT_PATH ?? 'dist/client');
  if (existsSync(clientPath)) {
    app.use(express.static(clientPath));
    app.use((request, response, next) => {
      if (request.method !== 'GET' || request.path.startsWith('/api/') || request.path === '/mcp') return next();
      response.sendFile('index.html', { root: clientPath }, (error) => error ? next(error) : undefined);
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    if (error instanceof OutboundPolicyError) {
      response.status(400).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({ error: 'Invalid request.', details: error.issues });
      return;
    }
    if (typeof error === 'object' && error !== null && ('type' in error && error.type === 'entity.too.large' || 'status' in error && error.status === 413)) {
      response.status(413).json({ error: 'Attachments are too large. Each file can be up to 10 MB, with at most 10 files per message.' });
      return;
    }
    console.error(error);
    response.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error.' });
  };
  app.use(errorHandler);
  return app;
}
