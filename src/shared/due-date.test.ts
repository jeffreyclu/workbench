import { describe, expect, it } from 'vitest';
import { dueState, localCalendarDate } from './due-date.js';

describe('calendar due dates', () => {
  it('uses the configured Workbench timezone instead of UTC midnight', () => {
    // This is still August 20 in New York, although it is August 21 in UTC.
    const now = Date.parse('2026-08-21T01:30:00.000Z');
    expect(localCalendarDate(now, 'America/New_York')).toBe('2026-08-20');
    expect(dueState('2026-08-20', now, 'America/New_York')).toBe('due_today');
  });

  it('keeps calendar comparisons stable across the daylight-saving transition', () => {
    const now = Date.parse('2026-03-08T07:30:00.000Z');
    expect(localCalendarDate(now, 'America/New_York')).toBe('2026-03-08');
    expect(dueState('2026-03-07', now, 'America/New_York')).toBe('overdue');
    expect(dueState('2026-03-08', now, 'America/New_York')).toBe('due_today');
    expect(dueState('2026-03-09', now, 'America/New_York')).toBe('due_later');
  });
});
