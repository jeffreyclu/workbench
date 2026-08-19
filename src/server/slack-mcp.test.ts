import { afterEach, describe, expect, it } from 'vitest';
import { createSlackAuthorizationUrl, slackOAuthConfigured } from './slack-mcp.js';

const original = { clientId: process.env.SLACK_CLIENT_ID, clientSecret: process.env.SLACK_CLIENT_SECRET, redirect: process.env.SLACK_REDIRECT_URI };

afterEach(() => {
  process.env.SLACK_CLIENT_ID = original.clientId;
  process.env.SLACK_CLIENT_SECRET = original.clientSecret;
  process.env.SLACK_REDIRECT_URI = original.redirect;
});

describe('Slack MCP OAuth', () => {
  it('creates a PKCE authorization URL with hosted MCP search scopes', () => {
    process.env.SLACK_CLIENT_ID = 'client-id';
    process.env.SLACK_CLIENT_SECRET = 'client-secret';
    process.env.SLACK_REDIRECT_URI = 'http://localhost:4317/callback';
    const url = new URL(createSlackAuthorizationUrl());
    expect(slackOAuthConfigured()).toBe(true);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2_user/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:4317/callback');
    expect(url.searchParams.get('user_scope')).toContain('search:read.im');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
  });
});
