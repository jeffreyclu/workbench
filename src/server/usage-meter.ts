import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun } from '../shared/contracts.js';
import { resolveModelRate } from './model-pricing.js';
import type { WorkItemRepository } from './repository.js';

/**
 * Sonnet-equivalent tokens: every provider's usage normalized to what one
 * Sonnet input token costs, so Claude and Codex spend can be compared and
 * checked against one weekly ceiling. Weights are the ratio of each token
 * kind's cost to a fresh Sonnet input token, taken from published list
 * prices (see docs/autonomy-strategy.md) since neither provider publishes
 * a token-denominated weekly limit to calibrate against directly.
 */
const SONNET_OUTPUT_RATE_USD_PER_MILLION = 15;

const TOKEN_KIND_WEIGHT = {
  freshInput: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const;

/** Ratio of a model's output rate to Sonnet's, used as the price-based tier multiplier from the strategy doc. */
function tierMultiplier(agent: AgentRun['agent'], model: string | null): number {
  const rate = resolveModelRate(agent, model);
  if (!rate) return 1;
  return rate.outputUsdPerMillion / SONNET_OUTPUT_RATE_USD_PER_MILLION;
}

/**
 * `agent_runs` stores input tokens as a single combined figure (see
 * `agent-runner.ts` `usageFromEvent`), not split into fresh/cache-write/
 * cache-read. Treating the whole figure as fresh input is a deliberate
 * upper bound — real cost is lower because most input is cache reads — so
 * this SET figure over-counts rather than under-counts against the budget.
 */
function setForCombinedTokens(agent: AgentRun['agent'], model: string | null, inputTokens: number, outputTokens: number): number {
  const multiplier = tierMultiplier(agent, model);
  return multiplier * (inputTokens * TOKEN_KIND_WEIGHT.freshInput + outputTokens * TOKEN_KIND_WEIGHT.output);
}

/** Exact SET for one Claude Code transcript usage sample, using the real cache-read/cache-write split. */
function setForTranscriptUsage(model: string | null, usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  const multiplier = tierMultiplier('claude', model);
  return multiplier * (
    (usage.input_tokens ?? 0) * TOKEN_KIND_WEIGHT.freshInput
    + (usage.cache_creation_input_tokens ?? 0) * TOKEN_KIND_WEIGHT.cacheWrite
    + (usage.cache_read_input_tokens ?? 0) * TOKEN_KIND_WEIGHT.cacheRead
    + (usage.output_tokens ?? 0) * TOKEN_KIND_WEIGHT.output
  );
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  setTokens: number;
  runCount: number;
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, setTokens: 0, runCount: 0 };
}

export interface WorkbenchUsageByOrigin {
  manual: UsageTotals;
  autonomous: UsageTotals;
}

export interface ClaudeInteractiveUsage {
  setTokens: number;
  scannedFiles: number;
  /** Files that existed but could not be read/parsed; the scan still returns partial totals. */
  unreadableFiles: number;
}

export interface WeeklyUsageReport {
  weekStart: string;
  weekEnd: string;
  claude: {
    workbench: WorkbenchUsageByOrigin;
    interactive: ClaudeInteractiveUsage;
  };
  codex: {
    workbench: WorkbenchUsageByOrigin;
  };
}

/** Monday 00:00:00.000 UTC of the week containing `now`, matching ISO week semantics. */
export function startOfIsoWeekUtc(now: Date): Date {
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

/**
 * Aggregates this week's `agent_runs` rows into manual/autonomous SET totals
 * per provider. `origin` defaults to `'manual'` for every row Workbench has
 * ever written (see migration `021_agent_run_origin`), which is currently
 * correct: nothing autonomous exists yet.
 */
export function computeWorkbenchUsage(repository: WorkItemRepository, weekStart: Date): Record<AgentRun['agent'], WorkbenchUsageByOrigin> {
  const rows = repository.listAgentRunUsageSince(weekStart.toISOString());
  const totals: Record<AgentRun['agent'], WorkbenchUsageByOrigin> = {
    claude: { manual: emptyTotals(), autonomous: emptyTotals() },
    codex: { manual: emptyTotals(), autonomous: emptyTotals() },
  };
  for (const row of rows) {
    const bucket = totals[row.agent][row.origin];
    const inputTokens = row.inputTokens ?? 0;
    const outputTokens = row.outputTokens ?? 0;
    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.setTokens += setForCombinedTokens(row.agent, row.model, inputTokens, outputTokens);
    bucket.runCount += 1;
  }
  return totals;
}

interface TranscriptUsageLine {
  timestamp?: string;
  message?: { model?: string; usage?: Record<string, number> };
}

/**
 * Reads Claude Code's own transcripts to measure interactive usage Workbench
 * never dispatched — the piece the strategy doc calls out as "usage it
 * didn't originate". Scoped to this machine's `~/.claude/projects/` tree;
 * usage from another machine or claude.ai is invisible here, which under-
 * counts rather than over-counts against the budget (see docs/autonomy-strategy.md Risks).
 */
export function scanClaudeInteractiveUsage(weekStart: Date, weekEnd: Date, root = join(homedir(), '.claude', 'projects')): ClaudeInteractiveUsage {
  let setTokens = 0;
  let scannedFiles = 0;
  let unreadableFiles = 0;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return { setTokens: 0, scannedFiles: 0, unreadableFiles: 0 };
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir);
    let entries: string[];
    try {
      entries = readdirSync(projectPath).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = join(projectPath, entry);
      try {
        // A transcript's mtime only ever moves forward as turns are appended, so a
        // file untouched since before the week began cannot contain any usage from it.
        if (statSync(filePath).mtime < weekStart) continue;
        const contents = readFileSync(filePath, 'utf8');
        scannedFiles += 1;
        for (const line of contents.split('\n')) {
          if (!line.trim()) continue;
          let parsed: TranscriptUsageLine;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const usage = parsed.message?.usage;
          if (!usage || !parsed.timestamp) continue;
          const occurredAt = new Date(parsed.timestamp);
          if (occurredAt < weekStart || occurredAt >= weekEnd) continue;
          setTokens += setForTranscriptUsage(parsed.message?.model ?? null, usage);
        }
      } catch {
        unreadableFiles += 1;
      }
    }
  }

  return { setTokens, scannedFiles, unreadableFiles };
}

export function computeWeeklyUsageReport(repository: WorkItemRepository, now = new Date()): WeeklyUsageReport {
  const weekStart = startOfIsoWeekUtc(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const workbench = computeWorkbenchUsage(repository, weekStart);
  const interactive = scanClaudeInteractiveUsage(weekStart, weekEnd);
  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    claude: { workbench: workbench.claude, interactive },
    codex: { workbench: workbench.codex },
  };
}
