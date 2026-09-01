import { describe, expect, it } from 'vitest';
import { figmaMcpTarget, isMcpReauthenticationError, isMcpReauthenticationMessage, mcpAuthenticationMessage, storedMcpCredentialsFromClaudeKeychain } from './remote-mcp.js';

describe('MCP OAuth errors', () => {
  it('distinguishes expired credentials from ordinary connector failures', () => {
    expect(isMcpReauthenticationError(new Error('refresh_token is invalid'))).toBe(true);
    expect(isMcpReauthenticationError(new Error('invalid_grant'))).toBe(true);
    expect(isMcpReauthenticationError(new Error('The upstream service timed out'))).toBe(false);
    expect(mcpAuthenticationMessage('confluence')).toBe('Atlassian authorization expired. Reconnect this source.');
    expect(mcpAuthenticationMessage('gmail')).toBe('Google Workspace authorization expired. Reconnect this source.');
    expect(mcpAuthenticationMessage('slack')).toBe('Slack authorization expired. Reconnect this source.');
    expect(isMcpReauthenticationMessage(mcpAuthenticationMessage('confluence'))).toBe(true);
    expect(isMcpReauthenticationMessage('Atlassian search is unavailable through the connector.')).toBe(false);
  });

  it('imports the newest matching supported-client credential without exposing unrelated entries', () => {
    const result = storedMcpCredentialsFromClaudeKeychain({
      mcpOAuth: {
        older: { serverUrl: 'https://mcp.figma.com/mcp', accessToken: 'old-token', refreshToken: 'old-refresh', clientId: 'old-client', clientSecret: 'old-secret', expiresAt: Date.now() + 1_000 },
        newest: { serverUrl: 'https://mcp.figma.com/mcp', accessToken: 'new-token', refreshToken: 'new-refresh', clientId: 'new-client', clientSecret: 'new-secret', expiresAt: Date.now() + 10_000 },
        unrelated: { serverUrl: 'https://mcp.atlassian.com/v1/mcp/authv2', accessToken: 'atlassian-token', clientId: 'atlassian-client' },
      },
    }, 'https://mcp.figma.com/mcp');

    expect(result).toMatchObject({
      serverUrl: 'https://mcp.figma.com/mcp',
      credentialSource: 'claude-code',
      tokens: { access_token: 'new-token', refresh_token: 'new-refresh' },
      clientInformation: { client_id: 'new-client', client_secret: 'new-secret' },
    });
    expect(JSON.stringify(result)).not.toContain('atlassian-token');
    expect(storedMcpCredentialsFromClaudeKeychain({}, 'https://mcp.figma.com/mcp')).toBeNull();
  });

  it('parses supported Figma URLs into MCP arguments', () => {
    expect(figmaMcpTarget('https://www.figma.com/design/G69xuyQN9HMmjhKe8c6zbn/WRITER-Agent?node-id=31768-101793')).toEqual({
      fileKey: 'G69xuyQN9HMmjhKe8c6zbn',
      nodeId: '31768:101793',
      url: 'https://www.figma.com/design/G69xuyQN9HMmjhKe8c6zbn/WRITER-Agent?node-id=31768-101793',
      title: 'WRITER Agent',
    });
    expect(figmaMcpTarget('https://evil.example/design/G69xuyQN9HMmjhKe8c6zbn/WRITER-Agent')).toBeNull();
  });
});
