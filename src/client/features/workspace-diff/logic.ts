import type { WorkspaceDiff, WorkspaceDiffFile, WorkspaceDiffSnapshot } from '../../../shared/contracts.js';

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

export function fileLabel(file: Pick<WorkspaceDiff['files'][number], 'path' | 'previousPath' | 'status'>) {
  return file.status === 'renamed' && file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
}

/**
 * Snapshot records are cumulative workspace patches. A comparison keeps only
 * files whose recorded patch changed between the chosen points in time, so the
 * review surface answers "what changed since this earlier run?" without
 * mutating either immutable record.
 */
export function compareWorkspaceDiffSnapshots(before: WorkspaceDiffSnapshot, after: WorkspaceDiffSnapshot): WorkspaceDiff {
  const beforeByPath = new Map(before.diff.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.diff.files.map((file) => [file.path, file]));
  const changed: WorkspaceDiffFile[] = [];

  for (const [path, file] of afterByPath) {
    const previous = beforeByPath.get(path);
    if (!previous || previous.patch !== file.patch || previous.status !== file.status || previous.previousPath !== file.previousPath) changed.push(file);
  }
  for (const [path, file] of beforeByPath) {
    if (!afterByPath.has(path)) changed.push({ ...file, status: 'removed', additions: 0, deletions: file.additions + file.deletions });
  }

  const totals = changed.reduce((counts, file) => ({ additions: counts.additions + file.additions, deletions: counts.deletions + file.deletions }), { additions: 0, deletions: 0 });
  return {
    ...after.diff,
    revision: `snapshot:${before.id}..${after.id}`,
    files: changed,
    changedFiles: changed.length,
    ...totals,
    publish: { ...after.diff.publish, hasChanges: false, ahead: 0, reason: null },
  };
}
