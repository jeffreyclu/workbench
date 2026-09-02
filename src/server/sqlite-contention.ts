/** SQLite's node binding reports writer contention inconsistently across
 * versions. Treat every known representation as the same retryable condition. */
export function isTransientSqliteContention(error: unknown): boolean {
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  return candidate?.errcode === 5
    || candidate?.code === 'SQLITE_BUSY'
    || (typeof candidate?.message === 'string' && /database is (?:locked|busy)/i.test(candidate.message));
}

/** Backoff before each replay, in milliseconds. Two short waits cover the tail
 * of a writer handoff; anything longer is a real lock leak that must surface
 * as an error rather than stall the server behind an unbounded wait. */
const RETRY_BACKOFF_MS = [25, 75];

/** `node:sqlite` is synchronous, so the wait between replays must be too. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Replays a write that lost the WAL writer race after SQLite's own
 * `busy_timeout` was already exhausted. The caller must have rolled its
 * transaction back first: this replays `operation` from a clean database state,
 * so any non-database side effect inside it runs again. Non-contention errors
 * and an exhausted retry budget both propagate unchanged.
 */
export function retryOnSqliteContention<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= RETRY_BACKOFF_MS.length || !isTransientSqliteContention(error)) throw error;
      sleepSync(RETRY_BACKOFF_MS[attempt]);
    }
  }
}
