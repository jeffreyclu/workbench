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

  it('returns an explicit zero state when no messages are available', () => {
    expect(summarizeCursing([])).toEqual({ total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] });
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
