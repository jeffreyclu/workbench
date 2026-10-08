import { describe, expect, it } from 'vitest';
import { claimsCompletion } from './final-response-policy.js';
import { buildAgentRunReviewHandoff } from './review-handoff.js';
import type { AgentRun } from '../shared/contracts.js';

describe('claimsCompletion', () => {
  it.each(['Done.', 'The bug is fixed', 'It works now', 'All verified', 'DONE', 'Everything is fixed and verified.'])('detects %s', (text) => {
    expect(claimsCompletion(text)).toBe(true);
  });
  it.each([
    'This is not done', "It doesn't work", 'Not yet verified', 'never fixed', "isn't fixed", 'The work is pending',
    'workaround', 'undone', 'unverified', 'network works? unclear'.replace('works?', 'worksheet'), 'overdone', 'No issues; tests pending',
    'Run `done` to finish', 'nothing',
  ])('ignores %s', (text) => {
    expect(claimsCompletion(text)).toBe(false);
  });
  it('ignores claim words inside code fences', () => {
    expect(claimsCompletion('Output:\n```\nall done\n```\nNothing else.')).toBe(false);
  });
});

describe('handoff unverifiedClaim', () => {
  const run = { id: 'r1', kind: 'execute', instructions: 'x' } as AgentRun;
  it('flags a claim with no observed verification', () => {
    expect(buildAgentRunReviewHandoff(run, 'Done and fixed.', [], 't').unverifiedClaim).toBe(true);
  });
  it('does not flag when a vitest command was observed', () => {
    const events = [{ category: 'agent_tool_use' as const, detail: 'Bash', command: 'npx vitest run a.test.ts', exitCode: 0 }];
    expect(buildAgentRunReviewHandoff(run, 'Done and fixed.', events, 't').unverifiedClaim).toBe(false);
  });
});
