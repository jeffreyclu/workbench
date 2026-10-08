import { describe, expect, it } from 'vitest';
import { runStatusLabel } from './view.js';

describe('runStatusLabel', () => {
  it('labels a classified provider refusal instead of showing a generic failed state', () => {
    expect(runStatusLabel({ status: 'failed', failureKind: 'provider_refusal', waitingReason: null, attempt: 0, maxAttempts: 3 }))
      .toBe('provider refused the request');
  });

  it('keeps the ordinary status for a normal failure', () => {
    expect(runStatusLabel({ status: 'failed', failureKind: null, waitingReason: null, attempt: 0, maxAttempts: 3 }))
      .toBe('failed');
  });
});
