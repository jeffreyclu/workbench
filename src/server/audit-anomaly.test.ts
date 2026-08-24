import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogRateAnomalies } from './audit-anomaly.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';

describe('auditLogRateAnomalies', () => {
  let database: WorkbenchDatabase;

  beforeEach(() => {
    database = openDatabase(':memory:');
  });

  afterEach(() => {
    database.close();
  });

  function insertEvents(category: 'outbound_call' | 'agent_file_read', source: string, bucket: number, count: number): void {
    for (let index = 0; index < count; index += 1) {
      database.prepare(`
        INSERT INTO audit_log (id, category, source, detail, work_item_id, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(`${category}-${source}-${bucket}-${index}`, category, source, `private ${index}`, new Date(bucket + index * 1_000).toISOString());
    }
  }

  it('flags a synthetic category/source rate spike above its rolling 2σ baseline without reading detail', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const hour = 60 * 60 * 1_000;
    const normalCounts = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 5];
    normalCounts.forEach((count, index) => insertEvents('outbound_call', 'linear', start + index * hour, count));
    insertEvents('outbound_call', 'linear', start + normalCounts.length * hour, 16);
    // A separate stream at the same time must not affect Linear's baseline.
    insertEvents('agent_file_read', 'codex', start + normalCounts.length * hour, 100);

    const anomalies = auditLogRateAnomalies(database, {
      baselineBuckets: 12,
      minBaselineBuckets: 12,
      minBaselineEvents: 48,
    });

    expect(anomalies).toEqual([expect.objectContaining({
      category: 'outbound_call', source: 'linear', eventCount: 16,
      baselineMean: 5, threshold: expect.any(Number), deviationSigma: expect.any(Number),
    })]);
    expect(anomalies[0].threshold).toBeLessThan(16);
    expect(anomalies[0].deviationSigma).toBeGreaterThan(2);
    expect(anomalies[0]).not.toHaveProperty('detail');
  });

  it('does not flag normal variance or sparse streams without enough event history', () => {
    const start = Date.parse('2026-01-02T00:00:00.000Z');
    const hour = 60 * 60 * 1_000;
    [4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 6, 5].forEach((count, index) => {
      insertEvents('outbound_call', 'linear', start + index * hour, count);
    });
    // This single event is above an all-zero rate, but lacks meaningful history.
    insertEvents('agent_file_read', 'claude', start + 12 * hour, 1);

    expect(auditLogRateAnomalies(database, {
      baselineBuckets: 12,
      minBaselineBuckets: 12,
      minBaselineEvents: 48,
    })).toEqual([]);
  });
});
