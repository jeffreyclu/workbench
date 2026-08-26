import { describe, expect, it } from 'vitest';
import { canAuthorizeSource, sourceDisconnectProvider } from './state.js';

describe('Grafana source state', () => {
  it('uses Grafana as the managed connection and disconnect provider', () => {
    expect(canAuthorizeSource('grafana')).toBe(true);
    expect(sourceDisconnectProvider('grafana')).toBe('grafana');
  });
});
