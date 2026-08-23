import { describe, expect, it, vi } from 'vitest';
import { resolveSourceUrl } from './source-resolver.js';
import { OutboundPolicyError } from './outbound-policy.js';

const settings = { siteUrl: 'https://writer.atlassian.net', email: 'jeffrey@example.com', token: 'secret' };

describe('source URL resolution', () => {
  it('explains why a private Claude artifact cannot be imported as generic metadata', async () => {
    const draft = await resolveSourceUrl('https://claude.ai/code/artifact/f3eb30f1-c5a2-4292-aa0c-30e3b345e666?via=auto_preview');
    expect(draft.source).toBe('Claude');
    expect(draft.title).toContain('f3eb30f1');
    expect(draft.description).toContain('cannot read its authenticated browser frame');
  });

  it('resolves a Confluence page through the configured Atlassian API', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      void input;
      return new Response(JSON.stringify({
        title: 'Connector permissions', space: { name: 'Agent Studio' }, version: { number: 7 },
        body: { storage: { value: '<p>Organizations choose allowed tools.</p><p>Users choose from that set.</p>' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const draft = await resolveSourceUrl('https://writer.atlassian.net/wiki/spaces/AS/pages/12345/Connector+permissions', { confluenceSettings: settings, fetchForPolicy: () => fetchImpl as typeof fetch });
    expect(draft).toMatchObject({ source: 'Confluence', title: 'Connector permissions' });
    expect(draft.description).toContain('Organizations choose allowed tools.');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/wiki/rest/api/content/12345');
  });

  it('returns actionable setup guidance when Confluence is not connected', async () => {
    const draft = await resolveSourceUrl('https://writer.atlassian.net/wiki/spaces/AS/pages/12345/Page');
    expect(draft.description).toContain('Connect Confluence in Workbench Sources');
  });

  it('uses the Workbench GitHub credential to resolve a private issue link', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      void input;
      void init;
      return new Response(JSON.stringify({
      title: 'Fix connector permissions', body: 'Private issue context from GitHub.',
      html_url: 'https://github.com/writer/connectors/issues/42',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const draft = await resolveSourceUrl('https://github.com/writer/connectors/issues/42', {
      githubSettings: { token: 'workbench-github-token' }, fetchForPolicy: () => fetchImpl as typeof fetch,
    });

    expect(draft).toMatchObject({ source: 'GitHub', title: 'Fix connector permissions', description: 'Private issue context from GitHub.' });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer workbench-github-token' }) });
  });

  it('does not hide an outbound policy error behind a generic source draft', async () => {
    await expect(resolveSourceUrl('https://github.com/writer/workbench', {
      fetchForPolicy: () => (async () => { throw new OutboundPolicyError('OUTBOUND_URL_BLOCKED', 'blocked'); }) as typeof fetch,
    })).rejects.toMatchObject({ code: 'OUTBOUND_URL_BLOCKED' });
  });
});
