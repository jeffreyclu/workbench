import { describe, expect, it } from 'vitest';
import { parseCodexRateLimit } from './codex-rate-limits.js';

describe('parseCodexRateLimit', () => {
  it('reads the primary Codex account window without fabricating a token ceiling', () => {
    expect(parseCodexRateLimit({ rateLimits: { planType: 'prolite', primary: { usedPercent: 5, resetsAt: 1_788_096_351, windowDurationMins: 10_080 } } })).toEqual({
      usedPercent: 5, resetsAt: '2026-08-30T13:25:51.000Z', windowDurationMins: 10_080, planType: 'prolite',
    });
  });

  it('rejects incomplete app-server payloads', () => {
    expect(parseCodexRateLimit({ rateLimits: { primary: {} } })).toBeNull();
  });
});
