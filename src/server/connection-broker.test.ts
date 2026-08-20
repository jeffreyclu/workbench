import { describe, expect, it } from 'vitest';
import { sourceQuery } from './connection-broker.js';

describe('sourceQuery', () => {
  it('carries a recent Atlassian URL into a follow-up request', () => {
    const url = 'https://writer.atlassian.net/wiki/spaces/ENG/pages/123/MCP';
    expect(sourceQuery(`summarize the doc for me\n${url}`, 'confluence')).toBe(url);
  });

  it('falls back to text when no provider URL is present', () => {
    expect(sourceQuery('search github for connector gateway', 'github')).toBe('connector gateway');
  });
});
