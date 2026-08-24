import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeLifecycle, type LifecycleAnalysis } from '../src/server/lifecycle-conformance.js';
import type { LifecycleExportEvent } from '../src/server/process-mining.js';

const inputPath = resolve(process.argv[2] ?? 'process-mining/output/lifecycle.csv');
const outputDirectory = resolve(process.argv[3] ?? 'process-mining/output/report');

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { cell += char; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readEvents(path: string): LifecycleExportEvent[] {
  const [header, ...rows] = parseCsv(readFileSync(path, 'utf8')).filter((row) => row.length > 1);
  const columns = new Map(header.map((name, index) => [name, index]));
  const get = (row: string[], name: string): string => row[columns.get(name) ?? -1] ?? '';
  return rows.map((row) => ({
    caseId: get(row, 'case:concept:name'), activity: get(row, 'concept:name'), timestamp: get(row, 'time:timestamp'), eventId: get(row, 'event:id'),
    fromStatus: (get(row, 'from_status') || null) as LifecycleExportEvent['fromStatus'], toStatus: get(row, 'to_status') as LifecycleExportEvent['toStatus'],
    isInitial: get(row, 'is_initial') === 'true', actor: get(row, 'org:resource'), source: get(row, 'source'), reason: get(row, 'reason') || null,
  }));
}

const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function graphSvg(analysis: LifecycleAnalysis): string {
  const edges = analysis.statusTransitionFrequencies.slice(0, 20);
  const labels = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  const positions = new Map(labels.map((label, index) => [label, { x: 90 + (index % 4) * 190, y: 75 + Math.floor(index / 4) * 115 }]));
  const lines = edges.map((edge) => {
    const from = positions.get(edge.from)!; const to = positions.get(edge.to)!;
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#64748b" stroke-width="${Math.min(8, 1 + Math.log2(edge.count + 1))}" marker-end="url(#arrow)"/><text x="${(from.x + to.x) / 2}" y="${(from.y + to.y) / 2 - 5}" text-anchor="middle" font-size="12">${edge.count}</text>`;
  }).join('');
  const nodes = labels.map((label) => { const point = positions.get(label)!; return `<circle cx="${point.x}" cy="${point.y}" r="35" fill="#e0f2fe" stroke="#0284c7"/><text x="${point.x}" y="${point.y + 4}" text-anchor="middle" font-size="12">${escape(label)}</text>`; }).join('');
  const height = Math.max(180, 120 + Math.ceil(labels.length / 4) * 115);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="${height}" viewBox="0 0 820 ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#64748b"/></marker></defs>${lines}${nodes}</svg>`;
}
function reportHtml(analysis: LifecycleAnalysis, svg: string): string {
  const deviations = analysis.deviations.slice(0, 100).map((entry) => `<li><code>${escape(entry.caseId)}</code> — ${escape(entry.code)}: ${escape(entry.message)}</li>`).join('') || '<li>No deviations found.</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Workbench lifecycle report</title><style>body{font:16px system-ui;margin:32px;color:#172033}svg{max-width:100%;border:1px solid #cbd5e1;border-radius:8px}code{font-size:.9em}li{margin:.4rem 0}</style></head><body><h1>Workbench lifecycle report</h1><p>Model: <code>${analysis.modelVersion}</code>. ${analysis.caseCount} cases, ${analysis.eventCount} events.</p><h2>Discovered status graph</h2>${svg}<h2>Data quality</h2><ul><li>Missing initial event: ${analysis.dataQuality.casesMissingInitial} cases</li><li>Multiple initial events: ${analysis.dataQuality.casesWithMultipleInitials} cases</li><li>Same-timestamp adjacent pairs: ${analysis.dataQuality.sameTimestampPairs}</li><li>Invalid timestamps: ${analysis.dataQuality.invalidTimestampCount}</li></ul><h2>Conformance deviations (${analysis.deviations.length})</h2><ul>${deviations}</ul></body></html>`;
}

const analysis = analyzeLifecycle(readEvents(inputPath));
const svg = graphSvg(analysis);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(resolve(outputDirectory, 'conformance.json'), `${JSON.stringify(analysis, null, 2)}\n`);
writeFileSync(resolve(outputDirectory, 'lifecycle-graph.svg'), svg);
writeFileSync(resolve(outputDirectory, 'report.html'), reportHtml(analysis, svg));
process.stdout.write(`Analyzed ${analysis.eventCount} lifecycle events across ${analysis.caseCount} cases in ${outputDirectory}\n`);
