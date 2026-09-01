import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { closeTestServer as closeServer } from '../test-http-harness.js';

/** Creating a review must not require a conversation: a pull request link, or
 * a repository, is the whole precondition. */
describe('standalone reviews', () => {
  let database: WorkbenchDatabase;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    server = createApp(database).listen(0);
    await new Promise<void>((listening) => server.once('listening', () => listening()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    database.close();
  });

  const post = (body: unknown) => fetch(`${baseUrl}/api/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('creates a review from a pull request link alone', async () => {
    const response = await post({ pullRequestUrl: 'https://github.com/acme/widgets/pull/42' });
    expect(response.status).toBe(201);
    const { review } = await response.json() as { review: { id: string; title: string; source: { kind: string; url: string } } };
    expect(review.source).toEqual({ kind: 'pull-request', url: 'https://github.com/acme/widgets/pull/42' });
    expect(review.title).toBe('acme/widgets #42');

    const listed = await (await fetch(`${baseUrl}/api/reviews`)).json() as { reviews: Array<{ id: string }> };
    expect(listed.reviews.map((entry) => entry.id)).toEqual([review.id]);
  });

  it('rejects a review that names both a link and a repository, and one that names neither', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ pullRequestUrl: 'https://github.com/acme/widgets/pull/42', repositoryPath: process.cwd() })).status).toBe(400);
  });

  it('rejects a repository that is not one of this machine’s checkouts', async () => {
    const response = await post({ repositoryPath: '/nowhere/not-a-repo' });
    expect(response.status).toBe(400);
  });

  it('creates a repository review from a listed checkout and keeps the chosen ref', async () => {
    const { repositories } = await (await fetch(`${baseUrl}/api/reviews/repositories`)).json() as { repositories: Array<{ path: string; label: string }> };
    expect(repositories.length).toBeGreaterThan(0);
    const response = await post({ repositoryPath: repositories[0].path, ref: 'branch:main' });
    expect(response.status).toBe(201);
    const { review } = await response.json() as { review: { source: { kind: string; repositoryPath: string; ref: string | null } } };
    expect(review.source).toEqual({ kind: 'repository', repositoryPath: repositories[0].path, ref: 'branch:main' });
  });

  it('keeps a review’s block verdicts against the review itself, with no conversation involved', async () => {
    const { review } = await (await post({ pullRequestUrl: 'https://github.com/acme/widgets/pull/7' })).json() as { review: { id: string } };
    const put = await fetch(`${baseUrl}/api/reviews/${review.id}/workspace-diff/block-reviews`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 'rev-1', filePath: 'src/app.ts', blockRange: '10-20', contentHash: 'hash-1', state: 'reviewed' }),
    });
    expect(put.status).toBe(200);

    const read = await (await fetch(`${baseUrl}/api/reviews/${review.id}/workspace-diff/block-reviews?revision=rev-1`)).json() as { reviews: Array<{ filePath: string; state: string }> };
    expect(read.reviews).toEqual([expect.objectContaining({ filePath: 'src/app.ts', state: 'reviewed' })]);

    // A pull-request review has no checkout, so the working tree is an empty
    // answer rather than a failure.
    const diff = await (await fetch(`${baseUrl}/api/reviews/${review.id}/workspace-diff`)).json() as { diff: { changedFiles: number } };
    expect(diff.diff.changedFiles).toBe(0);
    const snapshots = await (await fetch(`${baseUrl}/api/reviews/${review.id}/workspace-diff/snapshots`)).json() as { snapshots: unknown[] };
    expect(snapshots.snapshots).toEqual([]);
  });

  it('deletes a review and its verdicts', async () => {
    const { review } = await (await post({ pullRequestUrl: 'https://github.com/acme/widgets/pull/9' })).json() as { review: { id: string } };
    expect((await fetch(`${baseUrl}/api/reviews/${review.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/reviews/${review.id}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/reviews/${review.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
