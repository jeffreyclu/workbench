import { describe, expect, it } from 'vitest';
import { replyBadge } from './view';

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
});
