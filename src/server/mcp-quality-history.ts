import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { McpQualityHistory, McpQualityRun } from '../shared/contracts.js';

export type { McpQualityHistory, McpQualityRun } from '../shared/contracts.js';

export function defaultMcpQualityHistoryPath(): string {
  return process.env.MCP_QUALITY_HISTORY_PATH?.trim()
    || join(resolve(new URL('../..', import.meta.url).pathname), 'data', 'mcpjam', 'history.jsonl');
}

function isMcpQualityRun(value: unknown): value is McpQualityRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<McpQualityRun>;
  return typeof run.id === 'string'
    && typeof run.checkedAt === 'string'
    && (run.status === 'passed' || run.status === 'failed')
    && (run.source === 'local' || run.source === 'promotion' || run.source === 'ci')
    && typeof run.durationMs === 'number'
    && typeof run.totalTools === 'number';
}

export function appendMcpQualityRun(run: McpQualityRun, path = defaultMcpQualityHistoryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(run)}\n`, 'utf8');
}

export function readMcpQualityHistory(path = defaultMcpQualityHistoryPath(), limit = 20): McpQualityHistory {
  if (!existsSync(path)) return { status: 'empty', latest: null, runs: [] };
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
  return { status: latest ? latest.status === 'passed' ? 'healthy' : 'degraded' : 'empty', latest, runs };
}
