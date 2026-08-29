import { describe, expect, it } from 'vitest';
import { CACHE_READ_SOFT_LIMIT_TOKENS, type SharedMessage } from '../../../shared/contracts';
import { conversationCacheSpendWarning } from './cache-spend';
import { composerSelectionFromConversation, latestConversationExecutionKind, replyBadge } from './view';

describe('replyBadge', () => {
  it('shows the actual model alongside the compact agent, profile, usage, and duration telemetry', () => {
    expect(replyBadge({
      author: 'codex',
      model: 'gpt-5.6',
      accountProfile: 'default',
      inputTokens: 120,
      outputTokens: 340,
      createdAt: '2026-08-25T12:00:00.000Z',
      completedAt: '2026-08-25T12:00:01.500Z',
      executionProfile: 'standard',
      fallbackFrom: null,
      fallbackReason: null,
      cacheReadInputTokens: null,
    })).toBe('Codex · gpt-5.6 (standard) · default · 120 in · 340 out · 1.5s');
  });

  it('makes missing model and usage data explicit while defaulting a legacy profile', () => {
    expect(replyBadge({
      author: 'claude',
      model: null,
      accountProfile: null,
      inputTokens: null,
      outputTokens: null,
      createdAt: '2026-08-25T12:00:00.000Z',
      completedAt: null,
      executionProfile: null,
      fallbackFrom: null,
      fallbackReason: null,
      cacheReadInputTokens: null,
    })).toBe('Claude · model unavailable · default · counting…');
  });

  it('surfaces prompt-cache reuse and fallback provenance when present', () => {
    expect(replyBadge({
      author: 'codex',
      model: 'gpt-5.6',
      accountProfile: 'default',
      inputTokens: 120,
      outputTokens: 340,
      createdAt: '2026-08-25T12:00:00.000Z',
      completedAt: '2026-08-25T12:00:01.500Z',
      executionProfile: 'economy',
      fallbackFrom: 'claude',
      fallbackReason: 'rate limited',
      cacheReadInputTokens: 5_400,
    })).toBe('Codex · gpt-5.6 (economy) · default · 120 in · 340 out · 5.4K cached · 1.5s · fallback from claude (rate limited)');
  });

  it('surfaces the classified execution type when the reply carries one', () => {
    expect(replyBadge({
      author: 'claude',
      model: 'claude-sonnet-5',
      accountProfile: 'default',
      inputTokens: 120,
      outputTokens: 340,
      createdAt: '2026-08-25T12:00:00.000Z',
      completedAt: '2026-08-25T12:00:01.500Z',
      executionProfile: 'standard',
      fallbackFrom: null,
      fallbackReason: null,
      cacheReadInputTokens: null,
      kind: 'execute',
    })).toBe('Claude · execute · claude-sonnet-5 (standard) · default · 120 in · 340 out · 1.5s');
  });
});

describe('composerSelectionFromConversation', () => {
  it('uses only the conversation record stored by the server', () => {
    expect(composerSelectionFromConversation({
      preferredExecutionProfile: 'deep',
      preferredAccountProfile: 'personal',
      preferredDispatchTarget: 'claude',
    })).toEqual({ executionProfile: 'deep', accountProfile: 'personal', dispatchTarget: 'claude' });
  });

  it('uses stable defaults for a legacy conversation without stored preferences', () => {
    expect(composerSelectionFromConversation({
      preferredExecutionProfile: null,
      preferredAccountProfile: null,
      preferredDispatchTarget: null,
    })).toEqual({ executionProfile: null, accountProfile: 'default', dispatchTarget: 'both' });
  });
});

describe('latestConversationExecutionKind', () => {
  it('surfaces the latest classified agent turn for a manually created conversation', () => {
    expect(latestConversationExecutionKind([
      { author: 'jeffrey', kind: null },
      { author: 'claude', kind: 'research' },
      { author: 'jeffrey', kind: null },
      { author: 'codex', kind: 'execute' },
    ] as SharedMessage[])).toBe('execute');
  });

  it('does not invent an execution type when a manual conversation has no classified reply', () => {
    expect(latestConversationExecutionKind([{ author: 'claude', kind: null }] as SharedMessage[])).toBeNull();
  });
});

describe('conversationCacheSpendWarning', () => {
  it('labels cache traffic as cumulative spend rather than current context', () => {
    const warning = conversationCacheSpendWarning([
      { cacheReadInputTokens: 300_000 },
      { cacheReadInputTokens: 200_000 },
    ] as SharedMessage[]);
    expect(warning).toContain('Cumulative cache spend: 500K cached-input tokens');
    expect(warning).toContain('historical usage, not the current context size');
  });

  it('stays quiet below the soft threshold', () => {
    expect(conversationCacheSpendWarning([
      { cacheReadInputTokens: CACHE_READ_SOFT_LIMIT_TOKENS - 1 },
    ] as SharedMessage[])).toBeNull();
  });
});
