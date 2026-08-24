/**
 * Cost estimation is keyed by *model*, not by agent. A single rate per agent is
 * wrong by more than an order of magnitude across the tiers Workbench routes to
 * (haiku vs opus, luna vs sol), which made every stored cost meaningless.
 *
 * Resolution order, most authoritative first:
 *   1. provider-reported cost (Claude's `result.total_cost_usd`) — handled by the caller
 *   2. per-model environment override
 *   3. per-agent environment override (kept for existing deployments)
 *   4. the built-in list-price table below
 *
 * The built-in table is a *default*, not a contract with the provider. Rates are
 * published list prices and are labelled `default` so the UI can say so. Override
 * any of them without a code change via the env vars described in `.env.example`.
 */

export type RateSource = 'env' | 'default';

export interface ModelRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: RateSource;
}

/** USD per million tokens. Keys are matched case-insensitively by longest prefix. */
const defaultModelRates: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet': { input: 3, output: 15 },
  'claude-opus': { input: 15, output: 75 },
  'claude-fable': { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
  fable: { input: 3, output: 15 },
  // OpenAI / Codex. Uncached, short-context list prices as of 2026-08-23.
  // Actual bills can differ because cached input, cache writes, and long
  // contexts have separate rates. Insights labels these values as estimates.
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5': { input: 1.25, output: 10 },
};

function envRate(scope: string, direction: 'INPUT' | 'OUTPUT'): number | null {
  const key = `WORKBENCH_${scope}_${direction}_TOKEN_USD_PER_MILLION`;
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** `gpt-5.6-terra` -> `GPT_5_6_TERRA`, so it can be written as a shell variable. */
export function modelEnvScope(model: string): string {
  return `MODEL_${model.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function matchDefaultRate(model: string): { input: number; output: number } | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const exact = defaultModelRates[normalized];
  if (exact) return exact;
  // Providers append dated suffixes (`claude-opus-5-20260401`). Prefer the
  // longest matching key so `claude-haiku-4-5` wins over `haiku`.
  const prefixMatch = Object.keys(defaultModelRates)
    .filter((key) => normalized.startsWith(key) || normalized.includes(key))
    .sort((left, right) => right.length - left.length)[0];
  return prefixMatch ? defaultModelRates[prefixMatch] : null;
}

/** Returns null only when no env override and no default rate covers the model. */
export function resolveModelRate(agent: 'codex' | 'claude', model: string | null): ModelRate | null {
  const scopes = [model ? modelEnvScope(model) : null, agent.toUpperCase()].filter((scope): scope is string => scope !== null);
  for (const scope of scopes) {
    const input = envRate(scope, 'INPUT');
    const output = envRate(scope, 'OUTPUT');
    if (input !== null && output !== null) return { inputUsdPerMillion: input, outputUsdPerMillion: output, source: 'env' };
  }
  const fallback = model ? matchDefaultRate(model) : null;
  if (fallback) return { inputUsdPerMillion: fallback.input, outputUsdPerMillion: fallback.output, source: 'default' };
  return null;
}

export function estimateModelCost(
  agent: 'codex' | 'claude',
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (inputTokens === null && outputTokens === null) return null;
  const rate = resolveModelRate(agent, model);
  if (!rate) return null;
  const cost = ((inputTokens ?? 0) * rate.inputUsdPerMillion + (outputTokens ?? 0) * rate.outputUsdPerMillion) / 1_000_000;
  return Number(cost.toFixed(6));
}
