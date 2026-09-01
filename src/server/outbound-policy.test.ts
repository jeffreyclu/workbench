import { describe, expect, it } from 'vitest';
import { assertApprovedMcpServer, createOutboundFetch, OutboundPolicyError } from './outbound-policy.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];
const response = (body = 'ok', init?: ResponseInit) => new Response(body, init);

describe('outbound policy', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.1.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1'])('blocks private IPv4 and IPv6 destination %s', async (address) => {
    const fetch = createOutboundFetch('github-api', { resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 } as never], transport: async () => response() });
    await expect(fetch('https://api.github.com/repos/writer/workbench')).rejects.toMatchObject({ code: 'OUTBOUND_URL_BLOCKED' });
  });

  it('blocks numeric URL hosts and rejects a mixed public/private DNS answer set', async () => {
    const numeric = createOutboundFetch('github-api', { transport: async () => response() });
    await expect(numeric('https://2130706433/')).rejects.toMatchObject({ code: 'OUTBOUND_URL_BLOCKED' });
    await expect(numeric('https://%31%32%37.0.0.1/')).rejects.toMatchObject({ code: 'OUTBOUND_URL_BLOCKED' });
    const mixed = createOutboundFetch('github-api', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], transport: async () => response() });
    await expect(mixed('https://api.github.com/')).rejects.toMatchObject({ code: 'OUTBOUND_URL_BLOCKED' });
  });

  it('pins a single validated DNS lookup to the connection dispatcher', async () => {
    let resolves = 0;
    let dispatcher: unknown;
    const fetch = createOutboundFetch('github-api', {
      resolve: async () => { resolves += 1; return publicDns(); },
      transport: async (_url, init) => {
        dispatcher = init?.dispatcher;
        return response();
      },
    });
    await fetch('https://api.github.com/repos/writer/workbench');
    expect(resolves).toBe(1);
    expect(dispatcher).toBeTruthy();
  });

  it('uses exact hostname boundaries and only accepts approved MCP servers', async () => {
    const fetch = createOutboundFetch('source-page', { resolve: publicDns, transport: async () => response() });
    await expect(fetch('https://github.com.evil.test/repo')).rejects.toMatchObject({ code: 'OUTBOUND_URL_BLOCKED' });
    expect(assertApprovedMcpServer('slack', 'https://mcp.slack.com/mcp')).toBeInstanceOf(URL);
    expect(() => assertApprovedMcpServer('slack', 'https://mcp.slack.com.evil.test/mcp')).toThrow(OutboundPolicyError);
    expect(() => assertApprovedMcpServer('gmail', 'https://example.com/mcp')).toThrow('Gmail MCP server overrides are not approved');
    expect(() => assertApprovedMcpServer('slack', 'https://mcp.slack.com/mcp/other')).toThrow(OutboundPolicyError);
  });

  it.each([
    {
      provider: 'figma' as const,
      policy: 'mcp-figma' as const,
      transport: 'https://mcp.figma.com/mcp',
      discovery: ['https://mcp.figma.com/.well-known/oauth-protected-resource/mcp', 'https://api.figma.com/.well-known/oauth-authorization-server'],
    },
    {
      provider: 'slack' as const,
      policy: 'mcp-slack' as const,
      transport: 'https://mcp.slack.com/mcp',
      discovery: ['https://mcp.slack.com/.well-known/oauth-protected-resource/mcp', 'https://mcp-9827.slack.com/.well-known/oauth-protected-resource/mcp'],
    },
    {
      provider: 'confluence' as const,
      policy: 'mcp-atlassian' as const,
      transport: 'https://mcp.atlassian.com/v1/mcp/authv2',
      discovery: ['https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2', 'https://auth.atlassian.com/.well-known/oauth-authorization-server'],
    },
  ])('allows $provider OAuth discovery without accepting discovery URLs as transport endpoints', async ({ provider, policy, transport, discovery }) => {
    const seen: string[] = [];
    const fetch = createOutboundFetch(policy, {
      resolve: publicDns,
      transport: async (input) => { seen.push(String(input)); return response('{}', { headers: { 'content-type': 'application/json' } }); },
    });

    for (const url of discovery) await fetch(url);

    expect(seen).toEqual(discovery);
    expect(assertApprovedMcpServer(provider, transport).href).toBe(transport);
    expect(() => assertApprovedMcpServer(provider, discovery[0])).toThrow(OutboundPolicyError);
    expect(() => assertApprovedMcpServer(provider, `${new URL(transport).origin}/other`)).toThrow(OutboundPolicyError);
  });

  it('validates redirect targets, limits redirect chains, and strips credentials across origins', async () => {
    let call = 0;
    const seenHeaders: Headers[] = [];
    const fetch = createOutboundFetch('mcp-slack', {
      resolve: publicDns,
      transport: async (_url, init) => {
        seenHeaders.push(new Headers(init?.headers));
        call += 1;
        return call === 1 ? response('', { status: 302, headers: { location: 'https://slack.com/oauth/v2/authorize' } }) : response();
      },
    });
    await fetch('https://mcp.slack.com/mcp', { headers: { Authorization: 'Bearer secret', Cookie: 'session=secret' } });
    expect(seenHeaders[1].get('authorization')).toBeNull();
    expect(seenHeaders[1].get('cookie')).toBeNull();

    const privateRedirect = createOutboundFetch('github-api', { resolve: publicDns, transport: async () => response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }) });
    await expect(privateRedirect('https://api.github.com/')).rejects.toMatchObject({ code: 'OUTBOUND_REDIRECT_BLOCKED' });
    const loop = createOutboundFetch('github-api', { resolve: publicDns, transport: async () => response('', { status: 302, headers: { location: '/again' } }) });
    await expect(loop('https://api.github.com/again')).rejects.toMatchObject({ code: 'OUTBOUND_REDIRECT_BLOCKED' });
  });

  it('enforces the response size limit before reading and while streaming', async () => {
    const tooLarge = createOutboundFetch('github-api', { resolve: publicDns, transport: async () => response('', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }) });
    await expect(tooLarge('https://api.github.com/')).rejects.toMatchObject({ code: 'OUTBOUND_RESPONSE_TOO_LARGE' });
    const chunks = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } });
    const streamed = createOutboundFetch('github-api', { resolve: publicDns, transport: async () => new Response(chunks) });
    await expect((await streamed('https://api.github.com/')).arrayBuffer()).rejects.toMatchObject({ code: 'OUTBOUND_RESPONSE_TOO_LARGE' });
  });

  it('writes sanitized audit details', async () => {
    const events: string[] = [];
    const fetch = createOutboundFetch('github-api', { resolve: publicDns, transport: async () => response(), audit: (detail) => events.push(detail) });
    await fetch('https://api.github.com/repos/writer/workbench?access_token=secret#fragment', { headers: { Authorization: 'Bearer secret' } });
    expect(events.join('\n')).not.toMatch(/secret|access_token|fragment|authorization/i);
    expect(events.join('\n')).toContain('https://api.github.com/repos/writer/workbench');
  });
});
