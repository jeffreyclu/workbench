import { describe, expect, it } from 'vitest';
import type { SharedMessage } from '../../../shared/contracts';
import { buildDecisionTree, formatDecisionTreeEvents } from './decision-tree';

function message(overrides: Partial<SharedMessage>): SharedMessage {
  return {
    id: 'message', conversationId: 'conversation', author: 'jeffrey', body: '', pinned: false,
    status: 'completed', error: '', createdAt: '2026-08-25T12:00:00.000Z', completedAt: null,
    attachments: [], model: null, accountProfile: null, executionProfile: null, inputTokens: null,
    cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null,
    estimatedCostUsd: null, costSource: null,
    fallbackFrom: null, fallbackReason: null, dispatchTarget: 'none', dispatchGroupId: null,
    attempt: 0, maxAttempts: 3, nextAttemptAt: null, queuePriority: 0, retrievedMemoryCount: null,
    ...overrides,
  };
}

describe('buildDecisionTree', () => {
  it('shows a both-agent dispatch as two stream branches with telemetry', () => {
    const tree = buildDecisionTree([
      message({ id: 'request', dispatchTarget: 'both' }),
      message({ id: 'codex', author: 'codex', dispatchGroupId: 'request', status: 'running', model: 'gpt-5.6', executionProfile: 'deep', accountProfile: 'default', retrievedMemoryCount: 3 }),
      message({ id: 'claude', author: 'claude', dispatchGroupId: 'request', status: 'completed', model: 'opus', accountProfile: 'personal', attempt: 1, fallbackFrom: 'codex' }),
    ]);

    expect(tree).toMatchObject([{
      id: 'request', label: 'Requested Codex + Claude', children: [
        { id: 'codex', label: 'Codex', status: 'running', detail: 'gpt-5.6 · deep · default · 3 memory matches' },
        { id: 'claude', label: 'Claude', status: 'completed', detail: 'opus · personal · attempt 2 · fallback from codex' },
      ],
    }]);
  });

  it('attaches recorded decisions and tool calls only to their owning stream in event order', () => {
    const tree = buildDecisionTree([
      message({ id: 'request', dispatchTarget: 'both' }),
      message({ id: 'codex', author: 'codex', dispatchGroupId: 'request' }),
      message({ id: 'claude', author: 'claude', dispatchGroupId: 'request' }),
    ], [
      { id: 'decision', messageId: 'codex', runId: null, kind: 'decision', detail: 'Use the existing route.', createdAt: '2026-08-25T12:00:00.000Z' },
      { id: 'tool', messageId: 'claude', runId: null, kind: 'tool', detail: 'Bash: inspect tests', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'read', messageId: 'codex', runId: null, kind: 'file_read', detail: 'src/routes.ts', createdAt: '2026-08-25T12:00:02.000Z' },
      { id: 'other-conversation', messageId: 'unrelated', runId: null, kind: 'tool', detail: 'Must not appear', createdAt: '2026-08-25T12:00:03.000Z' },
    ]);

    expect(tree[0].children[0].events).toEqual([
      expect.objectContaining({ id: 'decision', kind: 'decision' }),
      expect.objectContaining({ id: 'read', kind: 'file_read' }),
    ]);
    expect(tree[0].children[1].events).toEqual([expect.objectContaining({ id: 'tool', kind: 'tool' })]);
    expect(tree.flatMap((request) => request.children).flatMap((stream) => stream.events))
      .not.toContainEqual(expect.objectContaining({ id: 'other-conversation' }));
  });

  it('turns recorded calls into readable actions and only uses a preceding recorded rationale', () => {
    const events = formatDecisionTreeEvents([
      { id: 'first-tool', messageId: 'codex', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:00.000Z' },
      { id: 'decision', messageId: 'codex', runId: null, kind: 'decision', detail: 'The failure may be in the existing route.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'read', messageId: 'codex', runId: null, kind: 'file_read', detail: 'src/routes.ts', createdAt: '2026-08-25T12:00:02.000Z' },
      { id: 'write', messageId: 'codex', runId: null, kind: 'file_write', detail: 'update: src/routes.ts', createdAt: '2026-08-25T12:00:03.000Z' },
    ]);

    expect(events).toEqual([
      expect.objectContaining({ id: 'first-tool', action: 'Ran the test suite.', rationale: null, decisionId: null }),
      expect.objectContaining({ id: 'decision', action: 'Recorded the approach.', rationale: null, decisionId: null }),
      expect.objectContaining({ id: 'read', action: 'Read src/routes.ts.', rationale: 'The failure may be in the existing route.', decisionId: 'decision' }),
      expect.objectContaining({ id: 'write', action: 'Updated src/routes.ts.', rationale: 'The failure may be in the existing route.', decisionId: 'decision' }),
    ]);
  });

  it('falls back to the latest user dispatch for older stream records', () => {
    const tree = buildDecisionTree([
      message({ id: 'request', dispatchTarget: 'codex' }),
      message({ id: 'reply', author: 'codex', status: 'failed', error: 'Provider unavailable' }),
    ]);

    expect(tree[0].children[0]).toMatchObject({ id: 'reply', status: 'failed' });
    expect(tree[0].children[0].detail).toContain('Provider unavailable');
  });

  it('renders Palmyra as its own inspectable stream', () => {
    const tree = buildDecisionTree([
      message({ id: 'request', dispatchTarget: 'palmyra', body: 'Use Writer.' }),
      message({ id: 'reply', author: 'palmyra', dispatchGroupId: 'request', model: 'palmyra-x6', inputTokens: 20, outputTokens: 8 }),
    ]);

    expect(tree).toMatchObject([{ label: 'Requested Palmyra', children: [{ label: 'Palmyra', detail: 'palmyra-x6' }] }]);
  });
});
