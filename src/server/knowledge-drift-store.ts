import type { WorkbenchDatabase } from './database.js';
import type { KnowledgeDriftReport } from './knowledge-drift.js';

export function storeKnowledgeDriftReport(database: WorkbenchDatabase, report: KnowledgeDriftReport) {
  database.prepare(`INSERT INTO knowledge_drift_reports (id, checked_at, report_json)
    VALUES ('latest', ?, ?)
    ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at, report_json = excluded.report_json`)
    .run(report.checkedAt, JSON.stringify(report));
}

export function readKnowledgeDriftReport(database: WorkbenchDatabase): KnowledgeDriftReport | null {
  const row = database.prepare("SELECT report_json FROM knowledge_drift_reports WHERE id = 'latest'").get() as { report_json: string } | undefined;
  return row ? JSON.parse(row.report_json) as KnowledgeDriftReport : null;
}
