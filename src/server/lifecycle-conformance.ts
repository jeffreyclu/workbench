import { workItemStatusSchema } from '../shared/contracts.js';
import type { LifecycleExportEvent } from './process-mining.js';

/**
 * The intended lifecycle model, versioned independently from reports so a
 * future product decision can deliberately tighten the currently permissive
 * active-state workflow without rewriting historical analysis.
 *
 * Workbench deliberately permits moves between active states. Linear also
 * supplies terminal states directly, so this model validates the lifecycle
 * event semantics and trace continuity instead of inventing restrictions the
 * product does not enforce.
 */
export const WORK_ITEM_LIFECYCLE_MODEL_VERSION = 'work-item-lifecycle.v1';

export interface LifecycleDeviation {
  caseId: string;
  eventId: string | null;
  code: 'invalid_initial' | 'missing_initial' | 'multiple_initials' | 'invalid_transition' | 'status_discontinuity' | 'invalid_timestamp';
  message: string;
}

export interface LifecycleTransitionFrequency {
  from: string;
  to: string;
  count: number;
}

export interface LifecycleAnalysis {
  modelVersion: typeof WORK_ITEM_LIFECYCLE_MODEL_VERSION;
  generatedAt: string;
  caseCount: number;
  eventCount: number;
  transitionFrequencies: LifecycleTransitionFrequency[];
  statusTransitionFrequencies: LifecycleTransitionFrequency[];
  deviations: LifecycleDeviation[];
  dataQuality: {
    casesMissingInitial: number;
    casesWithMultipleInitials: number;
    sameTimestampPairs: number;
    invalidTimestampCount: number;
  };
}

const statusValues = new Set<string>(workItemStatusSchema.options);
const transitionLabel = (event: LifecycleExportEvent): string => `${event.fromStatus ?? 'start'} → ${event.toStatus}`;

function increment(frequencies: Map<string, number>, from: string, to: string): void {
  const key = `${from}\u0000${to}`;
  frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
}

function frequencyRows(frequencies: Map<string, number>): LifecycleTransitionFrequency[] {
  return [...frequencies.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('\u0000');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function transitionDeviation(event: LifecycleExportEvent): string | null {
  if (!statusValues.has(event.toStatus) || (event.fromStatus !== null && !statusValues.has(event.fromStatus))) {
    return 'references a status outside the Workbench status contract';
  }
  if ((event.activity === 'created' || event.activity === 'imported') && (!event.isInitial || event.fromStatus !== null)) {
    return 'must be the initial event with no prior status';
  }
  if (event.activity === 'status_changed' && (event.isInitial || event.fromStatus === null || event.fromStatus === event.toStatus)) {
    return 'must change from one status to a different status';
  }
  if (event.activity === 'completed' && (event.isInitial || event.toStatus !== 'done')) {
    return 'must move a non-initial event to done';
  }
  if (event.activity === 'archived' && (event.isInitial || event.fromStatus !== event.toStatus)) {
    return 'must preserve the current status';
  }
  if (event.activity === 'restored' && (event.isInitial || (event.fromStatus === 'done' || event.fromStatus === 'canceled' ? event.toStatus !== 'ready' : event.toStatus !== event.fromStatus))) {
    return 'must return a terminal task to ready or preserve an incomplete archived status';
  }
  return null;
}

/** Pure conformance and discovery analysis for privacy-safe lifecycle exports. */
export function analyzeLifecycle(events: readonly LifecycleExportEvent[], generatedAt = new Date().toISOString()): LifecycleAnalysis {
  const cases = new Map<string, LifecycleExportEvent[]>();
  for (const event of events) {
    const trace = cases.get(event.caseId) ?? [];
    trace.push(event);
    cases.set(event.caseId, trace);
  }

  const transitionFrequencies = new Map<string, number>();
  const statusTransitionFrequencies = new Map<string, number>();
  const deviations: LifecycleDeviation[] = [];
  let casesMissingInitial = 0;
  let casesWithMultipleInitials = 0;
  let sameTimestampPairs = 0;
  let invalidTimestampCount = 0;

  for (const [caseId, trace] of cases) {
    const initials = trace.filter((event) => event.isInitial);
    if (!initials.length) {
      casesMissingInitial += 1;
      deviations.push({ caseId, eventId: null, code: 'missing_initial', message: 'Trace has no initial lifecycle event.' });
    }
    if (initials.length > 1) {
      casesWithMultipleInitials += 1;
      deviations.push({ caseId, eventId: null, code: 'multiple_initials', message: `Trace has ${initials.length} initial lifecycle events.` });
    }

    let previous: LifecycleExportEvent | null = null;
    for (const event of trace) {
      const eventTime = Date.parse(event.timestamp);
      if (Number.isNaN(eventTime)) {
        invalidTimestampCount += 1;
        deviations.push({ caseId, eventId: event.eventId, code: 'invalid_timestamp', message: `Invalid ISO timestamp: ${event.timestamp}` });
      }
      const problem = transitionDeviation(event);
      if (problem) deviations.push({ caseId, eventId: event.eventId, code: event.isInitial ? 'invalid_initial' : 'invalid_transition', message: `${event.activity} ${problem}.` });
      increment(statusTransitionFrequencies, event.fromStatus ?? 'start', event.toStatus);
      if (previous) {
        increment(transitionFrequencies, transitionLabel(previous), transitionLabel(event));
        if (previous.timestamp === event.timestamp) sameTimestampPairs += 1;
        if (previous.toStatus !== event.fromStatus) {
          deviations.push({ caseId, eventId: event.eventId, code: 'status_discontinuity', message: `Expected prior status ${previous.toStatus}; event starts from ${event.fromStatus ?? 'none'}.` });
        }
      }
      previous = event;
    }
  }

  return {
    modelVersion: WORK_ITEM_LIFECYCLE_MODEL_VERSION,
    generatedAt,
    caseCount: cases.size,
    eventCount: events.length,
    transitionFrequencies: frequencyRows(transitionFrequencies),
    statusTransitionFrequencies: frequencyRows(statusTransitionFrequencies),
    deviations,
    dataQuality: { casesMissingInitial, casesWithMultipleInitials, sameTimestampPairs, invalidTimestampCount },
  };
}
