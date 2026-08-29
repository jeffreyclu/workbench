import { describe, expect, it } from 'vitest';
import { isMcpReauthenticationError, isMcpReauthenticationMessage, mcpAuthenticationMessage } from './remote-mcp.js';

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
});
