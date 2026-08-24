import { randomUUID } from 'node:crypto';

import type { Activity, LinearProviderConfig, ProviderSyncConflict, ProviderSyncConflictResolution, ProviderSyncField, WorkItem } from '../../shared/contracts.js';
import { resolveProjectName } from '../project-registry.js';
import { projectKey } from '../../shared/project-name.js';
import type { WorkbenchDatabase } from '../database.js';
import type { UnitOfWork } from '../unit-of-work.js';
import { recordLifecycleEvent } from '../lifecycle-events.js';
import type { WorkItemRow } from '../repositories/work-item-repository.js';
import {
  databaseProviderValue,
  parseProviderValue,
  providerFieldColumns,
  providerSyncFields,
  providerValues,
  sameProviderValue,
  type ProviderOverrideRow,
  type ProviderSnapshotRow,
  type ProviderSnapshotValues,
  type ProviderWorkItem,
} from '../repositories/provider-sync-support.js';

export type { ProviderWorkItem } from '../repositories/provider-sync-support.js';

export interface ProviderSyncCollaborators {
  get(id: string): WorkItem | null;
  addActivity(workItemId: string, actor: Activity['actor'], kind: string, body: string): Activity;
}

/**
 * Owns the Linear import/sync surface: upserting provider rows, tracking which
 * fields a human has locally overridden against the provider's value, and
 * resolving conflicts. `get`/`addActivity` stay on the work-item repository
 * (activities and reads are shared beyond provider-sync), so they're injected
 * rather than duplicated here.
 */
export class ProviderSyncService {
  constructor(
    private readonly database: WorkbenchDatabase,
    private readonly unitOfWork: UnitOfWork,
    private readonly collaborators: ProviderSyncCollaborators,
  ) {}

