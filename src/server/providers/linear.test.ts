import { describe, expect, it, vi } from 'vitest';
import { LinearProvider } from './linear.js';

describe('LinearProvider outbound transport', () => {
  it('uses its injected shared-policy fetch instead of global fetch', async () => {
    const policyFetch = vi.fn(async () => new Response(JSON.stringify({ data: { teams: { nodes: [] } } }), {
      headers: { 'content-type': 'application/json' },
    }));
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);

    await expect(new LinearProvider('linear-token', [], [], policyFetch).fetchTeams()).resolves.toEqual([]);
    expect(policyFetch).toHaveBeenCalledWith('https://api.linear.app/graphql', expect.objectContaining({ method: 'POST' }));
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('backs off and retries on a 429 before returning the retried response', async () => {
    const rateLimited = new Response('rate limited', { status: 429 });
    const ok = new Response(JSON.stringify({ data: { teams: { nodes: [] } } }), {
      headers: { 'content-type': 'application/json' },
    });
    const policyFetch = vi.fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(ok);
    const sleep = vi.fn(async (_ms: number) => {});

    const provider = new LinearProvider('linear-token', [], [], policyFetch, sleep);
    await expect(provider.fetchTeams()).resolves.toEqual([]);

    expect(policyFetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(1_000);
    expect(sleep.mock.calls[1][0]).toBeGreaterThanOrEqual(2_000);
  });

  it('gives up after repeated 429s with a rate-limit-specific error, distinct from auth failures', async () => {
    const rateLimited = new Response('rate limited', { status: 429 });
    const policyFetch = vi.fn().mockResolvedValue(rateLimited);
    const sleep = vi.fn(async (_ms: number) => {});

    const provider = new LinearProvider('linear-token', [], [], policyFetch, sleep);
    await expect(provider.fetchTeams()).rejects.toThrow(/rate limit exceeded/i);

    const unauthorized = new Response(JSON.stringify({}), { status: 401 });
    const authFetch = vi.fn().mockResolvedValue(unauthorized);
    const authProvider = new LinearProvider('linear-token', [], [], authFetch, sleep);
    await expect(authProvider.fetchTeams()).rejects.toThrow(/auth failure/i);
  });
});
