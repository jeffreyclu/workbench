import { describe, expect, it } from 'vitest';
import { resolveSlackPermalinkWithCodex, scanSlackWithCodex } from './slack-codex.js';

describe('Codex-hosted Slack integration', () => {
  it('turns a Slack thread into standalone task context', async () => {
    const url = 'https://writer.slack.com/archives/C123/p1234567890123456';
    const draft = await resolveSlackPermalinkWithCodex(url, async () => '<slack-result>{"title":"Fix deploy","description":"Jeffrey asked Sam to fix the deploy. Sam confirmed the rollback.","sourceUrl":"ignored"}</slack-result>');
    expect(draft).toEqual({ source: 'Slack', sourceUrl: url, title: 'Fix deploy', description: 'Jeffrey asked Sam to fix the deploy. Sam confirmed the rollback.' });
  });

  it('rejects connector output that is not machine-readable', async () => {
    await expect(resolveSlackPermalinkWithCodex('https://writer.slack.com/archives/C/p1', async () => 'Slack is unavailable'))
      .rejects.toThrow('Slack connector returned no machine-readable result');
  });

  it('normalizes daily Slack signals', async () => {
    const signals = await scanSlackWithCodex(async () => '<slack-result>{"signals":[{"title":"Review RFC","summary":"Ava requested review","url":"https://writer.slack.com/archives/C/p1","occurredAt":"2026-08-19T12:00:00Z"},{"bad":true}]}</slack-result>');
    expect(signals).toEqual([{ provider: 'slack', title: 'Review RFC', summary: 'Ava requested review', url: 'https://writer.slack.com/archives/C/p1', occurredAt: '2026-08-19T12:00:00Z' }]);
  });
});
