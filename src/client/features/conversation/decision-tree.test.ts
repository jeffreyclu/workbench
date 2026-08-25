import { describe, expect, it } from 'vitest';
import type { SharedMessage } from '../../../shared/contracts';
import { buildDecisionTree } from './decision-tree';

function message(overrides: Partial<SharedMessage>): SharedMessage {
  return {
    id: 'message', conversationId: 'conversation', author: 'jeffrey', body: '', pinned: false,
    status: 'completed', error: '', createdAt: '2026-08-25T12:00:00.000Z', completedAt: null,
    attachments: [], model: null, accountProfile: null, executionProfile: null, inputTokens: null,
    cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null, estimatedCostUsd: null,
    costSource: null, fallbackFrom: null, fallbackReason: null, dispatchTarget: 'none', dispatchGroupId: null,
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

  it('falls back to the latest user dispatch for older stream records', () => {
    const tree = buildDecisionTree([
      message({ id: 'request', dispatchTarget: 'codex' }),
      message({ id: 'reply', author: 'codex', status: 'failed', error: 'Provider unavailable' }),
    ]);

    expect(tree[0].children[0]).toMatchObject({ id: 'reply', status: 'failed' });
    expect(tree[0].children[0].detail).toContain('Provider unavailable');
  });
});
