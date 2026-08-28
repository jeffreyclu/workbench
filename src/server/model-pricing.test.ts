import { describe, expect, it } from 'vitest';

import { estimateCostUsd, resolveCost, resolveModelRate } from './model-pricing.js';

describe('model pricing', () => {
  it('prices each usage class separately instead of treating all input alike', () => {
    // Cache reads are the dominant traffic class in resumed runs; charging
    // them at fresh-input rates would overstate spend by ~10x.
    const cost = estimateCostUsd('sonnet', { inputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3 + 3.75 + 0.3 + 15, 6);
  });

  it('matches both the stored short alias and a fully qualified provider id', () => {
    expect(resolveModelRate('opus')).toEqual(resolveModelRate('claude-opus-5'));
    expect(resolveModelRate('gpt-5.6-terra')).toEqual(resolveModelRate('gpt-5.6-sol'));
  });

  it('returns null for a model with no known rate rather than reporting it as free', () => {
    expect(estimateCostUsd('some-unreleased-model', { inputTokens: 10_000, outputTokens: 10_000 })).toBeNull();
    expect(estimateCostUsd(null, { inputTokens: 10_000 })).toBeNull();
  });

  it('returns null when no token class was reported at all', () => {
    expect(estimateCostUsd('opus', { inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null })).toBeNull();
  });

  it('keeps sub-cent precision so cheap traffic does not floor to zero', () => {
    expect(estimateCostUsd('haiku', { inputTokens: 400, outputTokens: 100 })).toBeGreaterThan(0);
  });

  it('prefers a provider-reported amount and labels its provenance', () => {
    expect(resolveCost('opus', { inputTokens: 1_000_000 }, 4.2)).toEqual({ costUsd: 4.2, costSource: 'provider' });
    expect(resolveCost('opus', { inputTokens: 1_000_000 }, null)).toEqual({ costUsd: 15, costSource: 'estimated' });
    // A provider-reported zero is a real billed amount (a fully cached turn
    // on a subscription), not a missing value.
    expect(resolveCost('opus', { inputTokens: 1_000_000 }, 0)).toEqual({ costUsd: 0, costSource: 'provider' });
  });

  it('is null when nothing can be priced, so callers write NULL instead of 0', () => {
    expect(resolveCost('mystery', { inputTokens: 5_000 })).toBeNull();
  });
});
