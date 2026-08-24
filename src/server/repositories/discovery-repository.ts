import { randomUUID } from 'node:crypto';

import type { DiscoveryCandidate, DiscoveryCandidateStatus, DiscoveryRun } from '../../shared/contracts.js';
import type { UnitOfWork } from '../unit-of-work.js';

function mapDiscoveryCandidate(row: Record<string, string | number | null>): DiscoveryCandidate {
  return {
    id: String(row.id), provider: String(row.provider), title: String(row.title), description: String(row.description ?? ''),
    sourceUrl: row.source_url ? String(row.source_url) : null, occurredAt: row.occurred_at ? String(row.occurred_at) : null,
    status: row.status as DiscoveryCandidateStatus, discoveredAt: String(row.discovered_at), updatedAt: String(row.updated_at),
    snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : null, workItemId: row.work_item_id ? String(row.work_item_id) : null,
    relevance: Number(row.relevance ?? 1), suggestedWorkItemId: row.suggested_work_item_id ? String(row.suggested_work_item_id) : null,
  };
}

function mapDiscoveryRun(row: Record<string, string | number | null>): DiscoveryRun {
  return {
    id: String(row.id), status: row.status as DiscoveryRun['status'], startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null, candidateCount: Number(row.candidate_count ?? 0),
    errors: JSON.parse(String(row.errors_json ?? '[]')) as string[],
  };
}

/**
 * Owns the `discovery_runs` and `discovery_candidates` tables. Candidate
 * resolution (convert/merge) reaches into work-item creation and activity
 * logging, which are outside this repository's tables, so that composition
 * stays in `WorkItemRepository` — this repository exposes the row-level
 * primitives (fetch pending row, apply resolution, refetch) that the caller
 * composes inside its own transaction.
 */
