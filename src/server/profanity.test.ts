import { describe, expect, it } from 'vitest';
import { summarizeCursing } from './profanity.js';

describe('summarizeCursing', () => {
  it('counts whole-word profanity, groups variants, and reports message and daily analytics', () => {
    const summary = summarizeCursing([
      { body: 'This is fucking shit. Damn.', createdAt: '2026-08-20T09:00:00.000Z' },
      { body: 'A shitty handoff, but not assassin.', createdAt: '2026-08-20T10:00:00.000Z' },
      { body: 'Hell yeah.', createdAt: '2026-08-21T09:00:00.000Z' },
    ]);

    expect(summary).toEqual({
      total: 5,
      angriestDay: { day: '2026-08-20', count: 4 },
      messagesAnalyzed: 3,
      messagesWithCurses: 3,
      instancesPer100Messages: 5 / 3 * 100,
      byTerm: [
        { term: 'shit', count: 2 },
        { term: 'damn', count: 1 },
        { term: 'fuck', count: 1 },
        { term: 'hell', count: 1 },
      ],
      byDay: [
        { day: '2026-08-20', count: 4 },
        { day: '2026-08-21', count: 1 },
      ],
    });
  });

  it('buckets by the local Workbench calendar day, not raw UTC, so late-night messages do not roll into the next day', () => {
    // 2026-08-20T02:30 UTC is still 2026-08-19 in America/New_York (UTC-4 in August).
    const summary = summarizeCursing([
      { body: 'Fuck this.', createdAt: '2026-08-20T02:30:00.000Z' },
      { body: 'Shit happens.', createdAt: '2026-08-20T12:00:00.000Z' },
    ]);
    expect(summary.byDay).toEqual([
      { day: '2026-08-19', count: 1 },
      { day: '2026-08-20', count: 1 },
    ]);
  });

  it('returns an explicit zero state when no messages are available', () => {
    expect(summarizeCursing([])).toEqual({ total: 0, angriestDay: null, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] });
  });

  it('reports the calendar day with the most curses, regardless of how long ago it was', () => {
    const summary = summarizeCursing([
      { body: 'Fuck this old result.', createdAt: '2026-08-20T11:00:00.000Z' },
      { body: 'Fuck. Shit. Damn.', createdAt: '2026-08-24T12:00:00.000Z' },
      { body: 'This is shit right now.', createdAt: '2026-08-24T13:00:00.000Z' },
    ]);

    expect(summary.total).toBe(5);
    expect(summary.angriestDay).toEqual({ day: '2026-08-24', count: 4 });
  });

  it('uses the disk-backed comprehensive list while preserving whole-word boundaries', () => {
    const summary = summarizeCursing([
      { body: 'What a clusterfuck. Also, bollocks and motherfucker.', createdAt: '2026-08-21T09:00:00.000Z' },
      { body: 'The assassin reviewed the className.', createdAt: '2026-08-21T10:00:00.000Z' },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.messagesWithCurses).toBe(1);
    expect(summary.byTerm).toEqual([
      { term: 'bollocks', count: 1 },
      { term: 'clusterfuck', count: 1 },
      { term: 'motherfucker', count: 1 },
    ]);
  });

  it('counts common missing variants and deliberately masked spellings', () => {
    const summary = summarizeCursing([
      { body: 'ffs, you dickhead — that was a fucking shitshow. What the f***?', createdAt: '2026-08-21T09:00:00.000Z' },
      { body: 'className and assassin are not curses.', createdAt: '2026-08-21T10:00:00.000Z' },
    ]);

    expect(summary.total).toBe(5);
    expect(summary.byTerm).toEqual([
      { term: 'fuck', count: 2 },
      { term: 'dickhead', count: 1 },
      { term: 'ffs', count: 1 },
      { term: 'shit', count: 1 },
    ]);
  });

  it('counts common one-edit typos and leetspeak without matching substitutions', () => {
    const summary = summarizeCursing([
      { body: 'FcUK, fuckign, fukcing, sh1t, and cnut.', createdAt: '2026-08-21T09:00:00.000Z' },
      { body: 'A duck and a dock are not curses.', createdAt: '2026-08-21T10:00:00.000Z' },
    ]);

    expect(summary.total).toBe(5);
    expect(summary.messagesWithCurses).toBe(1);
    expect(summary.byTerm).toEqual([
      { term: 'fuck', count: 3 },
      { term: 'cunt', count: 1 },
      { term: 'shit', count: 1 },
    ]);
  });
});
