import { describe, expect, it } from 'vitest';
import { highlightHtml, languageFromPath, resolveLanguage } from './syntax-highlight';

describe('resolveLanguage', () => {
  it('maps fence tags and extensions that diverge from Prism ids', () => {
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('sh')).toBe('bash');
    expect(resolveLanguage('html')).toBe('markup');
    expect(resolveLanguage('TSX')).toBe('tsx');
  });

  it('passes through ids that already match a Prism grammar', () => {
    expect(resolveLanguage('python')).toBe('python');
  });

  it('returns null for missing or unknown languages', () => {
    expect(resolveLanguage(null)).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
    expect(resolveLanguage('not-a-real-language')).toBeNull();
  });
});

describe('languageFromPath', () => {
  it('resolves a language from a file extension', () => {
    expect(languageFromPath('src/client/App.tsx')).toBe('tsx');
    expect(languageFromPath('scripts/backup.sh')).toBe('bash');
  });

  it('returns null when the path has no recognizable extension', () => {
    expect(languageFromPath('Dockerfile')).toBeNull();
    expect(languageFromPath('README')).toBeNull();
  });
});

describe('highlightHtml', () => {
  it('wraps recognized tokens in Prism token spans', () => {
    const html = highlightHtml('const x = 1;', 'javascript');
    expect(html).toContain('token');
    expect(html).toContain('keyword');
  });

  it('HTML-escapes source when no language is available', () => {
    expect(highlightHtml('<script>alert(1)</script>', null)).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('HTML-escapes source for an unresolvable language', () => {
    expect(highlightHtml('<b>&</b>', 'not-a-real-language')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});
