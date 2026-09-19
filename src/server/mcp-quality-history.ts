import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpQualityDetails, McpQualityHistory, McpQualityRun } from '../shared/contracts.js';

export type { McpQualityHistory, McpQualityRun } from '../shared/contracts.js';

export function defaultMcpQualityHistoryPath(): string {
  return process.env.MCP_QUALITY_HISTORY_PATH?.trim()
    || join(process.cwd(), 'data', 'mcpjam', 'history.jsonl');
}

function isMcpQualityRun(value: unknown): value is McpQualityRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<McpQualityRun>;
  return typeof run.id === 'string'
    && typeof run.checkedAt === 'string'
    && (run.status === 'passed' || run.status === 'failed')
    && (run.source === 'local' || run.source === 'promotion' || run.source === 'scheduled' || run.source === 'ci')
    && typeof run.durationMs === 'number'
    && typeof run.totalTools === 'number';
}

export function appendMcpQualityRun(run: McpQualityRun, path = defaultMcpQualityHistoryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(run)}\n`, 'utf8');
}

export function readMcpQualityHistory(path = defaultMcpQualityHistoryPath(), limit = 20): McpQualityHistory {
  const emptyDetails: McpQualityDetails = { hosts: [], tools: [], checks: [] };
  const automation = { enabled: false, running: false, cadenceHours: 24, nextRunAt: null, lastError: null };
  if (!existsSync(path)) return { status: 'empty', latest: null, runs: [], automation, details: emptyDetails };
  const runs = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isMcpQualityRun(parsed) ? [parsed] : [];
      } catch { return []; }
    })
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt))
    .slice(0, Math.max(1, limit));
  const latest = runs[0] ?? null;
  return {
    status: latest ? latest.status === 'passed' ? 'healthy' : 'degraded' : 'empty',
    latest,
    runs,
    automation,
    details: latest ? readMcpQualityDetails(latest.source) : emptyDetails,
  };
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function artifactDirectory(source: McpQualityRun['source']): string {
  const folder = source === 'promotion' ? 'promotion-latest' : source === 'scheduled' ? 'scheduled-latest' : 'local-latest';
  return join(process.cwd(), 'data', 'mcpjam', folder);
}

export function readMcpQualityDetails(source: McpQualityRun['source']): McpQualityDetails {
  const directory = artifactDirectory(source);
  const compatibility = readJson(join(directory, 'host-compatibility.json'));
  const matrix = readJson(join(directory, 'tool-matrix-summary.json'));
  const conformance = readJson(join(directory, 'protocol-conformance.json'));
  const rawHosts = Array.isArray(compatibility?.hosts) ? compatibility.hosts : [];
  const rawTools = Array.isArray(matrix?.tools) ? matrix.tools : [];
  const groups = Array.isArray(conformance?.groups) ? conformance.groups : [];
  const rawChecks = groups.flatMap((group) => group && typeof group === 'object' && 'cases' in group && Array.isArray(group.cases) ? group.cases : []);
  return {
    hosts: rawHosts.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const host = value as Record<string, unknown>;
      const verdict = host.verdict;
      if (typeof host.hostId !== 'string' || typeof host.hostLabel !== 'string' || !['works', 'degraded', 'blocked', 'unknown'].includes(String(verdict))) return [];
      return [{ id: host.hostId, label: host.hostLabel, verdict: verdict as McpQualityDetails['hosts'][number]['verdict'], provenance: typeof host.provenance === 'string' ? host.provenance : 'unknown' }];
    }),
    tools: rawTools.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const tool = value as Record<string, unknown>;
      if (typeof tool.name !== 'string' || (tool.expected !== 'success' && tool.expected !== 'error') || typeof tool.passed !== 'boolean' || typeof tool.durationMs !== 'number') return [];
      return [{ name: tool.name, expected: tool.expected, passed: tool.passed, durationMs: tool.durationMs }];
    }),
    checks: rawChecks.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const check = value as Record<string, unknown>;
      if (typeof check.id !== 'string' || typeof check.title !== 'string') return [];
      const status = ['passed', 'failed', 'skipped', 'pending'].includes(String(check.status)) ? check.status as McpQualityDetails['checks'][number]['status'] : 'unknown';
      return [{ id: check.id, title: check.title, category: typeof check.category === 'string' ? check.category : 'other', status }];
    }),
  };
}
