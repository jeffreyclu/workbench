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
});
