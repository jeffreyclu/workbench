import type { GitHubPullRequestFile } from '../../../shared/contracts.js';

export interface DiffLine {
  key: string;
  kind: 'context' | 'addition' | 'deletion' | 'header';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

function hunkStart(header: string, side: 'old' | 'new') {
  const match = header.match(side === 'old' ? /^@@ -(\d+)/ : / \+(\d+)/);
  return match ? Number(match[1]) : null;
}

export function parsePatch(patch: string): DiffLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return patch.split('\n').map((text, index) => {
    if (text.startsWith('@@')) {
      oldLine = hunkStart(text, 'old');
      newLine = hunkStart(text, 'new');
      return { key: `${index}:${text}`, kind: 'header' as const, oldLine: null, newLine: null, text };
    }
    if (text.startsWith('+')) {
      const line = { key: `${index}:${text}`, kind: 'addition' as const, oldLine: null, newLine, text };
      if (newLine !== null) newLine += 1;
      return line;
    }
    if (text.startsWith('-')) {
      const line = { key: `${index}:${text}`, kind: 'deletion' as const, oldLine, newLine: null, text };
      if (oldLine !== null) oldLine += 1;
      return line;
    }
    const line = { key: `${index}:${text}`, kind: 'context' as const, oldLine, newLine, text };
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
    return line;
  });
}

export function pullRequestUrl(urls: string[]): string | null {
  return urls.find((url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:\/files)?\/?(?:[?#].*)?$/i.test(url)) ?? null;
}

export function fileLabel(file: Pick<GitHubPullRequestFile, 'path' | 'previousPath' | 'status'>) {
  return file.status === 'renamed' && file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
}
