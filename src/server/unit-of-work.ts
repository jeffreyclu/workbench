import type { WorkbenchDatabase } from './database.js';
import { retryOnSqliteContention } from './sqlite-contention.js';

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

  /**
   * WAL admits one writer at a time, so a concurrent runtime — a promotion
   * running migrations, the scheduler, a streaming agent — can hold the write
   * lock past `busy_timeout` and surface "database is locked" to the caller.
   * Only the outermost transaction may replay: it owns the ROLLBACK, so the
   * retry restarts from a clean database. A nested call must not retry, because
   * its enclosing transaction is already unwinding and replaying the inner
   * operation alone would commit a partial unit of work.
   */
  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return this.runTransaction(operation);
    return retryOnSqliteContention(() => this.runTransaction(operation));
  }

  private runTransaction<T>(operation: () => T): T {
    const outermost = this.transactionDepth === 0;
    if (outermost) this.database.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;

    let result: T;
    try {
      result = operation();
    } catch (error) {
      this.transactionDepth -= 1;
      if (outermost) this.rollback();
      throw error;
    }

    this.transactionDepth -= 1;
    if (!outermost) return result;

    try {
      this.database.exec('COMMIT');
    } catch (error) {
      // A COMMIT rejected for contention leaves the transaction open. It must
      // be rolled back here, or the replay would fail trying to BEGIN a second
      // transaction rather than retrying the write it was meant to retry.
      this.rollback();
      throw error;
    }
    return result;
  }

  /** SQLite may already have unwound the transaction itself, in which case
   * ROLLBACK errors. That error must never mask the failure being handled. */
  private rollback(): void {
    try { this.database.exec('ROLLBACK'); }
    catch { /* No transaction is active; nothing to undo. */ }
  }
}
