import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../shared/contracts.js';
import { mkdirSync, mkdtempSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { buildAgentRunReviewHandoff, type ObservedRunEvent } from './review-handoff.js';
import { observedEventsFromSessionLog } from './shared-room.js';

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

describe('session turn handoff slices', () => {
  const savedDirectory = process.env.WORKBENCH_AGENT_SESSIONS_DIR;
  let root = '';
  afterEach(() => {
    if (savedDirectory === undefined) delete process.env.WORKBENCH_AGENT_SESSIONS_DIR;
    else process.env.WORKBENCH_AGENT_SESSIONS_DIR = savedDirectory;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('builds a turn\'s handoff from only the session log bytes between its start and end offsets', () => {
    root = mkdtempSync(join(tmpdir(), 'workbench-handoff-slice-'));
    process.env.WORKBENCH_AGENT_SESSIONS_DIR = join(root, 'agent-sessions');
    const key = { conversationId: 'conversation-slice', agent: 'claude' as const };
    const directory = join(root, 'agent-sessions', key.conversationId, key.agent);
    mkdirSync(directory, { recursive: true });
    const eventsPath = join(directory, 'events.jsonl');
    const writeTurn = (turnId: string, path: string) => {
      const start = (() => { try { return statSync(eventsPath).size; } catch { return 0; } })();
      appendFileSync(eventsPath, `${JSON.stringify({ at: 't', source: 'host', turnId, type: 'turn_started' })}\n`);
      appendFileSync(eventsPath, `${JSON.stringify({ at: 't', source: 'provider', turnId, event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: `${turnId}-w`, name: 'Write', input: { file_path: path, content: 'x' } }] } } })}\n`);
      appendFileSync(eventsPath, `${JSON.stringify({ at: 't', source: 'host', turnId, type: 'turn_terminal', status: 'completed' })}\n`);
      return { start, end: statSync(eventsPath).size };
    };
    const first = writeTurn('m1#1', '/repo/earlier-turn.ts');
    const second = writeTurn('m2#1', '/repo/this-turn.ts');
    const third = writeTurn('m3#1', '/repo/later-turn.ts');

    const events = observedEventsFromSessionLog(key, 'claude', second.start, second.end);
    const handoff = buildAgentRunReviewHandoff(run(), 'Done.', events, '2026-08-27T01:00:00.000Z');

    expect(events.map((event) => event.detail)).toEqual(['/repo/this-turn.ts']);
    expect(handoff.changes.map((change) => change.path)).toEqual(['/repo/this-turn.ts']);
    expect(observedEventsFromSessionLog(key, 'claude', first.start, third.end).map((event) => event.detail))
      .toEqual(['/repo/earlier-turn.ts', '/repo/this-turn.ts', '/repo/later-turn.ts']);
  });
});
