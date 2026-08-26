import Prism from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-diff.js';
import 'prismjs/components/prism-markdown.js';

// Fence tags and file extensions frequently diverge from Prism's language ids
// (`ts` vs `typescript`, `sh` vs `bash`, `html` vs `markup`); this maps both
// sources through one alias table so callers never special-case the source.
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  py: 'python', python: 'python',
  sql: 'sql',
  css: 'css', scss: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
};

/** Resolves a fence tag or file extension to a Prism language id with a grammar available, or null. */
export function resolveLanguage(id: string | null | undefined): string | null {
  if (!id) return null;
  const normalized = id.trim().toLowerCase();
  const language = LANGUAGE_ALIASES[normalized] ?? normalized;
  return Prism.languages[language] ? language : null;
}

/** Resolves a file path's extension to a Prism language id with a grammar available, or null. */
export function languageFromPath(path: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? resolveLanguage(match[1]) : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Prism.highlight HTML-escapes the source before wrapping it in token spans, so the result is safe to render via dangerouslySetInnerHTML. */
export function highlightHtml(code: string, language: string | null): string {
  const grammar = language ? Prism.languages[language] : null;
  if (!grammar || !language) return escapeHtml(code);
  return Prism.highlight(code, grammar, language);
}

/** Shared syntax-highlighted code span, used by diff renderers and chat markdown. */
export function SyntaxHighlight({ code, language, className }: { code: string; language: string | null; className?: string }) {
  const html = highlightHtml(code, language);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
