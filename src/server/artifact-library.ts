import { randomUUID } from 'node:crypto';
import type { ArtifactComment, ArtifactDetail, ArtifactEvent, ArtifactEventKind, ArtifactSummary, ArtifactVersion } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';
import type { LiveArtifact } from './artifact-publisher.js';

type Row = Record<string, string | number | null>;

/**
 * A published artifact is a stable identity: one id, one public URL, one row in
 * `published_artifacts`. Everything that changes over time lives beside it —
 * `artifact_versions` (one row per publish that changed the content),
 * `artifact_events` (the publication timeline), and `artifact_comments`
 * (coworker feedback). Revocation is a flag on the identity, never a delete, so
 * history survives revoke and restore.
 */

const summaryColumns = `
  published_artifacts.id AS id,
  published_artifacts.title AS title,
  published_artifacts.public_url AS url,
  published_artifacts.source_path AS source_path,
  published_artifacts.current_version AS version,
  published_artifacts.work_item_id AS work_item_id,
  published_artifacts.conversation_id AS conversation_id,
  published_artifacts.published_at AS published_at,
  published_artifacts.revoked_at AS revoked_at,
  work_items.title AS work_item_title,
  shared_conversations.title AS conversation_title,
  (SELECT COUNT(*) FROM artifact_versions WHERE artifact_versions.artifact_id = published_artifacts.id) AS version_count,
  (SELECT COUNT(*) FROM artifact_comments WHERE artifact_comments.artifact_id = published_artifacts.id) AS comment_count,
  (SELECT COUNT(*) FROM artifact_comments WHERE artifact_comments.artifact_id = published_artifacts.id AND artifact_comments.resolved_at IS NULL) AS open_comment_count
`;

const summaryFrom = `
  FROM published_artifacts
  LEFT JOIN work_items ON work_items.id = published_artifacts.work_item_id
  LEFT JOIN shared_conversations ON shared_conversations.id = published_artifacts.conversation_id
`;

function text(value: string | number | null): string {
  return value === null ? '' : String(value);
}

function optional(value: string | number | null): string | null {
  return value === null || value === '' ? null : String(value);
}

function mapSummary(row: Row): ArtifactSummary {
  return {
    id: String(row.id),
    title: text(row.title),
    url: text(row.url),
    sourcePath: text(row.source_path),
    version: Number(row.version ?? 1),
    versionCount: Number(row.version_count ?? 0),
    workItemId: optional(row.work_item_id),
    workItemTitle: optional(row.work_item_title),
    conversationId: optional(row.conversation_id),
    conversationTitle: optional(row.conversation_title),
    publishedAt: text(row.published_at),
    revokedAt: optional(row.revoked_at),
    commentCount: Number(row.comment_count ?? 0),
    openCommentCount: Number(row.open_comment_count ?? 0),
  };
}

function mapVersion(row: Row): ArtifactVersion {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    version: Number(row.version),
    title: text(row.title),
    url: text(row.url),
    contentHash: text(row.content_hash),
    note: text(row.note),
    publishedAt: text(row.published_at),
  };
}

function mapEvent(row: Row): ArtifactEvent {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    kind: text(row.kind) as ArtifactEventKind,
    version: row.version === null ? null : Number(row.version),
    detail: text(row.detail),
    createdAt: text(row.created_at),
  };
}

function mapComment(row: Row): ArtifactComment {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    version: row.version === null ? null : Number(row.version),
    author: text(row.author),
    body: text(row.body),
    anchor: optional(row.anchor),
    resolvedAt: optional(row.resolved_at),
    createdAt: text(row.created_at),
  };
}

export interface PublicationInput {
  id: string;
  sourcePath: string;
  title: string;
  url: string;
  contentHash: string;
  version: number;
  note?: string;
  workItemId?: string | null;
  conversationId?: string | null;
  /** Immutable, fully rendered HTML used to reconstruct this exact version. */
  renderedContent?: string;
}

export interface ArtifactDeploymentOperation {
  id: string;
  kind: 'publish' | 'revoke';
  state: 'staged' | 'deployed' | 'completed' | 'failed';
  manifest: string;
  error: string;
}

/** What a publish attempt should do, decided before anything is deployed. */
export interface PublicationPlan {
  id: string;
  version: number;
  /** `false` when the live snapshot already matches the source file. */
  needsDeploy: boolean;
  kind: 'published' | 'republished' | 'restored' | 'unchanged';
  existing: ArtifactSummary | null;
  supersededIds: string[];
}

export class ArtifactLibrary {
  constructor(private readonly database: WorkbenchDatabase) {}

