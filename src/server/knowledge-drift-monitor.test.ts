import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { checkKnowledgeDrift } from './knowledge-drift.js';
import { startKnowledgeDriftMonitor } from './knowledge-drift-monitor.js';
import { readKnowledgeDriftReport } from './knowledge-drift-store.js';

describe('knowledge drift monitor', () => {
  let database: WorkbenchDatabase | undefined;
  let monitor: { stop: () => void } | undefined;

  afterEach(() => {
    monitor?.stop();
    database?.close();
  });

  it('runs a due check and stores the latest report', async () => {
    database = openDatabase(':memory:');
    const report = checkKnowledgeDrift({ sharedFiles: [], knowledgeFiles: [], sharedIndex: '', knowledgeIndex: '', now: '2026-10-08T12:00:00.000Z' });
    const runCheck = vi.fn(async () => report);
    monitor = startKnowledgeDriftMonitor(database, { now: () => Date.parse(report.checkedAt), runCheck, pollMs: 1_000_000 });

    await vi.waitFor(() => expect(readKnowledgeDriftReport(database!)).toEqual(report));
    expect(runCheck).toHaveBeenCalledOnce();
  });
});
