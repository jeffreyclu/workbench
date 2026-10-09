import { describe, expect, it } from 'vitest';
import { commandsForMode, fuzzyScore, rankCommands, splitPath, wrapIndex, type PaletteCommand } from './logic';

const command = (id: string, group: PaletteCommand['group'], label: string, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({ id, group, label, run: () => {}, ...extra });

describe('fuzzyScore', () => {
  it('requires every character in order', () => {
    expect(fuzzyScore('fdp', 'src/file-diff-pane.tsx')).not.toBeNull();
    expect(fuzzyScore('pdf', 'file-diff-pane')).toBeNull();
  });

  it('ranks a word-start run above a scattered match', () => {
    expect(fuzzyScore('diff', 'file-diff-pane')!).toBeGreaterThan(fuzzyScore('diff', 'dxixfxf')!);
  });
});

describe('rankCommands', () => {
  const commands = [
    command('a', 'Actions', 'New task'),
    command('b', 'Files', 'src/a/file-diff-pane.tsx'),
    command('c', 'Go to', 'Insights'),
    command('d', 'Tasks', 'Fix tiny error rate', { detail: 'Connectors' }),
  ];

  it('keeps group order and source order for an empty query', () => {
    expect(rankCommands(commands, '').map((entry) => entry.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('filters out non-matches and matches supporting text after the label', () => {
    expect(rankCommands(commands, 'fdp').map((entry) => entry.id)).toEqual(['b']);
    expect(rankCommands(commands, 'connectors').map((entry) => entry.id)).toEqual(['d']);
    expect(rankCommands(commands, 'zzz')).toEqual([]);
  });

  it('puts a label match ahead of a detail-only match', () => {
    const ranked = rankCommands([command('x', 'Tasks', 'Other', { detail: 'insights' }), command('y', 'Go to', 'Insights')], 'insights');
    expect(ranked.map((entry) => entry.id)).toEqual(['y', 'x']);
  });
});

describe('commandsForMode', () => {
  it('leaves actions out of the quick switcher', () => {
    const all = [command('a', 'Actions', 'New task'), command('f', 'Files', 'x.ts'), command('r', 'Review', 'Next file')];
    expect(commandsForMode(all, 'switcher').map((entry) => entry.id)).toEqual(['f']);
    expect(commandsForMode(all, 'commands')).toHaveLength(3);
  });
});

describe('helpers', () => {
  it('splits a path into name and directory', () => {
    expect(splitPath('src/client/app.tsx')).toEqual({ name: 'app.tsx', directory: 'src/client' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', directory: '' });
  });

  it('wraps indexes in both directions and tolerates an empty list', () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(0, 0)).toBe(-1);
  });
});
