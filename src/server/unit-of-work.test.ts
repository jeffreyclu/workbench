import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchDatabase } from './database.js';
import { UnitOfWork } from './unit-of-work.js';

const busy = () => Object.assign(new Error('database is locked'), { errcode: 5 });

/** Records the transaction control statements the unit of work issues, so a
 * test can assert the replay begins from a genuinely closed transaction. */
function fakeDatabase(onExec: (sql: string) => void = () => {}) {
  const statements: string[] = [];
  const database = {
    exec: (sql: string) => { statements.push(sql); onExec(sql); },
    prepare: () => { throw new Error('not used'); },
  } as unknown as WorkbenchDatabase;
  return { database, statements };
}

describe('UnitOfWork.transaction', () => {
  it('replays a contended outermost transaction from a rolled-back state', () => {
    const { database, statements } = fakeDatabase();
    const unitOfWork = new UnitOfWork(database);
    const operation = vi.fn()
      .mockImplementationOnce(() => { throw busy(); })
      .mockReturnValue('work-1');

    expect(unitOfWork.transaction(operation)).toBe('work-1');
    expect(statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK', 'BEGIN IMMEDIATE', 'COMMIT']);
    expect(unitOfWork.depth).toBe(0);
  });

  it('rolls back a COMMIT rejected for contention so the replay can begin again', () => {
    let commits = 0;
    const { database, statements } = fakeDatabase((sql) => {
      if (sql === 'COMMIT' && commits++ === 0) throw busy();
    });
    const unitOfWork = new UnitOfWork(database);

    expect(unitOfWork.transaction(() => 'work-2')).toBe('work-2');
    expect(statements).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK', 'BEGIN IMMEDIATE', 'COMMIT']);
    expect(unitOfWork.depth).toBe(0);
  });

  it('replays nested work as one unit and never commits it partially', () => {
    const { database, statements } = fakeDatabase();
    const unitOfWork = new UnitOfWork(database);
    const inner = vi.fn(() => { throw busy(); });

    expect(() => unitOfWork.transaction(() => unitOfWork.transaction(inner))).toThrow('database is locked');
    // The nested call runs no retry loop of its own: the outermost transaction
    // owns the replay, so the inner operation repeats only as part of the whole
    // unit, and an exhausted budget leaves nothing committed.
    expect(inner).toHaveBeenCalledTimes(3);
    expect(statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK', 'BEGIN IMMEDIATE', 'ROLLBACK', 'BEGIN IMMEDIATE', 'ROLLBACK']);
    expect(unitOfWork.depth).toBe(0);
  });

  it('leaves a genuine failure unretried and the transaction closed', () => {
    const { database, statements } = fakeDatabase();
    const unitOfWork = new UnitOfWork(database);
    const operation = vi.fn(() => { throw new Error('FOREIGN KEY constraint failed'); });

    expect(() => unitOfWork.transaction(operation)).toThrow('FOREIGN KEY constraint failed');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});
