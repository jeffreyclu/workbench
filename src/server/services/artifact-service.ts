import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ActionFailure } from '../action-result.js';
import { artifactContentHash, CloudflarePagesPublisher, createArtifactId, renderArtifactPage, repairLegacyArtifactSnapshots } from '../artifact-publisher.js';
import { ArtifactLibrary, artifactFeedbackConfig } from '../artifact-library.js';
import { isArtifactAllowed } from '../artifact-access.js';
import { resolveWorkingDirectory } from '../agent-runner.js';
import type { WorkItemRepository } from '../repository.js';

export interface ArtifactFileInput {
  path: string;
  title?: string;
  conversationId?: string;
  workItemId?: string;
}

export class ArtifactService {
  private operation = Promise.resolve();

  constructor(
    private readonly repository: WorkItemRepository,
    readonly library: ArtifactLibrary,
    private readonly publisher = new CloudflarePagesPublisher(),
  ) {}

  serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operation.then(work, work);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  resolveFile(input: ArtifactFileInput): { path: string } | { status: number; error: string } {
    const conversation = input.conversationId ? this.repository.listConversations('all').find((entry) => entry.id === input.conversationId) : null;
    const item = this.repository.get(input.workItemId ?? conversation?.workItemId ?? '');
    const workspace = realpathSync(item ? resolveWorkingDirectory(item) : process.cwd());
    const requestedPath = input.path.replace(/^file:\/\//, '').replace(/:(\d+)(?::\d+)?$/, '');
    const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspace, requestedPath);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return { status: 404, error: 'Artifact file not found.' };
    const realCandidate = realpathSync(candidate);
    if (!isArtifactAllowed(realCandidate, workspace)) return { status: 403, error: 'Artifact is outside the allowed development roots.' };
    return { path: realCandidate };
  }

  async publish(input: { sourcePath: string; title: string; workItemId?: string | null; conversationId?: string | null }) {
    return this.serialize(async () => {
      const contentHash = artifactContentHash(input.sourcePath, input.title);
      const plan = this.library.planPublication(input.sourcePath, contentHash, createArtifactId());
      if (!plan.needsDeploy && plan.existing) {
        return { artifact: { id: plan.existing.id, title: plan.existing.title, url: plan.existing.url }, changed: false, published: false, kind: plan.kind };
      }
      const feedback = artifactFeedbackConfig();
      const publishedAt = new Date().toISOString();
      const renderedContent = renderArtifactPage(input.sourcePath, input.title, {
        version: plan.version, publishedAt, feedback: feedback ? { artifactId: plan.id, endpointOrigin: feedback.endpointOrigin } : null,
      });
      const operation = this.library.beginDeploymentOperation('publish', JSON.stringify({ plan, input, contentHash, renderedContent, publishedAt }));
      try {
        const published = await this.publisher.publish({
          id: plan.id, title: input.title, sourcePath: input.sourcePath, version: plan.version, renderedContent, publishedAt,
          feedback: feedback ? { artifactId: plan.id, endpointOrigin: feedback.endpointOrigin } : null,
        }, this.library.listLive());
        this.library.updateDeploymentOperation(operation.id, 'deployed');
        const summary = this.library.recordPublication({
          id: plan.id, sourcePath: input.sourcePath, title: input.title, url: published.url, contentHash, renderedContent,
          version: plan.version, workItemId: input.workItemId ?? null, conversationId: input.conversationId ?? null,
        }, plan.kind);
        this.library.supersede(plan.supersededIds);
        this.library.updateDeploymentOperation(operation.id, 'completed');
        return { artifact: { id: summary.id, title: summary.title, url: summary.url }, changed: plan.kind === 'republished', published: true, kind: plan.kind, created: plan.kind === 'published' };
      } catch (error) {
        this.library.updateDeploymentOperation(operation.id, 'failed', error instanceof Error ? error.message : 'Unknown deployment error');
        throw error;
      }
    });
  }

  publishFromInput(input: ArtifactFileInput) {
    const resolved = this.resolveFile(input);
    if ('error' in resolved) return Promise.resolve({ status: resolved.status, body: { error: resolved.error } } as ActionFailure);
    const title = input.title ?? basename(resolved.path).replace(/\.[^.]+$/, '');
    const conversation = input.conversationId ? this.repository.listConversations('all').find((entry) => entry.id === input.conversationId) : null;
    const item = this.repository.get(input.workItemId ?? conversation?.workItemId ?? '');
    return this.publish({ sourcePath: resolved.path, title, workItemId: item?.id ?? null, conversationId: input.conversationId ?? null });
  }

