import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactLibrary, artifactFeedbackConfig, createCommentRateLimiter } from './artifact-library.js';
import { openDatabase } from './database.js';

function library() {
  const database = openDatabase(':memory:');
  return { database, artifacts: new ArtifactLibrary(database) };
}

function publish(artifacts: ArtifactLibrary, input: { id: string; hash: string; version: number; sourcePath?: string; title?: string }, kind: 'published' | 'republished' | 'restored') {
  return artifacts.recordPublication({
    id: input.id,
    sourcePath: input.sourcePath ?? '/dev/workbench/notes/report.md',
    title: input.title ?? 'Report',
    url: `https://artifacts.example.com/${input.id}/`,
    contentHash: input.hash,
    version: input.version,
  }, kind);
}

describe('artifact library', () => {
  it('records a first publication as version 1 with a publication event', () => {
    const { artifacts } = library();
    const plan = artifacts.planPublication('/dev/workbench/notes/report.md', 'hash-a', 'artifact-1');

    expect(plan).toMatchObject({ id: 'artifact-1', version: 1, kind: 'published', needsDeploy: true });
    const summary = publish(artifacts, { id: plan.id, hash: 'hash-a', version: plan.version }, plan.kind as 'published');

    expect(summary.version).toBe(1);
    expect(summary.versionCount).toBe(1);
    expect(artifacts.listEvents(summary.id).map((event) => event.kind)).toEqual(['published']);
  });

  it('appends a version when the source content changes and keeps the earlier one', () => {
    const { artifacts } = library();
    publish(artifacts, { id: 'artifact-1', hash: 'hash-a', version: 1 }, 'published');

    const plan = artifacts.planPublication('/dev/workbench/notes/report.md', 'hash-b', 'unused');
    expect(plan).toMatchObject({ id: 'artifact-1', version: 2, kind: 'republished', needsDeploy: true });

    const summary = publish(artifacts, { id: plan.id, hash: 'hash-b', version: plan.version }, 'republished');
    expect(summary.version).toBe(2);
    expect(summary.versionCount).toBe(2);
    expect(artifacts.listVersions(summary.id).map((version) => version.version)).toEqual([2, 1]);
    expect(artifacts.listEvents(summary.id).map((event) => event.kind)).toContain('republished');
    // The public identity is stable across versions: an already-shared link still resolves.
    expect(summary.url).toBe('https://artifacts.example.com/artifact-1/');
  });

  it('skips the deploy entirely when the file has not changed', () => {
    const { artifacts } = library();
    publish(artifacts, { id: 'artifact-1', hash: 'hash-a', version: 1 }, 'published');

    expect(artifacts.planPublication('/dev/workbench/notes/report.md', 'hash-a', 'unused')).toMatchObject({ kind: 'unchanged', needsDeploy: false, version: 1 });
  });

  it('keeps history through revocation and treats an unchanged republish as a restore', () => {
    const { artifacts } = library();
    publish(artifacts, { id: 'artifact-1', hash: 'hash-a', version: 1 }, 'published');
    const revoked = artifacts.markRevoked('artifact-1');

    expect(revoked?.revokedAt).toBeTruthy();
    expect(artifacts.list('published')).toHaveLength(0);
    expect(artifacts.list('revoked')).toHaveLength(1);
    expect(artifacts.listVersions('artifact-1')).toHaveLength(1);

    const plan = artifacts.planPublication('/dev/workbench/notes/report.md', 'hash-a', 'unused');
    expect(plan).toMatchObject({ kind: 'restored', needsDeploy: true, version: 1 });

    const restored = publish(artifacts, { id: plan.id, hash: 'hash-a', version: plan.version }, 'restored');
    expect(restored.revokedAt).toBeNull();
    expect(restored.versionCount).toBe(1);
    expect(artifacts.listEvents('artifact-1').map((event) => event.kind)).toEqual(['restored', 'revoked', 'published']);
  });

  it('links an artifact to a task and a conversation after publication', () => {
    const { database, artifacts } = library();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO work_items (id, title, queue_position, created_at, updated_at) VALUES ('task-1', 'Ship the library', 1, ?, ?)").run(now, now);
    database.prepare("INSERT INTO shared_conversations (id, title, created_at, updated_at) VALUES ('conversation-1', 'Artifact review', ?, ?)").run(now, now);
    publish(artifacts, { id: 'artifact-1', hash: 'hash-a', version: 1 }, 'published');

    const linked = artifacts.link('artifact-1', { workItemId: 'task-1', conversationId: 'conversation-1' });

    expect(linked).toMatchObject({ workItemTitle: 'Ship the library', conversationTitle: 'Artifact review' });
    expect(artifacts.listForWorkItem('task-1').map((artifact) => artifact.id)).toEqual(['artifact-1']);
  });

  it('favorites and unfavorites an artifact, surfacing it in the favorites view and counts', () => {
    const { artifacts } = library();
    publish(artifacts, { id: 'artifact-1', hash: 'hash-a', version: 1, sourcePath: '/dev/workbench/notes/a.md' }, 'published');
    publish(artifacts, { id: 'artifact-2', hash: 'hash-b', version: 1, sourcePath: '/dev/workbench/notes/b.md' }, 'published');

    expect(artifacts.get('artifact-1')?.favoritedAt).toBeNull();
    expect(artifacts.list('favorites')).toHaveLength(0);
    expect(artifacts.counts().favorited).toBe(0);

    const favorited = artifacts.setFavorited('artifact-1', true);
    expect(favorited?.favoritedAt).not.toBeNull();
    expect(artifacts.list('favorites').map((artifact) => artifact.id)).toEqual(['artifact-1']);
    expect(artifacts.counts().favorited).toBe(1);

    const unfavorited = artifacts.setFavorited('artifact-1', false);
    expect(unfavorited?.favoritedAt).toBeNull();
    expect(artifacts.list('favorites')).toHaveLength(0);
  });

  it('returns null when favoriting an artifact that does not exist', () => {
    const { artifacts } = library();
    expect(artifacts.setFavorited('missing', true)).toBeNull();
  });

  it('collects coworker feedback and tracks what is still unresolved', () => {
    const { artifacts } = library();
    publish(artifacts, { id: 'artifact-1', hash: 'hash-a', version: 1 }, 'published');

    const comment = artifacts.addComment('artifact-1', { author: 'Ashley', body: 'The rollout section needs dates.' });
    expect(comment).toMatchObject({ author: 'Ashley', version: 1, resolvedAt: null });
    expect(artifacts.get('artifact-1')).toMatchObject({ commentCount: 1, openCommentCount: 1 });
    expect(artifacts.counts().openComments).toBe(1);

    artifacts.resolveComment('artifact-1', comment!.id, true);
    expect(artifacts.get('artifact-1')).toMatchObject({ commentCount: 1, openCommentCount: 0 });
    expect(artifacts.listEvents('artifact-1').map((event) => event.kind)).toContain('commented');
  });

  it('refuses feedback for an artifact that does not exist', () => {
    const { artifacts } = library();
    expect(artifacts.addComment('missing', { author: 'Ashley', body: 'Hello?' })).toBeNull();
  });

  it('gives artifacts published before the library existed a version 1 history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-library-'));
    const path = join(directory, 'legacy.db');
    const first = openDatabase(path);
    first.exec(`
      INSERT INTO published_artifacts (id, source_path, title, public_url, content_hash, published_at)
      VALUES ('legacy-1', '/dev/workbench/notes/legacy.md', 'Legacy report', 'https://artifacts.example.com/legacy-1/', 'hash-legacy', '2026-08-01T00:00:00.000Z');
      DELETE FROM artifact_versions WHERE artifact_id = 'legacy-1';
      DELETE FROM artifact_events WHERE artifact_id = 'legacy-1';
      -- This represents a database created before the migration ledger. A
      -- versioned current database is intentionally not repaired at startup.
      DELETE FROM schema_migrations;
    `);
    first.close();

    const second = openDatabase(path);
    const artifacts = new ArtifactLibrary(second);
    expect(artifacts.listVersions('legacy-1')).toMatchObject([{ version: 1, contentHash: 'hash-legacy' }]);
    expect(artifacts.listEvents('legacy-1').map((event) => event.kind)).toEqual(['published']);
    // The backfilled hash still matches, so opening an old share does not force a redeploy.
    expect(artifacts.planPublication('/dev/workbench/notes/legacy.md', 'hash-legacy', 'unused')).toMatchObject({ kind: 'unchanged' });
    second.close();
  });

  it('serializes publish and revoke with a durable operation claim, including crash states', () => {
    const { artifacts } = library();
    const publish = artifacts.beginDeploymentOperation('publish', '{"id":"first"}');
    expect(() => artifacts.beginDeploymentOperation('revoke', '{"id":"second"}')).toThrow(/already in progress/i);
    // This is the state a crash leaves before the remote deployment starts.
    expect(artifacts.pendingDeploymentOperations()).toMatchObject([{ id: publish.id, state: 'staged' }]);
    // This is the state a crash leaves after the remote deployment succeeds;
    // createApp finalizes this journal entry on the next live startup.
    artifacts.updateDeploymentOperation(publish.id, 'deployed');
    expect(artifacts.pendingDeploymentOperations()).toMatchObject([{ id: publish.id, state: 'deployed' }]);
    artifacts.updateDeploymentOperation(publish.id, 'completed');
    expect(artifacts.pendingDeploymentOperations()).toEqual([]);
  });

  it('records a recovered rendered snapshot only for an existing version', () => {
    const { artifacts } = library();
    publish(artifacts, { id: 'report', hash: 'hash-report', version: 1 }, 'published');

    expect(artifacts.recordRenderedSnapshot('report', 1, '<h1>Immutable report</h1>')).toBe(true);
    expect(artifacts.recordRenderedSnapshot('report', 1, '<h1>Replacement</h1>')).toBe(false);
    expect(artifacts.recordRenderedSnapshot('missing', 1, '<h1>Missing</h1>')).toBe(false);
    expect(artifacts.listLive()).toMatchObject([{
      id: 'report', snapshots: [{ version: 1, content: '<h1>Immutable report</h1>' }],
    }]);
  });

  it('includes revoked artifacts when identifying snapshots for recovery', () => {
    const { artifacts } = library();
    publish(artifacts, { id: 'revoked-report', hash: 'hash-report', version: 1 }, 'published');
    artifacts.markRevoked('revoked-report');

    expect(artifacts.listLive()).toEqual([]);
    expect(artifacts.listSnapshotCandidates()).toMatchObject([{
      id: 'revoked-report', snapshots: [{ version: 1, content: null }],
    }]);
  });
});

