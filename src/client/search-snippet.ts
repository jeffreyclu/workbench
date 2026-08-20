/** One chunk of a search snippet: either plain text or a matched term to highlight. */
export interface SnippetPart {
  text: string;
  highlighted: boolean;
}

/**
 * Splits an FTS5 snippet() string into plain and highlighted parts.
 * The server wraps matched terms in `[` and `]` (see SharedSearchResult.snippet).
 */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const matcher = /\[([^\]]*)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(snippet))) {
    if (match.index > lastIndex) parts.push({ text: snippet.slice(lastIndex, match.index), highlighted: false });
    parts.push({ text: match[1], highlighted: true });
    lastIndex = matcher.lastIndex;
  }
  if (lastIndex < snippet.length) parts.push({ text: snippet.slice(lastIndex), highlighted: false });
  return parts;
}
