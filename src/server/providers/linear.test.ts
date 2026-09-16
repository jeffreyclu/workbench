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

  it('updates an existing issue and returns the normalized saved issue', async () => {
    const issue = {
      id: 'issue-id', identifier: 'CON-226', title: 'Connector types', description: 'One contract.', priority: 3,
      url: 'https://linear.app/writer/issue/CON-226/connector-types', dueDate: null, updatedAt: '2026-09-01T00:00:00.000Z',
      state: { type: 'unstarted', name: 'Backlog' }, project: null, labels: { nodes: [] }, team: { id: 'team-id', name: 'Connectors' },
    };
    const policyFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue } } }), {
      headers: { 'content-type': 'application/json' },
    }));

    await expect(new LinearProvider('linear-token', [], [], policyFetch).updateIssue('CON-226', { description: 'One contract.' }))
      .resolves.toEqual(expect.objectContaining({ sourceIdentifier: 'CON-226', description: 'One contract.' }));
    expect(JSON.parse(String(policyFetch.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({
      variables: { id: 'CON-226', input: { description: 'One contract.' } },
    }));
  });

  it('creates an issue for the viewer in the team current cycle with the requested estimate', async () => {
    const issue = {
      id: 'issue-id', identifier: 'CON-227', title: 'Match the backend schema', description: 'Contract test.', priority: 0,
      url: 'https://linear.app/writer/issue/CON-227/match-the-backend-schema', dueDate: null, updatedAt: '2026-09-16T00:00:00.000Z', estimate: 2,
      state: { type: 'backlog', name: 'Backlog' }, project: null, labels: { nodes: [] }, team: { id: 'team-id', name: 'Connectors' },
      assignee: { id: 'viewer-id', name: 'Jeffrey Lu', email: 'jeffrey.lu@writer.com' }, cycle: { id: 'cycle-id', name: 'Cycle 4', number: 4 },
    };
    const responses = [
      { data: { viewer: { id: 'viewer-id', name: 'Jeffrey Lu', email: 'jeffrey.lu@writer.com' }, teams: { nodes: [{ id: 'team-id', key: 'CON', name: 'Connectors', activeCycle: { id: 'cycle-id', name: 'Cycle 4', number: 4 } }] } } },
      { data: { issues: { nodes: [] } } },
      { data: { issueCreate: { success: true, issue } } },
    ];
    const policyFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), { headers: { 'content-type': 'application/json' } }));

    await expect(new LinearProvider('linear-token', [], [], policyFetch).createIssue({
      teamKey: 'CON', title: issue.title, description: issue.description, estimate: 2,
    })).resolves.toEqual(expect.objectContaining({ sourceIdentifier: 'CON-227', title: issue.title }));

    const createRequest = JSON.parse(String(policyFetch.mock.calls[2]?.[1]?.body));
    expect(createRequest.variables.input).toEqual({
      teamId: 'team-id', title: issue.title, description: issue.description, estimate: 2,
      assigneeId: 'viewer-id', cycleId: 'cycle-id',
    });
  });

  it('returns an exact-title issue instead of creating a duplicate on retry', async () => {
    const issue = {
      id: 'issue-id', identifier: 'CON-227', title: 'Match the backend schema', description: 'Contract test.', priority: 0,
      url: 'https://linear.app/writer/issue/CON-227/match-the-backend-schema', dueDate: null, updatedAt: '2026-09-16T00:00:00.000Z', estimate: 2,
      state: { type: 'backlog', name: 'Backlog' }, project: null, labels: { nodes: [] }, team: { id: 'team-id', name: 'Connectors' },
      assignee: { id: 'viewer-id', name: 'Jeffrey Lu', email: 'jeffrey.lu@writer.com' }, cycle: { id: 'cycle-id', name: 'Cycle 4', number: 4 },
    };
    const responses = [
      { data: { viewer: issue.assignee, teams: { nodes: [{ id: 'team-id', key: 'CON', name: 'Connectors', activeCycle: issue.cycle }] } } },
      { data: { issues: { nodes: [issue] } } },
    ];
    const policyFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), { headers: { 'content-type': 'application/json' } }));

    await expect(new LinearProvider('linear-token', [], [], policyFetch).createIssue({ teamKey: 'CON', title: issue.title, estimate: 2 }))
      .resolves.toEqual(expect.objectContaining({ sourceIdentifier: 'CON-227' }));
    expect(policyFetch).toHaveBeenCalledTimes(2);
  });
});