  list(view: 'published' | 'revoked' | 'all' = 'published'): ArtifactSummary[] {
    const where = view === 'all' ? '' : view === 'revoked' ? 'WHERE published_artifacts.revoked_at IS NOT NULL' : 'WHERE published_artifacts.revoked_at IS NULL';
    const rows = this.database.prepare(`SELECT ${summaryColumns} ${summaryFrom} ${where} ORDER BY published_artifacts.published_at DESC`).all() as Row[];
    return rows.map(mapSummary);
  }

  counts(): { published: number; revoked: number; openComments: number } {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM published_artifacts WHERE revoked_at IS NULL) AS published,
        (SELECT COUNT(*) FROM published_artifacts WHERE revoked_at IS NOT NULL) AS revoked,
        (SELECT COUNT(*) FROM artifact_comments
          JOIN published_artifacts ON published_artifacts.id = artifact_comments.artifact_id
          WHERE artifact_comments.resolved_at IS NULL) AS open_comments
    `).get() as Row;
    return { published: Number(row.published ?? 0), revoked: Number(row.revoked ?? 0), openComments: Number(row.open_comments ?? 0) };
  }

  get(id: string): ArtifactSummary | null {
    const row = this.database.prepare(`SELECT ${summaryColumns} ${summaryFrom} WHERE published_artifacts.id = ?`).get(id) as Row | undefined;
    return row ? mapSummary(row) : null;
  }

  detail(id: string, source: { available: boolean; changed: boolean }): ArtifactDetail | null {
    const artifact = this.get(id);
    if (!artifact) return null;
    return {
      artifact,
      versions: this.listVersions(id),
      events: this.listEvents(id),
      comments: this.listComments(id),
      sourceAvailable: source.available,
      sourceChanged: source.changed,
    };
  }

  listVersions(id: string): ArtifactVersion[] {
    const rows = this.database.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC').all(id) as Row[];
    return rows.map(mapVersion);
  }

  listEvents(id: string): ArtifactEvent[] {
    const rows = this.database.prepare('SELECT * FROM artifact_events WHERE artifact_id = ? ORDER BY created_at DESC, rowid DESC').all(id) as Row[];
    return rows.map(mapEvent);
  }

  listComments(id: string): ArtifactComment[] {
    const rows = this.database.prepare('SELECT * FROM artifact_comments WHERE artifact_id = ? ORDER BY created_at ASC').all(id) as Row[];
    return rows.map(mapComment);
  }

  /**
   * The DB's source of truth for what should currently be live, used to
   * reconcile the local `data/published` directory before every deploy so a
   * missing or wiped directory can't silently take other shares offline.
   */
  listLive(): LiveArtifact[] {
    return this.listSnapshotCandidates(false);
  }

  /**
   * Returns artifacts whose historical snapshots may need recovery. Revoked
   * artifacts are included because restoring one later must not make a
   * whole-directory deploy drop its older version URLs.
   */
  listSnapshotCandidates(includeRevoked = true): LiveArtifact[] {
    const rows = this.database.prepare(`
      SELECT id, source_path, title, current_version AS version
      FROM published_artifacts ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
    `).all() as Row[];
    return rows.map((row) => {
      const id = String(row.id);
      const versions = this.database.prepare(`
        SELECT artifact_versions.version, artifact_versions.content_hash AS contentHash, artifact_rendered_versions.content
        FROM artifact_versions LEFT JOIN artifact_rendered_versions
          ON artifact_rendered_versions.artifact_id = artifact_versions.artifact_id
          AND artifact_rendered_versions.version = artifact_versions.version
        WHERE artifact_versions.artifact_id = ? ORDER BY artifact_versions.version ASC
      `).all(id) as Array<{ version: number; contentHash: string; content: string | null }>;
      return {
        id, sourcePath: text(row.source_path), title: text(row.title), version: Number(row.version ?? 1),
        snapshots: versions.map((entry) => ({ version: Number(entry.version), contentHash: entry.contentHash, content: entry.content })),
      };
    });
  }

  listForWorkItem(workItemId: string): ArtifactSummary[] {
    const rows = this.database.prepare(`SELECT ${summaryColumns} ${summaryFrom} WHERE published_artifacts.work_item_id = ? ORDER BY published_artifacts.published_at DESC`).all(workItemId) as Row[];
    return rows.map(mapSummary);
  }

  latestVersion(id: string): ArtifactVersion | null {
    const row = this.database.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1').get(id) as Row | undefined;
    return row ? mapVersion(row) : null;
  }

  /**
   * Decide what a publish of `sourcePath` means before deploying anything: a
   * first publication, a new version, a restore of a revoked share, or nothing
   * at all. Older duplicate rows for the same path are reported so the caller
   * can retire their snapshots.
   */
  planPublication(sourcePath: string, contentHash: string, newId: string): PublicationPlan {
    const rows = this.database.prepare(`SELECT ${summaryColumns} ${summaryFrom} WHERE published_artifacts.source_path = ? ORDER BY published_artifacts.revoked_at IS NOT NULL, published_artifacts.published_at DESC`).all(sourcePath) as Row[];
    const [canonicalRow, ...duplicates] = rows.map(mapSummary);
    if (!canonicalRow) return { id: newId, version: 1, needsDeploy: true, kind: 'published', existing: null, supersededIds: [] };

    const latest = this.latestVersion(canonicalRow.id);
    const supersededIds = duplicates.map((entry) => entry.id);
    if (latest?.contentHash === contentHash) {
      return canonicalRow.revokedAt
        ? { id: canonicalRow.id, version: canonicalRow.version, needsDeploy: true, kind: 'restored', existing: canonicalRow, supersededIds }
        : { id: canonicalRow.id, version: canonicalRow.version, needsDeploy: false, kind: 'unchanged', existing: canonicalRow, supersededIds };
    }
    return { id: canonicalRow.id, version: canonicalRow.version + 1, needsDeploy: true, kind: 'republished', existing: canonicalRow, supersededIds };
  }

  /** Persist a completed deployment: identity, version row, and timeline entry. */
  recordPublication(input: PublicationInput, kind: PublicationPlan['kind']): ArtifactSummary {
    const now = new Date().toISOString();
    const existing = this.get(input.id);
    if (existing) {
      this.database.prepare(`
        UPDATE published_artifacts
        SET title = ?, public_url = ?, content_hash = ?, current_version = ?, published_at = ?, revoked_at = NULL,
          work_item_id = COALESCE(?, work_item_id), conversation_id = COALESCE(?, conversation_id)
        WHERE id = ?
      `).run(input.title, input.url, input.contentHash, input.version, now, input.workItemId ?? null, input.conversationId ?? null, input.id);
    } else {
      this.database.prepare(`
        INSERT INTO published_artifacts (id, source_path, work_item_id, conversation_id, title, public_url, content_hash, current_version, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, input.sourcePath, input.workItemId ?? null, input.conversationId ?? null, input.title, input.url, input.contentHash, input.version, now);
    }

    const versionExists = this.database.prepare('SELECT id FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(input.id, input.version);
    if (!versionExists) {
      this.database.prepare(`
        INSERT INTO artifact_versions (id, artifact_id, version, title, source_path, content_hash, url, note, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), input.id, input.version, input.title, input.sourcePath, input.contentHash, input.url, input.note ?? '', now);
    }
    if (input.renderedContent) {
      this.database.prepare(`
        INSERT INTO artifact_rendered_versions (artifact_id, version, content, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(artifact_id, version) DO NOTHING
      `).run(input.id, input.version, input.renderedContent, now);
    }

    this.addEvent(input.id, kind === 'unchanged' ? 'republished' : kind, input.version, input.note ?? '');
    return this.get(input.id)!;
  }

  /**
   * Imports a legacy rendered page only when its artifact/version already
   * exists. Callers must supply the page that was actually deployed, or one
   * whose stored content hash proves it reconstructs the published version.
   */
  recordRenderedSnapshot(artifactId: string, version: number, content: string): boolean {
    if (!content) return false;
    const now = new Date().toISOString();
    return this.database.prepare(`
      INSERT INTO artifact_rendered_versions (artifact_id, version, content, created_at)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND version = ?
      )
      ON CONFLICT(artifact_id, version) DO NOTHING
    `).run(artifactId, version, content, now, artifactId, version).changes === 1;
  }

  markRevoked(id: string): ArtifactSummary | null {
    const artifact = this.get(id);
    if (!artifact) return null;
    this.database.prepare('UPDATE published_artifacts SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    this.addEvent(id, 'revoked', artifact.version, '');
    return this.get(id);
  }

  /** Retire duplicate rows left by the pre-versioning publisher. */
  supersede(ids: string[]): void {
    if (!ids.length) return;
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE published_artifacts SET revoked_at = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND revoked_at IS NULL`).run(now, ...ids);
  }

  beginDeploymentOperation(kind: ArtifactDeploymentOperation['kind'], manifest: string): ArtifactDeploymentOperation {
    const id = randomUUID();
    const now = new Date().toISOString();
    // One serialized publisher is intentional. SQLite makes this a durable
    // cross-process claim, not merely an in-memory mutex.
    const claimed = this.database.prepare(`
      INSERT INTO artifact_deployment_operations (id, kind, state, manifest_json, created_at, updated_at)
      SELECT ?, ?, 'staged', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM artifact_deployment_operations WHERE state IN ('staged', 'deployed'))
    `).run(id, kind, manifest, now, now).changes;
    if (!claimed) throw new Error('Another artifact publish or revoke is already in progress. Retry when it finishes.');
    return { id, kind, state: 'staged', manifest, error: '' };
  }

  updateDeploymentOperation(id: string, state: ArtifactDeploymentOperation['state'], error = ''): void {
    this.database.prepare('UPDATE artifact_deployment_operations SET state = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(state, error, new Date().toISOString(), id);
  }

  pendingDeploymentOperations(): ArtifactDeploymentOperation[] {
    return (this.database.prepare(`SELECT id, kind, state, manifest_json, error FROM artifact_deployment_operations WHERE state IN ('staged', 'deployed') ORDER BY created_at ASC`).all() as Array<Record<string, string>>)
      .map((row) => ({ id: row.id, kind: row.kind as ArtifactDeploymentOperation['kind'], state: row.state as ArtifactDeploymentOperation['state'], manifest: row.manifest_json, error: row.error }));
  }

  link(id: string, input: { title?: string; workItemId?: string | null; conversationId?: string | null }): ArtifactSummary | null {
    const artifact = this.get(id);
    if (!artifact) return null;
    if (input.title !== undefined) this.database.prepare('UPDATE published_artifacts SET title = ? WHERE id = ?').run(input.title, id);
    if (input.workItemId !== undefined) this.database.prepare('UPDATE published_artifacts SET work_item_id = ? WHERE id = ?').run(input.workItemId, id);
    if (input.conversationId !== undefined) this.database.prepare('UPDATE published_artifacts SET conversation_id = ? WHERE id = ?').run(input.conversationId, id);
    if (input.workItemId !== undefined || input.conversationId !== undefined) this.addEvent(id, 'linked', artifact.version, 'Relationships updated.');
    return this.get(id);
  }

  addComment(id: string, input: { author: string; body: string; version?: number; anchor?: string }): ArtifactComment | null {
    const artifact = this.get(id);
    if (!artifact) return null;
    const comment: ArtifactComment = {
      id: randomUUID(),
      artifactId: id,
      version: input.version ?? artifact.version,
      author: input.author,
      body: input.body,
      anchor: input.anchor ?? null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.database.prepare('INSERT INTO artifact_comments (id, artifact_id, version, author, body, anchor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(comment.id, comment.artifactId, comment.version, comment.author, comment.body, comment.anchor, comment.createdAt);
    this.addEvent(id, 'commented', comment.version, `${input.author} left feedback.`);
    return comment;
  }

  resolveComment(id: string, commentId: string, resolved: boolean): ArtifactComment | null {
    const row = this.database.prepare('SELECT * FROM artifact_comments WHERE id = ? AND artifact_id = ?').get(commentId, id) as Row | undefined;
    if (!row) return null;
    this.database.prepare('UPDATE artifact_comments SET resolved_at = ? WHERE id = ?').run(resolved ? new Date().toISOString() : null, commentId);
    const updated = this.database.prepare('SELECT * FROM artifact_comments WHERE id = ?').get(commentId) as Row;
    return mapComment(updated);
  }

  addEvent(id: string, kind: ArtifactEventKind, version: number | null, detail: string): void {
    this.database.prepare('INSERT INTO artifact_events (id, artifact_id, kind, version, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, kind, version, detail, new Date().toISOString());
  }
}

export interface ArtifactFeedbackConfig {
  /** Origin coworkers' browsers post feedback to, e.g. the ngrok hostname. */
  endpointOrigin: string;
  /** Origin the published pages are served from, allowed through CORS. */
  pageOrigin: string;
}

/**
 * Shared artifacts accept comments when Workbench has a public origin. Use the explicit
 * feedback origin when present; otherwise `APP_API_ORIGIN` is the already-configured
 * public Workbench URL. Without either, shared pages remain read-only.
 */
export function artifactFeedbackConfig(env: NodeJS.ProcessEnv = process.env): ArtifactFeedbackConfig | null {
  const publicUrl = (env.WORKBENCH_PUBLIC_URL ?? env.APP_API_ORIGIN)?.trim().replace(/\/$/, '');
  const baseUrl = env.ARTIFACT_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  if (!publicUrl || !baseUrl) return null;
  try {
    return { endpointOrigin: new URL(publicUrl).origin, pageOrigin: new URL(baseUrl).origin };
  } catch {
    return null;
  }
}

/**
 * The feedback endpoint is unauthenticated by design, so it gets a small
 * in-memory budget per artifact. Restarting Workbench resets it; that is
 * acceptable for a personal control plane and keeps the limiter dependency-free.
 */
export function createCommentRateLimiter(limit = 20, windowMs = 10 * 60_000, now = () => Date.now()) {
  const hits = new Map<string, number[]>();
  return function allow(key: string): boolean {
    const current = now();
    const recent = (hits.get(key) ?? []).filter((stamp) => current - stamp < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(current);
    hits.set(key, recent);
    return true;
  };
}
