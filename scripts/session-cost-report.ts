import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Read-only comparison of persistent-session turns against per-run processes.
 * Usage: npx tsx scripts/session-cost-report.ts [path/to/workbench.db]
 * (defaults to DATABASE_PATH, then ./data/workbench.db).
 */

type SessionMode = 'persistent' | 'per_run';

interface RunRow {
  id: string;
  started_at: string | null;
  created_at: string;
  prompt_size_json: string | null;
  input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  output_tokens: number | null;
  first_activity_at: string | null;
}

export interface SessionCostGroup {
  sessionMode: SessionMode;
  turns: number;
  startupTurns: number;
  avgPromptChars: number | null;
  avgEnvelopeChars: number | null;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** cacheRead / (input + cacheCreation + cacheRead); null when no token counts were recorded. */
  cacheReadRatio: number | null;
  avgSecondsToFirstActivity: number | null;
  runsWithActivity: number;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Rows written before sessionMode existed were all per-run processes. */
function promptSizeOf(json: string | null): { totalChars: number | null; envelopeChars: number | null; sessionMode: SessionMode; sessionStartup: boolean } {
  let parsed: Record<string, unknown> = {};
  try { parsed = json ? JSON.parse(json) as Record<string, unknown> : {}; } catch { /* a torn row counts as unmeasured */ }
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    totalChars: number(parsed.totalChars),
    envelopeChars: number(parsed.envelopeChars),
    sessionMode: parsed.sessionMode === 'persistent' ? 'persistent' : 'per_run',
    sessionStartup: parsed.sessionStartup === true,
  };
}

export function buildSessionCostReport(database: DatabaseSync): SessionCostGroup[] {
  // The first tool or usage diagnostic is the first sign the provider did
  // anything; the 'prompt' diagnostic is Workbench's own and does not count.
  const rows = database.prepare(`
    SELECT r.id, r.started_at, r.created_at, r.prompt_size_json,
           r.input_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens, r.output_tokens,
           (SELECT MIN(d.created_at) FROM agent_run_diagnostics d WHERE d.run_id = r.id AND d.kind IN ('tool', 'usage')) AS first_activity_at
    FROM agent_runs r
    WHERE r.prompt_size_json IS NOT NULL
  `).all() as unknown as RunRow[];

  const groups = new Map<SessionMode, RunRow[]>([['persistent', []], ['per_run', []]]);
  for (const row of rows) groups.get(promptSizeOf(row.prompt_size_json).sessionMode)!.push(row);

  return [...groups].map(([sessionMode, runs]) => {
    const sizes = runs.map((run) => promptSizeOf(run.prompt_size_json));
    const sum = (pick: (run: RunRow) => number | null) => runs.reduce((total, run) => total + (pick(run) ?? 0), 0);
    const inputTokens = sum((run) => run.input_tokens);
    const cacheCreationTokens = sum((run) => run.cache_creation_input_tokens);
    const cacheReadTokens = sum((run) => run.cache_read_input_tokens);
    const promptTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
    const secondsToFirstActivity = runs.flatMap((run) => {
      const startedAt = Date.parse(run.started_at ?? run.created_at);
      const activityAt = run.first_activity_at ? Date.parse(run.first_activity_at) : Number.NaN;
      return Number.isFinite(startedAt) && Number.isFinite(activityAt) ? [Math.max(0, activityAt - startedAt) / 1000] : [];
    });
    return {
      sessionMode,
      turns: runs.length,
      startupTurns: sizes.filter((size) => size.sessionStartup).length,
      avgPromptChars: average(sizes.flatMap((size) => size.totalChars === null ? [] : [size.totalChars])),
      avgEnvelopeChars: average(sizes.flatMap((size) => size.envelopeChars === null ? [] : [size.envelopeChars])),
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      outputTokens: sum((run) => run.output_tokens),
      cacheReadRatio: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
      avgSecondsToFirstActivity: average(secondsToFirstActivity),
      runsWithActivity: secondsToFirstActivity.length,
    };
  });
}

const fixed = (value: number | null, digits: number, suffix = '') => value === null ? 'n/a' : `${value.toFixed(digits)}${suffix}`;

export function formatSessionCostReport(groups: SessionCostGroup[]): string {
  const lines = ['Session cost report (agent_runs with a recorded prompt size)'];
  for (const group of groups) {
    lines.push(
      '',
      `${group.sessionMode === 'persistent' ? 'persistent' : 'per_run'}: ${group.turns} turn(s), ${group.startupTurns} that spawned the process`,
      `  avg prompt chars per turn    ${fixed(group.avgPromptChars, 0)}`,
      `  avg envelope chars per turn  ${fixed(group.avgEnvelopeChars, 0)}`,
      `  cache-read ratio             ${fixed(group.cacheReadRatio === null ? null : group.cacheReadRatio * 100, 1, '%')} (${group.cacheReadTokens} read / ${group.inputTokens + group.cacheCreationTokens + group.cacheReadTokens} prompt tokens)`,
      `  output tokens                ${group.outputTokens}`,
      `  start to first activity      ${fixed(group.avgSecondsToFirstActivity, 1, 's')} (over ${group.runsWithActivity} run(s) with diagnostics)`,
    );
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = resolve(process.argv[2] ?? process.env.DATABASE_PATH ?? './data/workbench.db');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    console.log(formatSessionCostReport(buildSessionCostReport(database)));
  } finally {
    database.close();
  }
}