  async revoke(artifactId: string) {
    try {
      return await this.serialize(async () => {
        const artifact = this.library.get(artifactId);
        if (!artifact) return { status: 404, body: { error: 'Published artifact not found.' } } as ActionFailure;
        const operation = this.library.beginDeploymentOperation('revoke', JSON.stringify({ id: artifact.id, url: artifact.url }));
        try {
          const result = await this.publisher.revoke(artifactId, this.library.listLive().filter((live) => live.id !== artifact.id), artifact.url);
          this.library.updateDeploymentOperation(operation.id, 'deployed');
          if (!artifact.revokedAt) this.library.markRevoked(artifactId);
          this.library.updateDeploymentOperation(operation.id, 'completed');
          this.repository.addAuditEntry('destructive_action', 'workbench', `Revoked artifact ${artifactId}${result.verified ? '' : ' (could not verify the public URL stopped serving)'}`, artifact.workItemId ?? null);
          return { artifact: this.library.get(artifactId), verified: result.verified };
        } catch (error) {
          this.library.updateDeploymentOperation(operation.id, 'failed', error instanceof Error ? error.message : 'Unknown deployment error');
          throw error;
        }
      });
    } catch (error) {
      this.repository.addAuditEntry('destructive_action', 'workbench', `Revoke failed for artifact ${artifactId}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return { status: 500, body: { error: error instanceof Error ? error.message : 'Could not revoke artifact.' } } as ActionFailure;
    }
  }

  repairSnapshots() {
    return this.serialize(async () => repairLegacyArtifactSnapshots(
      process.env.ARTIFACT_OUTPUT_DIRECTORY ?? 'data/published',
      this.library.listSnapshotCandidates(),
      (artifactId, version, content) => this.library.recordRenderedSnapshot(artifactId, version, content),
    ));
  }

  async refreshFeedback() {
    return this.serialize(async () => {
      const feedback = artifactFeedbackConfig();
      if (!feedback) throw new Error('Artifact feedback is not configured. Set APP_API_ORIGIN and ARTIFACT_PUBLIC_BASE_URL.');
      return this.publisher.refreshFeedback(this.library.listLive(), { artifactId: '', endpointOrigin: feedback.endpointOrigin });
    });
  }

  repairSnapshotsOnStartup() {
    const repaired = repairLegacyArtifactSnapshots(
      process.env.ARTIFACT_OUTPUT_DIRECTORY ?? 'data/published',
      this.library.listSnapshotCandidates(),
      (artifactId, version, content) => this.library.recordRenderedSnapshot(artifactId, version, content),
    );
    if (repaired.restored.length || repaired.missing.length) {
      console.info(JSON.stringify({ event: 'artifact_snapshot_repair', restored: repaired.restored.length, missing: repaired.missing }));
    }
    return repaired;
  }

  async recoverPendingDeployments() {
    for (const operation of this.library.pendingDeploymentOperations()) {
      try {
        const manifest = JSON.parse(operation.manifest) as Record<string, unknown>;
        if (operation.state === 'staged') {
          if (operation.kind === 'revoke') {
            const id = String(manifest.id);
            await this.publisher.revoke(id, this.library.listLive().filter((live) => live.id !== id), String(manifest.url));
          } else {
            const plan = manifest.plan as { id: string; version: number };
            const input = manifest.input as { sourcePath: string; title: string };
            await this.publisher.publish({
              id: plan.id, title: input.title, sourcePath: input.sourcePath, version: plan.version,
              renderedContent: String(manifest.renderedContent), publishedAt: String(manifest.publishedAt),
            }, this.library.listLive());
          }
          this.library.updateDeploymentOperation(operation.id, 'deployed');
        }
        if (operation.kind === 'revoke') {
          const id = String(manifest.id);
          if (this.library.get(id)?.revokedAt === null) this.library.markRevoked(id);
        } else {
          const plan = manifest.plan as { id: string; version: number; kind: 'published' | 'republished' | 'restored' };
          const input = manifest.input as { sourcePath: string; title: string; workItemId?: string | null; conversationId?: string | null };
          this.library.recordPublication({
            id: plan.id, sourcePath: input.sourcePath, title: input.title,
            url: this.publisher.publicUrl(plan.id), contentHash: String(manifest.contentHash),
            renderedContent: String(manifest.renderedContent), version: plan.version,
            workItemId: input.workItemId ?? null, conversationId: input.conversationId ?? null,
          }, plan.kind);
        }
        this.library.updateDeploymentOperation(operation.id, 'completed');
      } catch (error) {
        this.library.updateDeploymentOperation(operation.id, 'failed', `Recovery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }
}
