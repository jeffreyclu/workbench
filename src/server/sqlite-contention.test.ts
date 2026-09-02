import { describe, expect, it, vi } from 'vitest';
import { isTransientSqliteContention, retryOnSqliteContention } from './sqlite-contention.js';

const busy = () => Object.assign(new Error('database is locked'), { errcode: 5 });

describe('isTransientSqliteContention', () => {
  it('recognises every binding-specific representation of writer contention', () => {
    expect(isTransientSqliteContention(busy())).toBe(true);
    expect(isTransientSqliteContention({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isTransientSqliteContention(new Error('database is busy'))).toBe(true);
    expect(isTransientSqliteContention(new Error('no such table: work_items'))).toBe(false);
    expect(isTransientSqliteContention(null)).toBe(false);
  });
});

describe('retryOnSqliteContention', () => {
  it('replays a contended write until it succeeds', () => {
    const operation = vi.fn()
      .mockImplementationOnce(() => { throw busy(); })
      .mockImplementationOnce(() => { throw busy(); })
      .mockReturnValue('committed');

    expect(retryOnSqliteContention(operation)).toBe('committed');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('surfaces contention once the retry budget is exhausted rather than stalling', () => {
    const operation = vi.fn(() => { throw busy(); });

    expect(() => retryOnSqliteContention(operation)).toThrow('database is locked');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('never replays a genuine failure', () => {
    const operation = vi.fn(() => { throw new Error('FOREIGN KEY constraint failed'); });

    expect(() => retryOnSqliteContention(operation)).toThrow('FOREIGN KEY constraint failed');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
