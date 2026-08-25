import { describe, expect, it } from 'vitest';
import { parseAgentAccountStatus } from './agent-accounts.js';

describe('parseAgentAccountStatus', () => {
  it('recognizes an authenticated Codex CLI when its status is written to stderr', () => {
    expect(parseAgentAccountStatus('codex', '', 'Logged in using ChatGPT', true)).toMatchObject({
      loggedIn: true,
      detail: 'Logged in using ChatGPT',
    });
  });
});
