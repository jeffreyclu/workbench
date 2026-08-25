import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { ArtifactLibrary } from './artifact-library.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { closeTestServer, listenTestServer } from './test-http-harness.js';

describe('artifact library API', () => {
  let database: WorkbenchDatabase;
  let artifacts: ArtifactLibrary;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    artifacts = new ArtifactLibrary(database);
    ({ server, baseUrl } = await listenTestServer(createApp(database)));
    artifacts.recordPublication({
      id: 'abc123', sourcePath: '/tmp/workbench-missing-source.md', title: 'Connector rollout',
      url: 'https://artifacts.example.com/abc123/', contentHash: 'hash-a', version: 1,
    }, 'published');
  });

  afterEach(async () => {
    await closeTestServer(server);
    database.close();
  });

  it('lists live artifacts with their counts', async () => {
    const response = await fetch(`${baseUrl}/api/artifacts?view=published`);
    const body = await response.json() as { artifacts: Array<{ id: string; version: number }>; counts: { published: number } };

    expect(response.status).toBe(200);
    expect(body.artifacts).toMatchObject([{ id: 'abc123', version: 1 }]);
    expect(body.counts.published).toBe(1);
  });

  it('returns versions, history, and feedback for one artifact', async () => {
    artifacts.addComment('abc123', { author: 'Ashley', body: 'Needs dates.' });

    const body = await (await fetch(`${baseUrl}/api/artifacts/abc123`)).json() as {
      versions: unknown[]; events: Array<{ kind: string }>; comments: Array<{ author: string }>; sourceAvailable: boolean;
    };

    expect(body.versions).toHaveLength(1);
    expect(body.events.map((event) => event.kind)).toContain('published');
    expect(body.comments).toMatchObject([{ author: 'Ashley' }]);
    expect(body.sourceAvailable).toBe(false);
  });

  it('says plainly why a republish cannot run when the source file is gone', async () => {
    const response = await fetch(`${baseUrl}/api/artifacts/abc123/republish`, { method: 'POST' });

    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toMatch(/source file is gone/i);
  });

  it('links an artifact to a task after it was published', async () => {
    const now = new Date().toISOString();
    const taskId = '00000000-0000-4000-8000-000000000009';
    database.prepare('INSERT INTO work_items (id, title, queue_position, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(taskId, 'Ship connectors V2', now, now);

    const response = await fetch(`${baseUrl}/api/artifacts/abc123`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workItemId: taskId }),
    });

    expect(response.status).toBe(200);
    expect((await response.json() as { artifact: { workItemTitle: string } }).artifact.workItemTitle).toBe('Ship connectors V2');
  });

  it('accepts coworker feedback and lets it be resolved', async () => {
    const posted = await fetch(`${baseUrl}/api/artifacts/abc123/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'Ashley', body: 'Needs dates.', anchor: 'text:14:27' }),
    });
    expect(posted.status).toBe(201);
    const { comment } = await posted.json() as { comment: { id: string; anchor: string } };
    expect(comment.anchor).toBe('text:14:27');

    const listed = await fetch(`${baseUrl}/api/artifacts/abc123/comments`);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { comments: Array<{ anchor: string }> }).comments).toEqual([expect.objectContaining({ anchor: 'text:14:27' })]);

    const resolved = await fetch(`${baseUrl}/api/artifacts/abc123/comments/${comment.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolved: true }),
    });
    expect(resolved.status).toBe(200);
    expect(artifacts.get('abc123')).toMatchObject({ commentCount: 1, openCommentCount: 0 });
  });

  it('refuses feedback on a revoked share instead of collecting it silently', async () => {
    artifacts.markRevoked('abc123');

    const response = await fetch(`${baseUrl}/api/artifacts/abc123/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'Ashley', body: 'Still here?' }),
    });

    expect(response.status).toBe(404);
    expect(artifacts.listComments('abc123')).toHaveLength(0);
  });

  it('rejects empty feedback', async () => {
    const response = await fetch(`${baseUrl}/api/artifacts/abc123/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'Ashley', body: '   ' }),
    });

    expect(response.status).toBe(400);
  });

  it('repairs legacy snapshots on demand without deploying artifacts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-repair-'));
    const previousOutputDirectory = process.env.ARTIFACT_OUTPUT_DIRECTORY;
    process.env.ARTIFACT_OUTPUT_DIRECTORY = directory;
    try {
      const artifactDirectory = join(directory, 'abc123');
      // The legacy deployment directory is the immutable evidence to import.
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(join(artifactDirectory, 'index.html'), '<!doctype html><p>legacy page</p>');

      const response = await fetch(`${baseUrl}/api/artifacts/repair-snapshots`, { method: 'POST' });
      const body = await response.json() as { restored: Array<{ id: string; version: number }>; missing: unknown[] };

      expect(response.status).toBe(200);
      expect(body).toEqual({ restored: [{ id: 'abc123', version: 1 }], missing: [] });
      expect(artifacts.listSnapshotCandidates(false)[0]?.snapshots[0]?.content).toBe('<!doctype html><p>legacy page</p>');
    } finally {
      if (previousOutputDirectory === undefined) delete process.env.ARTIFACT_OUTPUT_DIRECTORY;
      else process.env.ARTIFACT_OUTPUT_DIRECTORY = previousOutputDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