  upsertLinearItem(providerInput: ProviderWorkItem): 'imported' | 'updated' | 'skipped' {
    const existing = this.database
      .prepare("SELECT * FROM work_items WHERE source = 'linear' AND source_identifier = ?")
      .get(providerInput.sourceIdentifier) as WorkItemRow | undefined;

    const now = new Date().toISOString();
    // Linear owns its project names, so resolution is exact-key only: casing and
    // punctuation are unified with what Workbench already knows, but two
    // similar Linear projects stay two projects. Canonicalising here rather than
    // at each write keeps the row, the snapshot, and the conflict baseline
    // agreeing on one spelling.
    const project = resolveProjectName(this.database, providerInput.projectName, { fuzzy: false, now });
    const input: ProviderWorkItem = { ...providerInput, projectName: project?.name ?? null };
    const incoming = providerValues(input);

    if (existing) {
      const snapshotRow = this.database.prepare('SELECT * FROM provider_work_item_snapshots WHERE work_item_id = ?').get(existing.id) as ProviderSnapshotRow | undefined;
      if (existing.provider_updated_at === input.providerUpdatedAt && snapshotRow) return 'skipped';
      const previousSnapshot = snapshotRow ? JSON.parse(snapshotRow.normalized_json) as ProviderSnapshotValues : null;
      const overrides = this.database.prepare('SELECT field, provider_baseline_json, conflicted_at FROM provider_field_overrides WHERE work_item_id = ?').all(existing.id) as unknown as ProviderOverrideRow[];
      const overrideByField = new Map(overrides.map((override) => [override.field, override]));
      const effective = providerValues(existing);
      const assignments: string[] = [];
      const values: Array<string | null> = [];
      let visibleChanged = false;

      this.unitOfWork.transaction(() => {
        for (const field of providerSyncFields) {
          const override = overrideByField.get(field);
          if (!override) {
            // Existing installations have no trustworthy normalized base. Keep
            // a differing local value and make it reviewable rather than lose it.
            if (!previousSnapshot && !sameProviderValue(effective[field], incoming[field])) {
              this.database.prepare(`INSERT INTO provider_field_overrides (work_item_id, field, provider_baseline_json, conflicted_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
                .run(existing.id, field, JSON.stringify(effective[field]), now, now, now);
              continue;
            }
            if (!sameProviderValue(effective[field], incoming[field])) {
              assignments.push(`${providerFieldColumns[field]} = ?`);
              values.push(databaseProviderValue(field, incoming[field]));
              // The key is derived, so it moves with the name it belongs to.
              if (field === 'projectName') { assignments.push('project_key = ?'); values.push(project?.key ?? null); }
              visibleChanged = true;
            }
            continue;
          }
          const baseline = parseProviderValue(override.provider_baseline_json);
          if (sameProviderValue(effective[field], incoming[field])) {
            this.database.prepare('DELETE FROM provider_field_overrides WHERE work_item_id = ? AND field = ?').run(existing.id, field);
          } else if (!sameProviderValue(baseline, incoming[field])) {
            this.database.prepare('UPDATE provider_field_overrides SET conflicted_at = COALESCE(conflicted_at, ?), updated_at = ? WHERE work_item_id = ? AND field = ?')
              .run(now, now, existing.id, field);
          }
        }
        const metadataAssignments = ['source_url = ?', 'provider_payload_json = ?', 'provider_updated_at = ?'];
        const metadataValues: Array<string | null> = [input.sourceUrl, JSON.stringify(input.providerPayload), input.providerUpdatedAt];
        if (visibleChanged) {
          assignments.push('updated_at = ?', 'last_touched_at = ?');
          values.push(now, now);
        }
        this.database.prepare(`UPDATE work_items SET ${[...assignments, ...metadataAssignments].join(', ')} WHERE id = ?`)
          .run(...values, ...metadataValues, existing.id);
        if (assignments.some((assignment) => assignment.startsWith('status ='))) {
          recordLifecycleEvent(this.database, {
            workItemId: existing.id,
            transition: 'status_changed',
            fromStatus: existing.status,
            toStatus: input.status,
            isInitial: false,
            actor: 'system',
            source: 'linear',
            occurredAt: now,
          });
        }
        this.database.prepare(`INSERT INTO provider_work_item_snapshots (work_item_id, provider, normalized_json, raw_payload_json, provider_updated_at, synced_at)
          VALUES (?, 'linear', ?, ?, ?, ?)
          ON CONFLICT(work_item_id) DO UPDATE SET normalized_json = excluded.normalized_json, raw_payload_json = excluded.raw_payload_json,
            provider_updated_at = excluded.provider_updated_at, synced_at = excluded.synced_at`)
          .run(existing.id, JSON.stringify(incoming), JSON.stringify(input.providerPayload), input.providerUpdatedAt, now);
      });
      return 'updated';
    }

    const id = randomUUID();
    const position = Number(
      (this.database.prepare('SELECT COALESCE(MAX(queue_position), 0) + 1 AS value FROM work_items').get() as {
        value: number;
      }).value,
    );
    this.database
      .prepare(`
        INSERT INTO work_items (
          id, title, description, status, priority, queue_position, source, is_queued,
          source_identifier, source_url, project_name, project_key, labels_json, due_date,
          provider_payload_json, provider_updated_at, created_at, updated_at, last_touched_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'linear', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.title,
        input.description,
        input.status,
        input.priority,
        position,
        input.sourceIdentifier,
        input.sourceUrl,
        input.projectName,
        project?.key ?? null,
        JSON.stringify(input.labels),
        input.dueDate,
        JSON.stringify(input.providerPayload),
        input.providerUpdatedAt,
        now,
        now,
        now,
      );
    this.collaborators.addActivity(id, 'system', 'imported', `Imported from Linear as ${input.sourceIdentifier}.`);
    recordLifecycleEvent(this.database, { workItemId: id, transition: 'imported', fromStatus: null, toStatus: input.status, isInitial: true, actor: 'system', source: 'linear', occurredAt: now });
    this.database.prepare(`INSERT INTO provider_work_item_snapshots (work_item_id, provider, normalized_json, raw_payload_json, provider_updated_at, synced_at)
      VALUES (?, 'linear', ?, ?, ?, ?)`)
      .run(id, JSON.stringify(incoming), JSON.stringify(input.providerPayload), input.providerUpdatedAt, now);
    return 'imported';
  }

  /** Sync a Linear page atomically; individual upserts compose with this transaction. */
  upsertLinearItems(inputs: ProviderWorkItem[]): Array<'imported' | 'updated' | 'skipped'> {
    return this.unitOfWork.transaction(() => inputs.map((input) => this.upsertLinearItem(input)));
  }

  listProviderConflicts(workItemId: string): ProviderSyncConflict[] {
    const item = this.collaborators.get(workItemId);
    if (!item) return [];
    const snapshot = this.database.prepare('SELECT normalized_json FROM provider_work_item_snapshots WHERE work_item_id = ?').get(workItemId) as Pick<ProviderSnapshotRow, 'normalized_json'> | undefined;
    if (!snapshot) return [];
    const provider = JSON.parse(snapshot.normalized_json) as ProviderSnapshotValues;
    return (this.database.prepare('SELECT field, provider_baseline_json, conflicted_at FROM provider_field_overrides WHERE work_item_id = ? AND conflicted_at IS NOT NULL ORDER BY conflicted_at DESC').all(workItemId) as unknown as ProviderOverrideRow[])
      .map((row) => ({ field: row.field, localValue: providerValues(item)[row.field], providerValue: provider[row.field], providerBaseline: parseProviderValue(row.provider_baseline_json), conflictedAt: row.conflicted_at! }));
  }

  countProviderConflicts(): number {
    return (this.database.prepare('SELECT COUNT(*) AS count FROM provider_field_overrides WHERE conflicted_at IS NOT NULL').get() as { count: number }).count;
  }

  resolveProviderConflict(workItemId: string, field: ProviderSyncField, resolution: ProviderSyncConflictResolution): WorkItem | null {
    const item = this.collaborators.get(workItemId);
    const snapshotRow = this.database.prepare('SELECT normalized_json FROM provider_work_item_snapshots WHERE work_item_id = ?').get(workItemId) as Pick<ProviderSnapshotRow, 'normalized_json'> | undefined;
    const override = this.database.prepare('SELECT field, provider_baseline_json, conflicted_at FROM provider_field_overrides WHERE work_item_id = ? AND field = ? AND conflicted_at IS NOT NULL').get(workItemId, field) as ProviderOverrideRow | undefined;
    if (!item || !snapshotRow || !override) return null;
    const provider = JSON.parse(snapshotRow.normalized_json) as ProviderSnapshotValues;
    const now = new Date().toISOString();
    this.unitOfWork.transaction(() => {
      if (resolution === 'use_provider') {
        // Accepting the provider's project name must carry its key across too,
        // or the task keeps the old key and stays in the wrong stack.
        const keyColumn = field === 'projectName' ? ', project_key = ?' : '';
        const keyValue = field === 'projectName' ? [projectKey(provider[field] as string | null) || null] : [];
        this.database.prepare(`UPDATE work_items SET ${providerFieldColumns[field]} = ?${keyColumn}, updated_at = ?, last_touched_at = ? WHERE id = ?`)
          .run(databaseProviderValue(field, provider[field]), ...keyValue, now, now, workItemId);
        this.database.prepare('DELETE FROM provider_field_overrides WHERE work_item_id = ? AND field = ?').run(workItemId, field);
      } else {
        this.database.prepare('UPDATE provider_field_overrides SET provider_baseline_json = ?, conflicted_at = NULL, updated_at = ? WHERE work_item_id = ? AND field = ?')
          .run(JSON.stringify(provider[field]), now, workItemId, field);
      }
      this.collaborators.addActivity(workItemId, 'jeffrey', 'provider_conflict_resolved', `${resolution === 'use_provider' ? 'Accepted Linear' : 'Kept local'} ${field} after a sync conflict.`);
    });
    return this.collaborators.get(workItemId);
  }

  getLinearConfig(): LinearProviderConfig {
    const row = this.database
      .prepare("SELECT metadata_json FROM sync_state WHERE provider = 'linear'")
      .get() as { metadata_json: string | null } | undefined;
    if (!row?.metadata_json) return { teamIds: [], projectIds: [] };
    try {
      const value = JSON.parse(row.metadata_json) as Partial<LinearProviderConfig>;
      return {
        teamIds: Array.isArray(value.teamIds) ? value.teamIds : [],
        projectIds: Array.isArray(value.projectIds) ? value.projectIds : [],
      };
    } catch {
      return { teamIds: [], projectIds: [] };
    }
  }

  setLinearConfig(config: LinearProviderConfig): LinearProviderConfig {
    this.database
      .prepare(`
        INSERT INTO sync_state (provider, metadata_json)
        VALUES ('linear', ?)
        ON CONFLICT(provider) DO UPDATE SET metadata_json = excluded.metadata_json
      `)
      .run(JSON.stringify(config));
    return config;
  }
}
