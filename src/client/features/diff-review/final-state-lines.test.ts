import { describe, expect, it } from 'vitest';

import { toFinalStateRows } from './final-state-lines.js';
import type { ReviewDiffLine } from './logic.js';

function line(kind: ReviewDiffLine['kind'], text: string, newLine: number | null): ReviewDiffLine {
  return { key: `${kind}-${text}`, kind, oldLine: null, newLine, text };
}

describe('toFinalStateRows', () => {
  it('keeps context and additions in order and drops the old side', () => {
    const rows = toFinalStateRows([
      line('context', ' function f() {', 1),
      line('deletion', '-  return 1;', null),
      line('addition', '+  return 2;', 2),
      line('context', ' }', 3),
    ]);
    expect(rows.map((row) => row.type === 'line' ? row.line.text : `removed:${row.count}`))
      .toEqual([' function f() {', 'removed:1', '+  return 2;', ' }']);
  });

  it('collapses a contiguous deletion run into a single marker', () => {
    const rows = toFinalStateRows([
      line('deletion', '-a', null),
      line('deletion', '-b', null),
      line('deletion', '-c', null),
      line('context', ' d', 1),
    ]);
    expect(rows).toEqual([
      { type: 'removed', key: 'deletion--a-removed', count: 3 },
      { type: 'line', line: line('context', ' d', 1) },
    ]);
  });

  it('still reports a block that only deletes', () => {
    const rows = toFinalStateRows([line('deletion', '-gone', null), line('deletion', '-also', null)]);
    expect(rows).toEqual([{ type: 'removed', key: 'deletion--gone-removed', count: 2 }]);
  });

  it('returns nothing for an empty block', () => {
    expect(toFinalStateRows([])).toEqual([]);
  });

  it('names the enclosing construct when the block only shows its inside', () => {
    const rows = toFinalStateRows([
      line('context', '   const next = read();', 40),
      line('addition', '+  if (!next) return null;', 41),
    ], 'export function routeReviewBlock(block: Block) {');
    expect(rows[0]).toEqual({
      type: 'anchor',
      key: 'context-   const next = read();-anchor',
      text: 'export function routeReviewBlock(block: Block) {',
    });
    expect(rows).toHaveLength(3);
  });

  it('does not repeat a construct the block already opens with', () => {
    const rows = toFinalStateRows([
      line('addition', '+export function routeReviewBlock(block: Block) {', 12),
      line('addition', '+  return tier;', 13),
    ], 'export function routeReviewBlock(bloc');
    expect(rows.some((row) => row.type === 'anchor')).toBe(false);
  });

  it('anchors a block that only deletes, since the marker alone says nothing', () => {
    const rows = toFinalStateRows([line('deletion', '-  legacy();', null)], 'function boot() {');
    expect(rows).toEqual([
      { type: 'anchor', key: 'deletion--  legacy();-removed-anchor', text: 'function boot() {' },
      { type: 'removed', key: 'deletion--  legacy();-removed', count: 1 },
    ]);
  });

  it('adds nothing when git named no construct', () => {
    const lines = [line('addition', '+import x from "y";', 1)];
    expect(toFinalStateRows(lines, null)).toEqual(toFinalStateRows(lines));
  });
});
