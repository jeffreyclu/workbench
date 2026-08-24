import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LifecycleAnalysis } from './lifecycle-conformance.js';
import { analyzeLifecycle } from './lifecycle-conformance.js';
import { lifecycleCsv, lifecycleExportEvents, lifecycleXes, type LifecycleExportEvent } from './process-mining.js';
import type { WorkbenchDatabase } from './database.js';
import type { LifecycleReportStatus as SharedLifecycleReportStatus } from '../shared/contracts.js';

export const DEFAULT_LIFECYCLE_REPORT_DIRECTORY = 'data/process-mining/latest';
export const DEFAULT_LIFECYCLE_REPORT_MIN_CASES = 50;

export interface LifecycleReportStatus extends Omit<SharedLifecycleReportStatus, 'report'> { report: LifecycleAnalysis | null }

function completedTraces(events: readonly LifecycleExportEvent[]): LifecycleExportEvent[] {
  const traces = new Map<string, LifecycleExportEvent[]>();
  for (const event of events) {
    const trace = traces.get(event.caseId) ?? [];
    trace.push(event);
    traces.set(event.caseId, trace);
  }
  return [...traces.values()]
    .filter((trace) => trace.some((event) => event.isInitial) && trace.some((event) => event.toStatus === 'done'))
    .flat();
}

export function lifecycleReportStatus(
  database: WorkbenchDatabase,
  options: { outputDirectory?: string; minimumCompletedCases?: number; nextRunIntervalMs?: number } = {},
): LifecycleReportStatus {
  const outputDirectory = resolve(options.outputDirectory ?? DEFAULT_LIFECYCLE_REPORT_DIRECTORY);
  const minimumCompletedCases = options.minimumCompletedCases ?? DEFAULT_LIFECYCLE_REPORT_MIN_CASES;
  const events = completedTraces(lifecycleExportEvents(database));
  const reportPath = resolve(outputDirectory, 'conformance.json');
  let report: LifecycleAnalysis | null = null;
  try { if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, 'utf8')) as LifecycleAnalysis; } catch { /* A partial/corrupt prior output never breaks the app. */ }
  return {
    minimumCompletedCases,
    eligibleCompletedCases: new Set(events.map((event) => event.caseId)).size,
    nextRunIntervalMs: options.nextRunIntervalMs ?? 7 * 24 * 60 * 60 * 1_000,
    report,
  };
}

const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function graphSvg(analysis: LifecycleAnalysis): string {
  const edges = analysis.statusTransitionFrequencies.slice(0, 20);
  const labels = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  const positions = new Map(labels.map((label, index) => [label, { x: 90 + (index % 4) * 190, y: 75 + Math.floor(index / 4) * 115 }]));
  const lines = edges.map((edge) => { const from = positions.get(edge.from)!; const to = positions.get(edge.to)!; return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#64748b" stroke-width="${Math.min(8, 1 + Math.log2(edge.count + 1))}" marker-end="url(#arrow)"/><text x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 - 5}" text-anchor="middle" font-size="12">${edge.count}</text>`; }).join('');
  const nodes = labels.map((label) => { const point = positions.get(label)!; return `<circle cx="${point.x}" cy="${point.y}" r="35" fill="#e0f2fe" stroke="#0284c7"/><text x="${point.x}" y="${point.y + 4}" text-anchor="middle" font-size="12">${escape(label)}</text>`; }).join('');
  const height = Math.max(180, 120 + Math.ceil(labels.length / 4) * 115);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="${height}" viewBox="0 0 820 ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#64748b"/></marker></defs>${lines}${nodes}</svg>`;
}

function reportHtml(analysis: LifecycleAnalysis, svg: string): string {
  const deviations = analysis.deviations.slice(0, 100).map((entry) => `<li><code>${escape(entry.caseId)}</code> — ${escape(entry.code)}: ${escape(entry.message)}</li>`).join('') || '<li>No deviations found.</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Workbench lifecycle report</title><style>body{font:16px system-ui;margin:32px;color:#172033}svg{max-width:100%;border:1px solid #cbd5e1;border-radius:8px}code{font-size:.9em}li{margin:.4rem 0}</style></head><body><h1>Workbench lifecycle report</h1><p>Model: <code>${analysis.modelVersion}</code>. ${analysis.caseCount} completed cases, ${analysis.eventCount} events.</p><h2>Discovered status graph</h2>${svg}<h2>Data quality</h2><ul><li>Missing initial event: ${analysis.dataQuality.casesMissingInitial} cases</li><li>Multiple initial events: ${analysis.dataQuality.casesWithMultipleInitials} cases</li><li>Same-timestamp adjacent pairs: ${analysis.dataQuality.sameTimestampPairs}</li><li>Invalid timestamps: ${analysis.dataQuality.invalidTimestampCount}</li></ul><h2>Conformance deviations (${analysis.deviations.length})</h2><ul>${deviations}</ul></body></html>`;
}

function writeAtomically(path: string, contents: string): void {
  const temporaryPath = `${path}.next`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
}

/** Writes a privacy-safe report only when enough fully observed completed traces exist. */
export function generateLifecycleReport(
  database: WorkbenchDatabase,
  options: { outputDirectory?: string; minimumCompletedCases?: number; nextRunIntervalMs?: number } = {},
): LifecycleReportStatus {
  const outputDirectory = resolve(options.outputDirectory ?? DEFAULT_LIFECYCLE_REPORT_DIRECTORY);
  const allEvents = lifecycleExportEvents(database);
  const events = completedTraces(allEvents);
  const minimumCompletedCases = options.minimumCompletedCases ?? DEFAULT_LIFECYCLE_REPORT_MIN_CASES;
  const eligibleCompletedCases = new Set(events.map((event) => event.caseId)).size;
  const nextRunIntervalMs = options.nextRunIntervalMs ?? 7 * 24 * 60 * 60 * 1_000;
  if (eligibleCompletedCases < minimumCompletedCases) return { minimumCompletedCases, eligibleCompletedCases, nextRunIntervalMs, report: null };
  const report = analyzeLifecycle(events);
  mkdirSync(outputDirectory, { recursive: true });
  writeAtomically(resolve(outputDirectory, 'lifecycle.csv'), lifecycleCsv(events));
  writeAtomically(resolve(outputDirectory, 'lifecycle.xes'), lifecycleXes(events));
  writeAtomically(resolve(outputDirectory, 'conformance.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeAtomically(resolve(outputDirectory, 'lifecycle-graph.svg'), graphSvg(report));
  writeAtomically(resolve(outputDirectory, 'report.html'), reportHtml(report, graphSvg(report)));
  return { minimumCompletedCases, eligibleCompletedCases, nextRunIntervalMs, report };
}
