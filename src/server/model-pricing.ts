/**
 * Token telemetry has been recorded for months while `estimated_cost_usd` and
 * `cost_source` stayed NULL on every row, so every spend figure Workbench
 * could show was zero. This module is the missing meter: it turns the four
 * usage classes the providers report into dollars.
 *
 * Rates are public list prices in USD per million tokens, recorded here as
 * *estimates*. A run priced from this table is stamped `cost_source =
 * 'estimated'`; only a provider-reported dollar amount earns `'provider'`.
 * That distinction is why migration 028 added the column, and it is why this
 * module never guesses at a model it does not recognise -- an unpriced model
 * yields null, which reads as "unknown" rather than "free".
 */
export interface ModelRate {
  /** Fresh (uncached) input tokens. */
  inputPerMTok: number;
  /** Tokens written into the prompt cache. */
  cacheWritePerMTok: number;
  /** Tokens served from the prompt cache. */
  cacheReadPerMTok: number;
  outputPerMTok: number;
}

export interface CostUsage {
  inputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  outputTokens?: number | null;
}

export type CostSource = 'provider' | 'estimated';

/**
 * Keys are matched as substrings of the recorded model string so both the
 * short aliases Workbench stores (`opus`, `sonnet`, `haiku`, `gpt-5.6-terra`)
 * and fully-qualified provider ids (`claude-opus-5`) price against one row.
 *
 * Claude cache rates follow the published multipliers: a 5-minute cache write
 * costs 1.25x input, a cache read 0.1x input.
 *
 * UNVERIFIED (2026-08-28): `gpt-5.6-luna|terra|sol` are internal Codex model
 * aliases with no published price list. All three are priced at GPT-5 class
 * rates rather than inventing a per-tier split, so Codex dollars are an
 * order-of-magnitude figure until real rates are confirmed.
 */
const MODEL_RATES: Array<{ match: string; rate: ModelRate }> = [
  { match: 'opus', rate: { inputPerMTok: 15, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5, outputPerMTok: 75 } },
  { match: 'sonnet', rate: { inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 } },
  { match: 'haiku', rate: { inputPerMTok: 1, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1, outputPerMTok: 5 } },
  { match: 'gpt-5', rate: { inputPerMTok: 1.25, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.125, outputPerMTok: 10 } },
];

export function resolveModelRate(model: string | null | undefined): ModelRate | null {
  if (!model) return null;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  return MODEL_RATES.find((entry) => normalized.includes(entry.match))?.rate ?? null;
}

function billable(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasUsage(usage: CostUsage): boolean {
  return [usage.inputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens, usage.outputTokens]
    .some((value) => typeof value === 'number' && Number.isFinite(value));
}

/**
 * Dollars for a priced model with at least one reported token class, else
 * null. A run with tokens but an unpriced model is deliberately null: an
 * under-count presented as spend is worse than an admitted gap.
 */
export function estimateCostUsd(model: string | null | undefined, usage: CostUsage): number | null {
  const rate = resolveModelRate(model);
  if (!rate || !hasUsage(usage)) return null;
  const dollars = (billable(usage.inputTokens) * rate.inputPerMTok
    + billable(usage.cacheCreationInputTokens) * rate.cacheWritePerMTok
    + billable(usage.cacheReadInputTokens) * rate.cacheReadPerMTok
    + billable(usage.outputTokens) * rate.outputPerMTok) / 1_000_000;
  // Sub-cent precision matters: one cheap turn is worth ~$0.0004, and
  // rounding to cents would floor a whole day of Haiku traffic to zero.
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

/**
 * Resolves the pair actually written to `estimated_cost_usd` / `cost_source`.
 * A provider-reported amount always wins over the table above.
 */
export function resolveCost(
  model: string | null | undefined,
  usage: CostUsage,
  providerCostUsd?: number | null,
): { costUsd: number; costSource: CostSource } | null {
  if (typeof providerCostUsd === 'number' && Number.isFinite(providerCostUsd) && providerCostUsd >= 0) {
    return { costUsd: providerCostUsd, costSource: 'provider' };
  }
  const estimated = estimateCostUsd(model, usage);
  return estimated === null ? null : { costUsd: estimated, costSource: 'estimated' };
}
