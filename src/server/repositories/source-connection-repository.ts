import type { SourceConnection, SourceProvider } from '../../shared/contracts.js';
import type { UnitOfWork } from '../unit-of-work.js';

const isReauthenticationMessage = (message: string) => /authorization expired\. Reconnect this source\.$/.test(message);

/**
 * Owns the `source_connections` table exclusively — connecting, scanning
 * status, and soft delete of a provider connection. Nothing else in the
 * schema references this table, so every method here is a single-statement
 * operation with no need to compose inside a shared transaction.
 */
export class SourceConnectionRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  listSourceConnections(): SourceConnection[] {
    const rows = this.database.prepare('SELECT provider, label, last_scanned_at, last_error FROM source_connections WHERE deleted_at IS NULL ORDER BY provider').all() as Array<Record<string, string | null>>;
    return rows.map((row) => ({ provider: row.provider as SourceProvider, connected: true, label: row.label!, lastScannedAt: row.last_scanned_at, lastError: row.last_error, configurationState: row.last_error && isReauthenticationMessage(row.last_error) ? 'reauth_required' as const : 'connected' as const, health: row.last_error ? 'unavailable' as const : row.last_scanned_at ? 'healthy' as const : 'unknown' as const }));
  }

  getSourceSettings(provider: SourceProvider): Record<string, string> | null {
    const row = this.database.prepare('SELECT settings_json FROM source_connections WHERE provider = ? AND deleted_at IS NULL').get(provider) as { settings_json: string } | undefined;
    return row ? JSON.parse(row.settings_json) as Record<string, string> : null;
  }

  setSourceConnection(provider: SourceProvider, label: string, settings: Record<string, string>): SourceConnection {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO source_connections (provider, label, settings_json, connected_at, last_error)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET label = excluded.label, settings_json = excluded.settings_json, connected_at = excluded.connected_at, last_error = NULL, deleted_at = NULL`)
      .run(provider, label, JSON.stringify(settings), now);
    return this.listSourceConnections().find((connection) => connection.provider === provider)!;
  }

  updateSourceSettings(provider: SourceProvider, settings: Record<string, unknown>): void {
    this.database.prepare('UPDATE source_connections SET settings_json = ? WHERE provider = ? AND deleted_at IS NULL').run(JSON.stringify(settings), provider);
  }

  updateSourceScan(provider: SourceProvider, error: string | null): void {
    this.database.prepare('UPDATE source_connections SET last_scanned_at = ?, last_error = ? WHERE provider = ? AND deleted_at IS NULL').run(new Date().toISOString(), error, provider);
  }

  markSourceReauthRequired(provider: SourceProvider, message: string): void {
    this.database.prepare('UPDATE source_connections SET last_scanned_at = ?, last_error = ? WHERE provider = ? AND deleted_at IS NULL').run(new Date().toISOString(), message, provider);
  }

  /** Soft delete: flags the row so it drops out of connection listings but stays recoverable in the database. Reconnecting the same provider (setSourceConnection) clears the flag. */
  removeSourceConnection(provider: SourceProvider): boolean {
    return Number(this.database.prepare('UPDATE source_connections SET deleted_at = ? WHERE provider = ? AND deleted_at IS NULL').run(new Date().toISOString(), provider).changes) > 0;
  }
}
