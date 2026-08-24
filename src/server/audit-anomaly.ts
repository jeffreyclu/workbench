import type { AuditLogEntry } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';

/**
 * A read-only, aggregate-only rate anomaly in `audit_log`. `detail` and work
 * item identifiers never leave the query: an anomaly says a stream's volume
 * changed, not what any individual event contained.
 */
export interface AuditRateAnomaly {
  category: AuditLogEntry['category'];
  source: string;
  bucketStart: string;
  bucketEnd: string;
  eventCount: number;
  baselineMean: number;
  baselineStddev: number;
  threshold: number;
  deviationSigma: number | null;
}

export interface AuditRateAnomalyOptions {
  /** Width of an event-rate bucket. Defaults to one hour. */
  bucketMs?: number;
  /** Number of immediately preceding buckets used as the rolling baseline. */
  baselineBuckets?: number;
  /** Minimum prior buckets required before considering a stream stable enough to evaluate. */
  minBaselineBuckets?: number;
  /** Minimum number of prior events required before considering a stream stable enough to evaluate. */
  minBaselineEvents?: number;
  /** Suppresses small-volume deviations that do not warrant attention. */
  minAnomalousEvents?: number;
  /** Standard deviations above the baseline mean needed to flag a bucket. */
  sigmaThreshold?: number;
}

const DEFAULTS: Required<AuditRateAnomalyOptions> = {
  bucketMs: 60 * 60 * 1_000,
  baselineBuckets: 24,
  minBaselineBuckets: 24,
  minBaselineEvents: 24,
  minAnomalousEvents: 3,
  sigmaThreshold: 2,
};

interface AuditRateRow {
  category: AuditLogEntry['category'];
  source: string;
  created_at: string;
}

interface RateStream {
  category: AuditLogEntry['category'];
  source: string;
  countsByBucket: Map<number, number>;
  firstBucket: number;
  lastBucket: number;
}

function resolveOptions(options: AuditRateAnomalyOptions): Required<AuditRateAnomalyOptions> {
  const resolved = { ...DEFAULTS, ...options };
  if (!Number.isInteger(resolved.bucketMs) || resolved.bucketMs <= 0) throw new Error('bucketMs must be a positive integer.');
  if (!Number.isInteger(resolved.baselineBuckets) || resolved.baselineBuckets < 2) throw new Error('baselineBuckets must be an integer of at least 2.');
  if (!Number.isInteger(resolved.minBaselineBuckets) || resolved.minBaselineBuckets < 2 || resolved.minBaselineBuckets > resolved.baselineBuckets) throw new Error('minBaselineBuckets must be between 2 and baselineBuckets.');
  if (!Number.isInteger(resolved.minBaselineEvents) || resolved.minBaselineEvents < 1) throw new Error('minBaselineEvents must be a positive integer.');
  if (!Number.isInteger(resolved.minAnomalousEvents) || resolved.minAnomalousEvents < 1) throw new Error('minAnomalousEvents must be a positive integer.');
  if (!Number.isFinite(resolved.sigmaThreshold) || resolved.sigmaThreshold <= 0) throw new Error('sigmaThreshold must be greater than zero.');
  return resolved;
}

function sampleStddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

/**
 * Detects unusually high hourly audit-event rates for each category/source
 * stream. A bucket is compared only with its own immediately preceding rate
 * history, including zero-event buckets, so unrelated sources and diurnal
 * inactivity cannot inflate its baseline.
 *
 * This intentionally does not persist flags or expose an HTTP route. Callers
 * can run it as an internal batch query and decide how to notify on its
 * aggregate output.
 */
export function auditLogRateAnomalies(database: WorkbenchDatabase, options: AuditRateAnomalyOptions = {}): AuditRateAnomaly[] {
  const config = resolveOptions(options);
  const streams = new Map<string, RateStream>();
  const rows = database.prepare(`
    SELECT category, source, created_at
    FROM audit_log
    ORDER BY category ASC, source ASC, created_at ASC
  `).all() as unknown as AuditRateRow[];

  for (const row of rows) {
    const timestamp = Date.parse(row.created_at);
    if (Number.isNaN(timestamp)) continue;
    const bucket = Math.floor(timestamp / config.bucketMs) * config.bucketMs;
    const key = `${row.category}\u0000${row.source}`;
    const stream = streams.get(key) ?? {
      category: row.category,
      source: row.source,
      countsByBucket: new Map<number, number>(),
      firstBucket: bucket,
      lastBucket: bucket,
    };
    stream.countsByBucket.set(bucket, (stream.countsByBucket.get(bucket) ?? 0) + 1);
    stream.firstBucket = Math.min(stream.firstBucket, bucket);
    stream.lastBucket = Math.max(stream.lastBucket, bucket);
    streams.set(key, stream);
  }

  const anomalies: AuditRateAnomaly[] = [];
  for (const stream of streams.values()) {
    const counts: number[] = [];
    for (let bucket = stream.firstBucket; bucket <= stream.lastBucket; bucket += config.bucketMs) {
      const eventCount = stream.countsByBucket.get(bucket) ?? 0;
      if (counts.length >= config.minBaselineBuckets) {
        const baseline = counts.slice(-config.baselineBuckets);
        const baselineEvents = baseline.reduce((sum, count) => sum + count, 0);
        if (baselineEvents >= config.minBaselineEvents && eventCount >= config.minAnomalousEvents) {
          const baselineMean = baselineEvents / baseline.length;
          const baselineStddev = sampleStddev(baseline, baselineMean);
          const threshold = baselineMean + config.sigmaThreshold * baselineStddev;
          if (eventCount > threshold) {
            anomalies.push({
              category: stream.category,
              source: stream.source,
              bucketStart: new Date(bucket).toISOString(),
              bucketEnd: new Date(bucket + config.bucketMs).toISOString(),
              eventCount,
              baselineMean,
              baselineStddev,
              threshold,
              deviationSigma: baselineStddev === 0 ? null : (eventCount - baselineMean) / baselineStddev,
            });
          }
        }
      }
      counts.push(eventCount);
    }
  }

  return anomalies.sort((left, right) => right.eventCount - left.eventCount || left.bucketStart.localeCompare(right.bucketStart));
}
