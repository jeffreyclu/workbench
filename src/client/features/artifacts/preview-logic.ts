export type ArtifactPreviewKind = 'markdown' | 'image' | 'text' | 'none';

const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);
const TEXT = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'diff', 'patch',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs',
  'sh', 'zsh', 'bash', 'sql', 'css', 'scss', 'graphql',
]);

/** Previews are chosen by the source file's extension; anything unlisted (html, pdf, binaries) opens externally. */
export function artifactPreviewKind(sourcePath: string): ArtifactPreviewKind {
  const name = sourcePath.split(/[\\/]/).pop() ?? '';
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (MARKDOWN.has(extension)) return 'markdown';
  if (IMAGE.has(extension)) return 'image';
  if (TEXT.has(extension)) return 'text';
  return 'none';
}

/** Same-origin read of the artifact's source file; the server enforces the allowed development roots. */
export function artifactContentPath(sourcePath: string, workItemId: string | null): string {
  const query = new URLSearchParams({ path: sourcePath });
  if (workItemId) query.set('workItemId', workItemId);
  return `/api/artifacts/raw?${query.toString()}`;
}

export const PREVIEW_TEXT_LIMIT = 200_000;

export function limitPreviewText(text: string): { text: string; truncated: boolean } {
  return text.length > PREVIEW_TEXT_LIMIT ? { text: text.slice(0, PREVIEW_TEXT_LIMIT), truncated: true } : { text, truncated: false };
}
