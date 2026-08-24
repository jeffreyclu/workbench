import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './database.js';
import { generateLifecycleReport, lifecycleReportStatus } from './lifecycle-report.js';
import { WorkItemRepository } from './repository.js';

describe('scheduled lifecycle report output', () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it('waits for complete instrumented traces and never writes a report from partial history', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const outputDirectory = mkdtempSync(join(tmpdir(), 'workbench-lifecycle-report-'));
    directories.push(outputDirectory);
    const item = repository.create({ title: 'Partial trace', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    database.prepare('DELETE FROM work_item_lifecycle_events WHERE work_item_id = ?').run(item.id);
    database.prepare(`INSERT INTO work_item_lifecycle_events (id, work_item_id, transition, from_status, to_status, is_initial, actor, source, reason, occurred_at) VALUES ('event-1', ?, 'completed', 'ready', 'done', 0, 'human', 'http', NULL, '2026-08-24T00:00:00.000Z')`).run(item.id);

    const result = generateLifecycleReport(database, { outputDirectory, minimumCompletedCases: 1 });

    expect(result).toMatchObject({ eligibleCompletedCases: 0, report: null });
    expect(existsSync(join(outputDirectory, 'report.html'))).toBe(false);
    database.close();
  });

  it('writes privacy-safe CSV, XES, JSON, SVG, and HTML after the threshold is met', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const outputDirectory = mkdtempSync(join(tmpdir(), 'workbench-lifecycle-report-'));
    directories.push(outputDirectory);
    const item = repository.create({ title: 'Complete trace', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const insert = database.prepare(`INSERT INTO work_item_lifecycle_events (id, work_item_id, transition, from_status, to_status, is_initial, actor, source, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, 'human', 'http', NULL, ?)`);
    insert.run('event-2', item.id, 'completed', 'ready', 'done', 0, '2026-08-24T01:00:00.000Z');

    const result = generateLifecycleReport(database, { outputDirectory, minimumCompletedCases: 1 });

    expect(result.report).toMatchObject({ caseCount: 1, eventCount: 2 });
    for (const name of ['lifecycle.csv', 'lifecycle.xes', 'conformance.json', 'lifecycle-graph.svg', 'report.html']) expect(existsSync(join(outputDirectory, name))).toBe(true);
    expect(lifecycleReportStatus(database, { outputDirectory, minimumCompletedCases: 1 }).report?.caseCount).toBe(1);
    database.close();
  });
});
