/** SQLite's node binding reports writer contention inconsistently across
 * versions. Treat every known representation as the same retryable condition. */
export function isTransientSqliteContention(error: unknown): boolean {
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  return candidate?.errcode === 5
    || candidate?.code === 'SQLITE_BUSY'
    || (typeof candidate?.message === 'string' && /database is (?:locked|busy)/i.test(candidate.message));
}
