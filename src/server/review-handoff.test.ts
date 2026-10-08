import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../shared/contracts.js';
import { buildAgentRunReviewHandoff, type ObservedRunEvent } from './review-handoff.js';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1', workItemId: 'item-1', kind: 'execute', requestedTarget: 'codex', requestedAgent: 'codex', agent: 'codex',
    instructions: 'Fix the flaky login test.', status: 'completed', output: '', error: '', failureKind: null, createdAt: '2026-08-27T00:00:00.000Z',
    startedAt: null, completedAt: null, conversationId: null, messageId: null, model: null, executionProfile: null, accountProfile: 'default',
    inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null, estimatedCostUsd: null, costSource: null, fallbackFrom: null, fallbackReason: null,
    attempt: 0, maxAttempts: 3, nextAttemptAt: null, waitingReason: null, resolvedWorkspace: null, origin: 'manual', promptSize: null, reviewHandoff: null, reviewDispatch: null, reviewLenses: null,
    ...overrides,
  };
}

describe('buildAgentRunReviewHandoff', () => {
  it('maps runner-observed writes, decisions, and completed verification commands', () => {
    const events: ObservedRunEvent[] = [
      { category: 'agent_file_write', detail: 'update: src/app.ts', streamKind: 'file_write' },
      { category: 'agent_tool_use', detail: 'Use the existing session boundary.', streamKind: 'decision' },
      { category: 'agent_tool_use', detail: 'command_execution: pnpm typecheck', command: 'pnpm typecheck', exitCode: 0 },
    ];

    expect(buildAgentRunReviewHandoff(run(), 'Implemented the fix.', events, '2026-08-27T01:00:00.000Z')).toMatchObject({
      summary: 'Implemented the fix.',
      changes: [{ path: 'src/app.ts', summary: 'Changed during this run.' }],
      acceptanceCriteria: [{ criterion: 'Fix the flaky login test.', files: ['src/app.ts'], decisions: ['Use the existing session boundary.'] }],
      verification: [{ command: 'pnpm typecheck', exitCode: 0, result: 'passed' }],
      uncertainties: [],
    });
  });

  it('never promotes a model claim to verification evidence without an observed completed command', () => {
    const handoff = buildAgentRunReviewHandoff(run(), 'Tests and build both passed.', [], '2026-08-27T01:00:00.000Z');

    expect(handoff.verification).toEqual([]);
    expect(handoff.uncertainties).toEqual(['No completed test, build, typecheck, or lint command was observed by the runner.']);
  });

  it('summarizes with the first line that says something, not the section heading', () => {
    const handoff = buildAgentRunReviewHandoff(run(), '## Problem\nVerdict: request changes, 1 blocking.\n\n## Solution\n- Fix it.', [], '2026-08-27T01:00:00.000Z');

    expect(handoff.summary).toBe('Verdict: request changes, 1 blocking.');
  });

  it('builds format 2 with blockers, learnings, and prior art for any run kind', () => {
    const events: ObservedRunEvent[] = [
      { category: 'agent_tool_use', detail: 'git push', streamKind: 'tool', command: 'git push origin main', exitCode: 126 },
      { category: 'agent_tool_use', detail: 'workbench.record_learning', streamKind: 'tool', result: '{"citation":"[workbench-operating-practices.md#12]"}' },
      { category: 'agent_tool_use', detail: 'workbench.record_learning', streamKind: 'tool' },
    ];
    const output = '## Problem\nThe fix is in.\n\n## Context\n- Blockers: push was blocked by the external-action guard.\n- Blockers: none\n- Followed [workbench-operating-practices.md#12] and [parse-dont-pattern-match.md#3].';

    const handoff = buildAgentRunReviewHandoff(run({ kind: 'research' }), output, events, '2026-08-27T01:00:00.000Z');

    expect(handoff.formatVersion).toBe(2);
    expect(handoff.blockers).toEqual(['Blockers: push was blocked by the external-action guard.', 'Refused: git push origin main']);
    expect(handoff.learnings).toEqual(['workbench-operating-practices.md#12']);
    expect(handoff.priorArt).toEqual(['parse-dont-pattern-match.md#3']);
  });

  it('leaves blockers, learnings, and prior art empty when the run shows none', () => {
    const handoff = buildAgentRunReviewHandoff(run(), 'All good.\nVerdict: 1 blocking finding.', [], '2026-08-27T01:00:00.000Z');

    expect(handoff).toMatchObject({ blockers: [], learnings: [], priorArt: [] });
  });
});
