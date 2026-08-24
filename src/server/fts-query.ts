/**
 * Turns a raw user query into a safe FTS5 MATCH expression: every
 * whitespace-separated token is individually double-quoted (with internal
 * `"` doubled per SQLite string-escaping rules), which makes FTS5 treat it
 * as a literal string rather than syntax -- so special characters and
 * reserved keywords (`*`, `:`, `AND`, `OR`, `NOT`, unbalanced quotes, ...)
 * can never produce a MATCH syntax error. Quoted tokens are implicitly
 * ANDed by FTS5, i.e. "find rows containing all of these words".
 *
 * Shared by repository.ts (conversations_fts/messages_fts) and
 * memory-index.ts (memory_chunks_fts) so there is exactly one place that
 * decides how a query string becomes a MATCH expression, rather than two
 * modules importing from each other.
 */
export function buildFtsMatchQuery(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}
