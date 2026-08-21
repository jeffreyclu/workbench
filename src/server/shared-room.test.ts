import { describe, expect, it } from 'vitest';
import type { SharedMessage } from '../shared/contracts.js';
import { compactConversationHistory } from './shared-room.js';

function message(index: number, body: string): SharedMessage {
  return {
    id: `message-${index}`,
    conversationId: 'conversation',
    author: index % 2 ? 'claude' : 'jeffrey',
    body,
    pinned: false,
    status: 'completed',
    error: '',
    attachments: [],
    dispatchTarget: 'none',
    model: null,
    executionProfile: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    fallbackFrom: null,
    fallbackReason: null,
    attempt: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    completedAt: '2026-08-21T00:00:00.000Z',
    createdAt: `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
  };
}

describe('compactConversationHistory', () => {
  it('keeps the newest turns, compacts older turns, and respects its prompt budget', () => {
    const messages = Array.from({ length: 14 }, (_, index) => message(index, `turn-${index} ${'x'.repeat(2_000)}`));
    const history = compactConversationHistory(messages, 8_000);

    expect(history.length).toBeLessThanOrEqual(8_000);
    expect(history).toContain('Earlier conversation');
    expect(history).toContain('turn-13');
    expect(history).not.toContain(`turn-0 ${'x'.repeat(500)}`);
  });
});
