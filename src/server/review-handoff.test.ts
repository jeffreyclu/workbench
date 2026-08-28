import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../shared/contracts.js';
import { buildAgentRunReviewHandoff, type ObservedRunEvent } from './review-handoff.js';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1', workItemId: 'item-1', kind: 'execute', requestedTarget: 'claude', agent: 'claude',
    instructions: 'Fix the flaky login test.', status: 'completed', output: '', error: null,
    createdAt: '2026-08-27T00:00:00.000Z', startedAt: null, completedAt: null, model: null,
    executionProfile: null, inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null,
    outputTokens: null, fallbackFrom: null, fallbackReason: null, conversationId: null, messageId: null,
    attempt: 1, nextAttemptAt: null, resolvedWorkspace: null, origin: 'manual', reviewHandoff: null,
    ...overrides,
  } as AgentRun;
}

describe('buildAgentRunReviewHandoff', () => {
  it('maps observed file writes, decisions, and passing verification into the handoff', () => {
    const events: ObservedRunEvent[] = [
      { category: 'agent_file_write', detail: 'update: src/app.ts' },
      { category: 'agent_tool_use', detail: 'Read the failing test before changing it.', streamKind: 'decision' },
      { category: 'agent_tool_use', detail: 'command: npm test', command: 'npm test', exitCode: 0 },
    ];

    const handoff = buildAgentRunReviewHandoff(run(), 'Fixed the flaky login test.', events, '2026-08-27T01:00:00.000Z');

    expect(handoff.agentRunId).toBe('run-1');
    expect(handoff.formatVersion).toBe(1);
    expect(handoff.summary).toBe('Fixed the flaky login test.');
    expect(handoff.changes).toEqual([{ path: 'src/app.ts', summary: 'Updated during this run.', rationale: 'Observed file-write event from the coding runner.' }]);
    expect(handoff.acceptanceCriteria).toEqual([{ criterion: 'Fix the flaky login test.', files: ['src/app.ts'], decisions: ['Read the failing test before changing it.'] }]);
    expect(handoff.verification).toEqual([{ command: 'npm test', exitCode: 0, result: 'passed' }]);
    expect(handoff.uncertainties).toEqual([]);
    expect(handoff.tradeoffs).toEqual([{ decision: 'Read the failing test before changing it.', rationale: 'Recorded by the agent debugger during this run.' }]);
    expect(handoff.createdAt).toBe('2026-08-27T01:00:00.000Z');
  });

  it('never trusts the model summary as verification proof: a failed command is recorded as failed', () => {
    const events: ObservedRunEvent[] = [{ category: 'agent_tool_use', detail: 'command: npm test', command: 'npm test', exitCode: 1 }];

    const handoff = buildAgentRunReviewHandoff(run(), 'All tests pass now.', events, '2026-08-27T01:00:00.000Z');

    expect(handoff.verification).toEqual([{ command: 'npm test', exitCode: 1, result: 'failed' }]);
    expect(handoff.uncertainties).toEqual([]);
  });

  it('flags an uncertainty when no verification command was observed, regardless of what the agent claims', () => {
    const handoff = buildAgentRunReviewHandoff(run(), 'Ran the full suite and everything is green.', [], '2026-08-27T01:00:00.000Z');

    expect(handoff.verification).toEqual([]);
    expect(handoff.uncertainties).toEqual(['No completed test, build, typecheck, or lint command was observed by the runner.']);
  });

  it('ignores tool-use events that never produced a completed command with an exit code', () => {
    const events: ObservedRunEvent[] = [{ category: 'agent_tool_use', detail: 'command_execution: npm test', command: 'npm test' }];

    const handoff = buildAgentRunReviewHandoff(run(), 'Done.', events, '2026-08-27T01:00:00.000Z');

    expect(handoff.verification).toEqual([]);
    expect(handoff.uncertainties).toHaveLength(1);
  });

  it('de-duplicates repeated file writes and decisions', () => {
    const events: ObservedRunEvent[] = [
      { category: 'agent_file_write', detail: 'update: src/app.ts' },
      { category: 'agent_file_write', detail: 'update: src/app.ts' },
      { category: 'agent_tool_use', detail: 'Same decision twice.', streamKind: 'decision' },
      { category: 'agent_tool_use', detail: 'Same decision twice.', streamKind: 'decision' },
    ];

    const handoff = buildAgentRunReviewHandoff(run(), 'Done.', events, '2026-08-27T01:00:00.000Z');

    expect(handoff.changes).toHaveLength(1);
    expect(handoff.tradeoffs).toHaveLength(1);
  });

  it('falls back to a generic summary when the output has no leading line', () => {
    const handoff = buildAgentRunReviewHandoff(run({ kind: 'execute' }), '   \n\n', [], '2026-08-27T01:00:00.000Z');
    expect(handoff.summary).toBe('Completed execute run.');
  });

  it('produces no acceptance criteria when the run carried no instructions', () => {
    const handoff = buildAgentRunReviewHandoff(run({ instructions: '   ' }), 'Done.', [], '2026-08-27T01:00:00.000Z');
    expect(handoff.acceptanceCriteria).toEqual([]);
  });
});
