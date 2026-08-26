import { describe, expect, it } from 'vitest';
import { confidenceProminence, confidenceTone, groupDiffBlocks, scoreDiffBlockConfidence } from './diff-confidence.js';
import type { DiffBlockLine } from './diff-confidence.js';

function line(kind: DiffBlockLine['kind'], text: string, index: number): DiffBlockLine {
  return { key: `${index}:${text}`, kind, oldLine: kind === 'deletion' || kind === 'context' ? index : null, newLine: kind === 'addition' || kind === 'context' ? index : null, text };
}

describe('scoreDiffBlockConfidence', () => {
  it('scores a small single-line addition highly', () => {
    expect(scoreDiffBlockConfidence([line('addition', '+const x = 1;', 0)])).toBeGreaterThanOrEqual(80);
  });

  it('penalizes large blocks more than small ones', () => {
    const small = scoreDiffBlockConfidence([line('addition', '+a', 0)]);
    const big = scoreDiffBlockConfidence(Array.from({ length: 20 }, (_, index) => line('addition', `+line ${index}`, index)));
    expect(big).toBeLessThan(small);
  });

  it('penalizes mixed addition/deletion blocks relative to pure ones', () => {
    const pure = scoreDiffBlockConfidence([line('addition', '+a', 0), line('addition', '+b', 1)]);
    const mixed = scoreDiffBlockConfidence([line('addition', '+a', 0), line('deletion', '-b', 1)]);
    expect(mixed).toBeLessThan(pure);
  });

  it('penalizes risky keywords like TODO or console.log', () => {
    const clean = scoreDiffBlockConfidence([line('addition', '+doWork();', 0)]);
    const risky = scoreDiffBlockConfidence([line('addition', '+// TODO: fix this', 0)]);
    expect(risky).toBeLessThan(clean);
  });

  it('clamps to the 5-98 range', () => {
    const huge = scoreDiffBlockConfidence(Array.from({ length: 200 }, (_, index) => line(index % 2 ? 'addition' : 'deletion', `+/-TODO ${index}`, index)));
    expect(huge).toBeGreaterThanOrEqual(5);
    expect(huge).toBeLessThanOrEqual(98);
  });
});

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
    expect(blocks[2].confidence).toBeGreaterThan(0);
    expect(blocks[0].confidence).toBe(0);
    expect(blocks[1].confidence).toBe(0);
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
