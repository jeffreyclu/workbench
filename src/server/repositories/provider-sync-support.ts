import type { ProviderSyncField, WorkItem } from '../../shared/contracts.js';
import type { WorkItemRow } from './work-item-repository.js';

export interface ProviderWorkItem {
  sourceIdentifier: string;
  sourceUrl: string | null;
  title: string;
  description: string;
  status: WorkItem['status'];
  priority: number;
  projectName: string | null;
  labels: string[];
  dueDate: string | null;
  providerUpdatedAt: string;
  providerPayload: unknown;
}

export type ProviderFieldValue = string | string[] | null;
export type ProviderSnapshotValues = Record<ProviderSyncField, ProviderFieldValue>;

export interface ProviderSnapshotRow {
  normalized_json: string;
  raw_payload_json: string;
  provider_updated_at: string | null;
  synced_at: string;
}

export interface ProviderOverrideRow {
  field: ProviderSyncField;
  provider_baseline_json: string;
  conflicted_at: string | null;
}

export const providerSyncFields: readonly ProviderSyncField[] = ['title', 'description', 'status', 'projectName', 'labels', 'dueDate'];
export const providerFieldColumns: Record<ProviderSyncField, string> = {
  title: 'title', description: 'description', status: 'status', projectName: 'project_name', labels: 'labels_json', dueDate: 'due_date',
};

export function normalizeLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort((left, right) => left.localeCompare(right));
}

export function providerValues(value: Pick<WorkItem, ProviderSyncField> | ProviderWorkItem | WorkItemRow): ProviderSnapshotValues {
  if ('project_name' in value) {
    return {
      title: value.title, description: value.description, status: value.status, projectName: value.project_name,
      labels: normalizeLabels(JSON.parse(value.labels_json) as string[]), dueDate: value.due_date,
    };
  }
  return {
    title: value.title, description: value.description, status: value.status, projectName: value.projectName,
    labels: normalizeLabels(value.labels), dueDate: value.dueDate,
  };
}

export function sameProviderValue(left: ProviderFieldValue, right: ProviderFieldValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function databaseProviderValue(field: ProviderSyncField, value: ProviderFieldValue): string | null {
  return field === 'labels' ? JSON.stringify(value) : value as string | null;
}

export function parseProviderValue(value: string): ProviderFieldValue {
  return JSON.parse(value) as ProviderFieldValue;
}
