import { describe, expect, it } from 'vitest';
import { confidenceProminence, confidenceTone, groupDiffBlocks, isChangedBlock } from './diff-confidence.js';
import type { DiffBlockLine } from './diff-confidence.js';

function line(kind: DiffBlockLine['kind'], text: string, index: number): DiffBlockLine {
  return { key: `${index}:${text}`, kind, oldLine: kind === 'deletion' || kind === 'context' ? index : null, newLine: kind === 'addition' || kind === 'context' ? index : null, text };
}

describe('groupDiffBlocks', () => {
  it('groups contiguous change lines into one block and leaves context/header lines standalone', () => {
    const lines: DiffBlockLine[] = [
      line('header', '@@ -1,2 +1,2 @@', 0),
      line('context', ' unchanged', 1),
      line('addition', '+first', 2),
      line('addition', '+second', 3),
      line('deletion', '-old', 4),
      line('context', ' unchanged again', 5),
    ];
    const blocks = groupDiffBlocks(lines);
    expect(blocks).toHaveLength(4);
    expect(blocks[2].lines).toHaveLength(3);
  });

  it('splits separate change hunks into separate blocks', () => {
    const lines: DiffBlockLine[] = [
      line('addition', '+first', 0),
      line('context', ' between', 1),
      line('addition', '+second', 2),
    ];
    const blocks = groupDiffBlocks(lines);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].lines).toHaveLength(1);
    expect(blocks[2].lines).toHaveLength(1);
  });
});

describe('confidenceTone', () => {
  it('renders low confidence as a reddish tone and high confidence as greenish', () => {
    const low = confidenceTone(5);
    const high = confidenceTone(98);
    expect(low).toMatch(/^rgb\(/);
    expect(high).toMatch(/^rgb\(/);
    expect(low).not.toBe(high);
  });
});

describe('confidenceProminence', () => {
  it('makes low-confidence bubbles more opaque and bold than high-confidence ones', () => {
    const low = confidenceProminence(5);
    const high = confidenceProminence(98);
    expect(low.opacity).toBeGreaterThan(high.opacity);
    expect(low.fontWeight).toBeGreaterThan(high.fontWeight);
  });
});

describe('isChangedBlock', () => {
  it('marks blocks that add or remove code and skips context and header blocks', () => {
    const blocks = groupDiffBlocks([line('header', '@@ -1 +1 @@', 0), line('context', ' same', 1), line('addition', '+new', 2)]);
    expect(blocks.map(isChangedBlock)).toEqual([false, false, true]);
  });
});