describe('artifact feedback configuration', () => {
  it('stays disabled unless both the public Workbench origin and artifact host are configured', () => {
    expect(artifactFeedbackConfig({})).toBeNull();
    expect(artifactFeedbackConfig({ WORKBENCH_PUBLIC_URL: 'https://jeffrey.ngrok-free.app' })).toBeNull();
    expect(artifactFeedbackConfig({ ARTIFACT_PUBLIC_BASE_URL: 'https://artifacts.example.com' })).toBeNull();
    expect(artifactFeedbackConfig({ WORKBENCH_PUBLIC_URL: 'not a url', ARTIFACT_PUBLIC_BASE_URL: 'https://artifacts.example.com' })).toBeNull();
  });

  it('uses the configured application origin for public-page feedback', () => {
    expect(artifactFeedbackConfig({ APP_API_ORIGIN: 'https://workbench.example.com/', ARTIFACT_PUBLIC_BASE_URL: 'https://artifacts.example.com/' }))
      .toEqual({ endpointOrigin: 'https://workbench.example.com', pageOrigin: 'https://artifacts.example.com' });
  });

  it('lets an explicit feedback origin override the application origin', () => {
    expect(artifactFeedbackConfig({ WORKBENCH_PUBLIC_URL: 'https://jeffrey.ngrok-free.app/', ARTIFACT_PUBLIC_BASE_URL: 'https://artifacts.example.com/' }))
      .toEqual({ endpointOrigin: 'https://jeffrey.ngrok-free.app', pageOrigin: 'https://artifacts.example.com' });
  });
});

describe('feedback rate limiting', () => {
  it('caps submissions per artifact and lets the window expire', () => {
    let clock = 0;
    const allow = createCommentRateLimiter(2, 1_000, () => clock);

    expect(allow('artifact-1')).toBe(true);
    expect(allow('artifact-1')).toBe(true);
    expect(allow('artifact-1')).toBe(false);
    expect(allow('artifact-2')).toBe(true);

    clock = 1_500;
    expect(allow('artifact-1')).toBe(true);
  });
});
