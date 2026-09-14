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
    expect(github.policies).toEqual(Array(12).fill('github-api'));

    const atlassian = fetchFactory(() => ({ results: [] }));
    await scanSource('confluence', { siteUrl: 'https://writer.atlassian.net', email: 'test@example.com', token: 'test' }, atlassian.factory);
    expect(atlassian.policies).toEqual(['atlassian-api']);

    const gmail = fetchFactory(() => ({ messages: [] }));
    await scanSource('gmail', { accessToken: 'test' }, gmail.factory);
    expect(gmail.policies).toEqual(['gmail-api']);
  });

  it('discovers current GitHub assignments and review requests as active work', async () => {
    const github = fetchFactory((url) => url.includes('assignee%3A%40me') ? { items: [{
      title: 'Fix connector retry handling',
      body: 'Retry the failed connector request.',
      html_url: 'https://github.com/writer/repo/issues/42',
      updated_at: '2026-08-01T00:00:00.000Z',
      repository_url: 'https://api.github.com/repos/writer/repo',
    }] } : { items: [] });

    const signals = await scanSource('github', { token: 'test' }, github.factory);

    expect(signals).toEqual([expect.objectContaining({
      provider: 'github',
      title: 'Fix connector retry handling',
      activeWork: true,
      summary: expect.stringContaining('assigned to you'),
    })]);
    expect(signals[0]?.summary).toContain('Repository: writer/repo');
  });

  it('includes open pull requests involving Jeffrey in GitHub discovery', async () => {
    const github = fetchFactory((url) => url.includes('involves%3A%40me') ? { items: [{
      title: 'Improve Writer Agent connector setup',
      body: null,
      html_url: 'https://github.com/WriterInternal/be.mcp-gateway/pull/1301',
      updated_at: '2026-09-14T00:00:00.000Z',
      repository_url: 'https://api.github.com/repos/WriterInternal/be.mcp-gateway',
    }] } : { items: [] });

    const signals = await scanSource('github', { token: 'test' }, github.factory);

    expect(signals).toEqual([expect.objectContaining({
      title: 'Improve Writer Agent connector setup',
      summary: expect.stringContaining('Open GitHub pull request involving you.'),
    })]);
  });

  it('returns firing Grafana alerts instead of passive dashboards', async () => {
    const grafana = fetchFactory(() => [{
      labels: { rulename: 'Connector error rate', grafana_folder: 'Connectors' },
      annotations: { summary: 'Connector failures crossed the threshold.' },
      generatorURL: 'https://grafana.observability.writer.com/alerting/grafana/example/view',
      startsAt: '2026-09-14T12:00:00.000Z',
      status: { state: 'active', silencedBy: [], inhibitedBy: [] },
    }]);

    const signals = await scanSource('grafana', { token: 'test' }, grafana.factory);

    expect(grafana.policies).toEqual(['grafana-api']);
    expect(signals).toEqual([expect.objectContaining({
      provider: 'grafana',
      title: 'Investigate Grafana alert: Connector error rate',
      activeWork: true,
    })]);
  });
});
