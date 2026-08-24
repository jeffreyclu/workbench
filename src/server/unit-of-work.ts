import type { WorkbenchDatabase } from './database.js';

/**
 * The single shared SQLite unit of work for every domain repository.
 * SQLite has no nested BEGIN transaction, so compound operations spanning
 * multiple repositories must share one transaction depth counter rather than
 * each repository opening its own — otherwise an inner repository call would
 * try to BEGIN a second transaction underneath its caller's and fail, or
 * (worse) COMMIT/ROLLBACK a transaction another repository is still using.
 * Every repository that shares a `UnitOfWork` instance composes safely inside
 * one caller's `transaction()` call.
 */
export class UnitOfWork {
  private transactionDepth = 0;

  constructor(readonly database: WorkbenchDatabase) {}

  /** Current nesting depth; 0 means no transaction is open. */
  get depth(): number {
    return this.transactionDepth;
  }

  prepare(sql: string): ReturnType<WorkbenchDatabase['prepare']> {
    return this.database.prepare(sql);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  transaction<T>(operation: () => T): T {
    const outermost = this.transactionDepth === 0;
    if (outermost) this.database.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.transactionDepth -= 1;
      if (outermost) this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (outermost) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
