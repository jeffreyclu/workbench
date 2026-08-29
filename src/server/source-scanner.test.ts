import { describe, expect, it, vi } from 'vitest';
import { scanSource } from './source-scanner.js';
import type { OutboundPolicyName } from './outbound-policy.js';

function fetchFactory(responseFor: (url: string) => unknown) {
  const policies: OutboundPolicyName[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(responseFor(String(input))), {
    headers: { 'content-type': 'application/json' },
  }));
  return {
    policies,
    fetch,
    factory: (policy: OutboundPolicyName) => {
      policies.push(policy);
      return fetch as typeof globalThis.fetch;
    },
  };
}

describe('source scanners outbound transport', () => {
  it('requires configured roots before scanning a managed Figma connection', () => {
    expect(() => scanSource('figma', { mode: 'managed' })).toThrow('figma source settings are incomplete. Reconnect this source.');
  });

  it('uses the shared policy factory for GitHub, Atlassian, and Gmail API requests', async () => {
    const github = fetchFactory(() => ({ items: [] }));
    await scanSource('github', { token: 'test' }, github.factory);
    expect(github.policies).toEqual(['github-api', 'github-api', 'github-api']);

    const atlassian = fetchFactory(() => ({ results: [] }));
    await scanSource('confluence', { siteUrl: 'https://writer.atlassian.net', email: 'test@example.com', token: 'test' }, atlassian.factory);
    expect(atlassian.policies).toEqual(['atlassian-api']);

    const gmail = fetchFactory(() => ({ messages: [] }));
    await scanSource('gmail', { accessToken: 'test' }, gmail.factory);
    expect(gmail.policies).toEqual(['gmail-api']);
  });
});