export class DiscoveryRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  listCandidates(view: 'pending' | 'reviewed'): DiscoveryCandidate[] {
    const now = new Date().toISOString();
    this.database.prepare("UPDATE discovery_candidates SET status = 'pending', snoozed_until = NULL, updated_at = ? WHERE status = 'snoozed' AND snoozed_until <= ?").run(now, now);
    const where = view === 'pending' ? "status = 'pending'" : "status IN ('converted', 'merged', 'dismissed', 'snoozed')";
    const order = view === 'pending' ? 'relevance DESC, COALESCE(occurred_at, discovered_at) DESC' : 'updated_at DESC';
    return (this.database.prepare(`SELECT * FROM discovery_candidates WHERE ${where} ORDER BY ${order}`).all() as Array<Record<string, string | number | null>>).map(mapDiscoveryCandidate);
  }

  getCandidateCounts(): { pending: number; reviewed: number } {
    const row = this.database.prepare(`SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status IN ('converted', 'merged', 'dismissed', 'snoozed') THEN 1 ELSE 0 END) reviewed FROM discovery_candidates`).get() as { pending: number | null; reviewed: number | null };
    return { pending: Number(row.pending ?? 0), reviewed: Number(row.reviewed ?? 0) };
  }

  getLastRun(): { run: DiscoveryRun | null; running: boolean } {
    const row = this.database.prepare('SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 1').get() as Record<string, string | number | null> | undefined;
    return { run: row ? mapDiscoveryRun(row) : null, running: row?.status === 'running' };
  }

  startRun(): DiscoveryRun {
    const running = this.database.prepare("SELECT * FROM discovery_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get() as Record<string, string | number | null> | undefined;
    if (running) return mapDiscoveryRun(running);
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare("INSERT INTO discovery_runs (id, status, started_at) VALUES (?, 'running', ?)").run(id, now);
    return { id, status: 'running', startedAt: now, completedAt: null, candidateCount: 0, errors: [] };
  }

  finishRun(id: string, candidateCount: number, errors: string[], failed = false): void {
    this.database.prepare('UPDATE discovery_runs SET status = ?, completed_at = ?, candidate_count = ?, errors_json = ? WHERE id = ?')
      .run(failed ? 'failed' : 'completed', new Date().toISOString(), candidateCount, JSON.stringify(errors), id);
  }

  candidateExists(fingerprint: string): boolean {
    return this.database.prepare('SELECT 1 FROM discovery_candidates WHERE fingerprint = ?').get(fingerprint) !== undefined;
  }

  /** Returns true when a new candidate row was inserted, false when an existing one was refreshed. */
  upsertCandidate(input: { fingerprint: string; provider: string; title: string; description: string; sourceUrl: string | null; occurredAt: string | null; runId: string; relevance?: number; suggestedWorkItemId: string | null }): boolean {
    const now = new Date().toISOString();
    const existing = this.database.prepare('SELECT status FROM discovery_candidates WHERE fingerprint = ?').get(input.fingerprint) as { status: DiscoveryCandidateStatus } | undefined;
    if (existing) {
      this.database.prepare(`UPDATE discovery_candidates SET title = ?, description = ?, source_url = ?, occurred_at = ?, updated_at = ?, run_id = ?, relevance = ?, suggested_work_item_id = ? WHERE fingerprint = ?`)
        .run(input.title, input.description, input.sourceUrl, input.occurredAt, now, input.runId, input.relevance ?? 1, input.suggestedWorkItemId, input.fingerprint);
      return false;
    }
    this.database.prepare(`INSERT INTO discovery_candidates (id, fingerprint, provider, title, description, source_url, occurred_at, status, discovered_at, updated_at, run_id, relevance, suggested_work_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(randomUUID(), input.fingerprint, input.provider, input.title, input.description, input.sourceUrl, input.occurredAt, now, now, input.runId, input.relevance ?? 1, input.suggestedWorkItemId);
    return true;
  }

  /** Suggested existing work item for a source URL, used to pre-link a candidate at upsert time. */
  findSuggestedWorkItemId(sourceUrl: string | null): string | null {
    if (!sourceUrl) return null;
    const row = this.database.prepare(`SELECT id FROM work_items WHERE source_url = ? AND archived_at IS NULL AND deleted_at IS NULL ORDER BY is_queued DESC, updated_at DESC LIMIT 1`).get(sourceUrl) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getPendingCandidate(id: string): DiscoveryCandidate | null {
    const row = this.database.prepare("SELECT * FROM discovery_candidates WHERE id = ? AND status = 'pending'").get(id) as Record<string, string | number | null> | undefined;
    return row ? mapDiscoveryCandidate(row) : null;
  }

  getCandidate(id: string): DiscoveryCandidate | null {
    const row = this.database.prepare('SELECT * FROM discovery_candidates WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return row ? mapDiscoveryCandidate(row) : null;
  }

  applyResolution(id: string, status: DiscoveryCandidateStatus, workItemId: string | null, snoozedUntil: string | null): DiscoveryCandidate | null {
    this.database.prepare("UPDATE discovery_candidates SET status = ?, work_item_id = ?, snoozed_until = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, workItemId, snoozedUntil, new Date().toISOString(), id);
    return this.getCandidate(id);
  }

  updateFields(id: string, changes: { title?: string; description?: string }): DiscoveryCandidate | null {
    const entries = Object.entries(changes).filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (!entries.length) return null;
    const columns: Record<string, string> = { title: 'title', description: 'description' };
    const changed = this.database.prepare(`UPDATE discovery_candidates SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(...entries.map(([, value]) => value), new Date().toISOString(), id).changes;
    return changed ? this.getCandidate(id) : null;
  }

  restoreCandidate(id: string): DiscoveryCandidate | null {
    const changed = this.database.prepare("UPDATE discovery_candidates SET status = 'pending', snoozed_until = NULL, updated_at = ? WHERE id = ? AND status IN ('dismissed', 'snoozed')").run(new Date().toISOString(), id).changes;
    return changed ? this.getCandidate(id) : null;
  }
}
