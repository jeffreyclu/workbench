import { describe, expect, it } from 'vitest';
import { CACHE_READ_RATE_MULTIPLIER, CACHE_WRITE_RATE_MULTIPLIER, estimateModelCost, resolveModelRate } from './model-pricing.js';

describe('estimateModelCost', () => {
  it('prices cache writes and cache reads off the input rate', () => {
    // sonnet: $3/M input, $15/M output.
    // 1M input + 1M cache write + 1M cache read + 1M output
    //   = 3 + 3*1.25 + 3*0.1 + 15 = 22.05
    expect(estimateModelCost('claude', 'sonnet', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(22.05, 6);
    expect(CACHE_WRITE_RATE_MULTIPLIER).toBe(1.25);
    expect(CACHE_READ_RATE_MULTIPLIER).toBe(0.1);
  });

  it('matches the pre-fix result when no cache tokens are supplied', () => {
    expect(estimateModelCost('claude', 'sonnet', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    expect(estimateModelCost('claude', 'sonnet', 1_000_000, 1_000_000, 0, 0)).toBeCloseTo(18, 6);
    expect(estimateModelCost('claude', 'sonnet', 1_000_000, 1_000_000, null, null)).toBeCloseTo(18, 6);
  });

  it('costs a cache-dominated run that the pre-fix formula priced as near-free', () => {
    // Run a054abd7: 92 input, 151_025 cache write, 6_216_409 cache read, 36_544 output.
    // The provider reported $2.2165; the pre-fix formula saw only 92 input tokens.
    const preFix = estimateModelCost('claude', 'sonnet', 92, 36_544);
    const postFix = estimateModelCost('claude', 'sonnet', 92, 36_544, 151_025, 6_216_409);
    expect(preFix).toBeCloseTo(0.5484, 4);
    expect(postFix).toBeCloseTo(2.9797, 4);
    expect(postFix! / preFix!).toBeGreaterThan(5);
  });

  it('still returns null when every token count is absent', () => {
    expect(estimateModelCost('claude', 'sonnet', null, null)).toBeNull();
    expect(estimateModelCost('claude', 'sonnet', null, null, null, null)).toBeNull();
    expect(estimateModelCost('claude', 'sonnet', null, null, 0, 0)).toBeNull();
  });

  it('prices cache tokens even when input and output are both null', () => {
    // A run that was served entirely from cache still costs money.
    expect(estimateModelCost('claude', 'sonnet', null, null, 0, 1_000_000)).toBeCloseTo(0.3, 6);
  });

  it('returns null for a model with no env override and no default rate', () => {
    expect(resolveModelRate('claude', 'no-such-model-9000')).toBeNull();
    expect(estimateModelCost('claude', 'no-such-model-9000', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeNull();
  });

  it('applies the cache multipliers to whichever rate the model resolves to', () => {
    // opus: $15/M input. 1M cache read = 15 * 0.1 = 1.5.
    expect(estimateModelCost('claude', 'claude-opus-5-20260401', null, null, 0, 1_000_000)).toBeCloseTo(1.5, 6);
  });
});
