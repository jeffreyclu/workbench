import { describe, expect, it } from 'vitest';
import {
  canAuthorizeSource,
  initialSourceAuthorizationState,
  reduceSourceAuthorization,
  sourceDisconnectProvider,
  usesManagedAuthorization,
} from './state.js';

describe('Grafana source state', () => {
  it('uses Grafana as the managed connection and disconnect provider', () => {
    expect(canAuthorizeSource('grafana')).toBe(true);
    expect(sourceDisconnectProvider('grafana')).toBe('grafana');
  });
});

describe('managed source authorization state', () => {
  it('identifies the providers whose loopback authorization completes asynchronously', () => {
    expect(usesManagedAuthorization('figma')).toBe(true);
    expect(usesManagedAuthorization('atlassian')).toBe(true);
    expect(usesManagedAuthorization('slack')).toBe(false);
    expect(usesManagedAuthorization('grafana')).toBe(false);
  });

  it('moves from awaiting authorization through a check and back to waiting while authorization is pending', () => {
    const awaiting = reduceSourceAuthorization(initialSourceAuthorizationState, {
      type: 'authorization-started',
      authorizationUrl: 'https://example.com/oauth',
    });
    const checking = reduceSourceAuthorization(awaiting, { type: 'check-started' });

    expect(awaiting.status).toBe('awaiting-auth');
    expect(checking.status).toBe('check-auth');
    expect(reduceSourceAuthorization(checking, { type: 'check-finished', authorized: false })).toEqual(awaiting);
  });

  it('finishes in authorized when a check sees the provider connection', () => {
    const awaiting = reduceSourceAuthorization(initialSourceAuthorizationState, {
      type: 'authorization-started',
      authorizationUrl: 'https://example.com/oauth',
    });
    const checking = reduceSourceAuthorization(awaiting, { type: 'check-started' });

    expect(reduceSourceAuthorization(checking, { type: 'check-finished', authorized: true })).toEqual({
      status: 'authorized',
      authorizationUrl: 'https://example.com/oauth',
    });
  });

  it('finishes in failed when a connection check cannot complete', () => {
    const awaiting = reduceSourceAuthorization(initialSourceAuthorizationState, {
      type: 'authorization-started',
      authorizationUrl: 'https://example.com/oauth',
    });
    const checking = reduceSourceAuthorization(awaiting, { type: 'check-started' });

    expect(reduceSourceAuthorization(checking, { type: 'check-failed', error: 'Network unavailable.' })).toEqual({
      status: 'failed',
      authorizationUrl: 'https://example.com/oauth',
      error: 'Network unavailable.',
    });
  });

  it('resets a completed workflow when the server connection is later removed', () => {
    expect(reduceSourceAuthorization({
      status: 'authorized',
      authorizationUrl: 'https://example.com/oauth',
    }, { type: 'reset' })).toEqual(initialSourceAuthorizationState);
  });
});
