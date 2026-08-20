import { describe, expect, it } from 'vitest';
import { isMcpReauthenticationError } from './remote-mcp.js';

describe('MCP OAuth errors', () => {
  it('distinguishes expired credentials from ordinary connector failures', () => {
    expect(isMcpReauthenticationError(new Error('refresh_token is invalid'))).toBe(true);
    expect(isMcpReauthenticationError(new Error('invalid_grant'))).toBe(true);
    expect(isMcpReauthenticationError(new Error('The upstream service timed out'))).toBe(false);
  });
});
