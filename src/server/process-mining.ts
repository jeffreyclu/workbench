import type { WorkItemStatus } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';

/** A privacy-safe event record consumable by CSV, XES, and offline analyzers. */
export interface LifecycleExportEvent {
  caseId: string;
  eventId: string;
  activity: string;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus;
  isInitial: boolean;
  actor: string;
  source: string;
  reason: string | null;
  timestamp: string;
}

interface LifecycleEventRow {
  id: string; work_item_id: string; transition: string; from_status: WorkItemStatus | null; to_status: WorkItemStatus;
  is_initial: number; actor: string; source: string; reason: string | null; occurred_at: string;
}

/**
 * Returns the canonical lifecycle log in a stable order. `id` is the final
 * tie-breaker because timestamp resolution is milliseconds; it preserves the
 * SQLite insertion order when two writes share a clock tick.
 */
export function lifecycleExportEvents(database: WorkbenchDatabase): LifecycleExportEvent[] {
  const rows = database.prepare(`SELECT id, work_item_id, transition, from_status, to_status, is_initial, actor, source, reason, occurred_at
    FROM work_item_lifecycle_events
    ORDER BY work_item_id, occurred_at, rowid`).all() as unknown as LifecycleEventRow[];
  return rows.map((row) => ({
    caseId: row.work_item_id, eventId: row.id, activity: row.transition, fromStatus: row.from_status,
    toStatus: row.to_status, isInitial: row.is_initial === 1, actor: row.actor, source: row.source,
    reason: row.reason, timestamp: row.occurred_at,
  }));
}

const csvCell = (value: string | number | boolean | null): string => {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Standard flat event-log interchange. No task titles, descriptions, or activity bodies are exported. */
export function lifecycleCsv(events: readonly LifecycleExportEvent[]): string {
  const header = ['case:concept:name', 'concept:name', 'time:timestamp', 'event:id', 'from_status', 'to_status', 'is_initial', 'org:resource', 'source', 'reason'];
  const rows = events.map((event) => [event.caseId, event.activity, event.timestamp, event.eventId, event.fromStatus, event.toStatus,
    event.isInitial, event.actor, event.source, event.reason].map(csvCell).join(','));
  return `${header.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const xesString = (key: string, value: string) => `      <string key="${xml(key)}" value="${xml(value)}"/>`;

/** XES 1.0 XML, grouped into one trace for each work item. */
export function lifecycleXes(events: readonly LifecycleExportEvent[]): string {
  const traces = new Map<string, LifecycleExportEvent[]>();
  for (const event of events) {
    const trace = traces.get(event.caseId) ?? [];
    trace.push(event);
    traces.set(event.caseId, trace);
  }
  const body = [...traces.entries()].map(([caseId, trace]) => [
    '  <trace>', xesString('concept:name', caseId), ...trace.flatMap((event) => [
      '    <event>',
      `      <string key="concept:name" value="${xml(event.activity)}"/>`,
      `      <date key="time:timestamp" value="${xml(event.timestamp)}"/>`,
      xesString('event:id', event.eventId), xesString('from_status', event.fromStatus ?? ''), xesString('to_status', event.toStatus),
      `      <boolean key="is_initial" value="${event.isInitial}"/>`, xesString('org:resource', event.actor), xesString('source', event.source),
      ...(event.reason ? [xesString('reason', event.reason)] : []), '    </event>',
    ]), '  </trace>',
  ].join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<log xes.version="1.0" xes.features="nested-attributes" openxes.version="1.0RC7" xmlns="http://www.xes-standard.org/">\n${body}\n</log>\n`;
}
