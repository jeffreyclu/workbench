import { describe, expect, it } from 'vitest';
import { replyBadge } from './view';

describe('replyBadge', () => {
  it('shows the actual model alongside the compact agent, profile, and cost telemetry', () => {
    expect(replyBadge({ author: 'codex', model: 'gpt-5.6', accountProfile: 'default', estimatedCostUsd: 0.001 })).toBe('Codex · gpt-5.6 · default · $0.0010');
  });

  it('makes missing model and profile data explicit', () => {
    expect(replyBadge({ author: 'claude', model: null, accountProfile: null, estimatedCostUsd: null })).toBe('Claude · model unavailable · profile unavailable · cost —');
  });
});
