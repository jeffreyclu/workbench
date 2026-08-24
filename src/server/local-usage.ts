import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalUsageTotals {
  freshInputTokens: number;
  cacheReadInputTokens: number;
  /** `null` means the provider's local event format does not expose it. */
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  totalTrafficTokens: number;
  samples: number;
  scannedFiles: number;
  error: string | null;
}

function empty(cacheWritesAvailable: boolean): LocalUsageTotals {
  return { freshInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: cacheWritesAvailable ? 0 : null, outputTokens: 0, totalTrafficTokens: 0, samples: 0, scannedFiles: 0, error: null };
}

function jsonlFiles(root: string, files: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) jsonlFiles(path, files);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}

function isInRange(timestamp: unknown, since: Date, until: Date): boolean {
  if (typeof timestamp !== 'string') return false;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) && date >= since && date < until;
}

/** Reads Claude Code transcript usage that is locally available for a time range. */
export function scanClaudeLocalUsage(since: Date, until: Date, projectsRoot: string): LocalUsageTotals {
  const totals = empty(true);
  let files: string[];
  try { files = jsonlFiles(projectsRoot); }
  catch (error) { totals.error = `Unable to read Claude transcripts at ${projectsRoot}: ${error instanceof Error ? error.message : String(error)}`; return totals; }
  for (const file of files) {
    try {
      if (statSync(file).mtime < since) continue;
      totals.scannedFiles += 1;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let record: { timestamp?: unknown; message?: { usage?: Record<string, unknown> } };
        try { record = JSON.parse(line) as typeof record; } catch { continue; }
        if (!isInRange(record.timestamp, since, until)) continue;
        const usage = record.message?.usage;
        if (!usage) continue;
        const number = (key: string) => typeof usage[key] === 'number' ? usage[key] : 0;
        totals.freshInputTokens += number('input_tokens');
        totals.cacheReadInputTokens += number('cache_read_input_tokens');
        totals.cacheWriteInputTokens! += number('cache_creation_input_tokens');
        totals.outputTokens += number('output_tokens');
        totals.samples += 1;
      }
    } catch (error) { totals.error = `Unable to read Claude transcript ${file}: ${error instanceof Error ? error.message : String(error)}`; return totals; }
  }
  totals.totalTrafficTokens = totals.freshInputTokens + totals.cacheReadInputTokens + (totals.cacheWriteInputTokens ?? 0) + totals.outputTokens;
  return totals;
}

/** Codex input includes cache reads, so fresh input is calculated by subtraction. */
export function scanCodexLocalUsage(since: Date, until: Date, sessionsRoot: string): LocalUsageTotals {
  const totals = empty(false);
  let files: string[];
  try { files = jsonlFiles(sessionsRoot); }
  catch (error) { totals.error = `Unable to read Codex sessions at ${sessionsRoot}: ${error instanceof Error ? error.message : String(error)}`; return totals; }
  for (const file of files) {
    try {
      if (statSync(file).mtime < since) continue;
      totals.scannedFiles += 1;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let record: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; info?: { last_token_usage?: Record<string, unknown> } } };
        try { record = JSON.parse(line) as typeof record; } catch { continue; }
        if (record.type !== 'event_msg' || record.payload?.type !== 'token_count' || !isInRange(record.timestamp, since, until)) continue;
        const usage = record.payload.info?.last_token_usage;
        if (!usage) continue;
        const number = (key: string) => typeof usage[key] === 'number' ? usage[key] : 0;
        const input = number('input_tokens');
        const cached = number('cached_input_tokens');
        totals.freshInputTokens += Math.max(0, input - cached);
        totals.cacheReadInputTokens += cached;
        totals.outputTokens += number('output_tokens');
        totals.samples += 1;
      }
    } catch (error) { totals.error = `Unable to read Codex session ${file}: ${error instanceof Error ? error.message : String(error)}`; return totals; }
  }
  totals.totalTrafficTokens = totals.freshInputTokens + totals.cacheReadInputTokens + totals.outputTokens;
  return totals;
}
