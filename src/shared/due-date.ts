export type DueState = 'overdue' | 'due_today' | 'due_later' | 'unscheduled';

export const DEFAULT_WORKBENCH_TIMEZONE = 'America/New_York';

export function localCalendarDate(now: number, timeZone = DEFAULT_WORKBENCH_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function dueState(dueDate: string | null, now: number, timeZone = DEFAULT_WORKBENCH_TIMEZONE): DueState {
  if (!dueDate) return 'unscheduled';
  const calendarDate = dueDate.slice(0, 10);
  const today = localCalendarDate(now, timeZone);
  if (calendarDate < today) return 'overdue';
  if (calendarDate === today) return 'due_today';
  return 'due_later';
}

export function dueDaysFromToday(dueDate: string, now: number, timeZone = DEFAULT_WORKBENCH_TIMEZONE): number {
  const today = localCalendarDate(now, timeZone);
  return Math.round((Date.parse(`${dueDate.slice(0, 10)}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000);
}
