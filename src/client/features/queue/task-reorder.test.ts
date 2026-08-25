import { describe, expect, it } from 'vitest';
import type { WorkItem, WorkItemPage } from '../../../shared/contracts';
import { reorderTaskPages, reorderTasks } from './task-reorder';

function item(id: string): WorkItem {
  return { id } as WorkItem;
}

function page(ids: string[]): WorkItemPage {
  return { items: ids.map(item), nextCursor: null, totalCount: ids.length, proposal: null };
}

describe('reorderTaskPages', () => {
  it('projects the final rendered order before a response arrives', () => {
    expect(reorderTasks([item('a'), item('b'), item('c')], { itemId: 'a', afterId: 'c' }).map(({ id }) => id)).toEqual(['b', 'c', 'a']);
  });

  it('moves a task before its new neighbor immediately', () => {
    const pages = reorderTaskPages([page(['a', 'b', 'c'])], { itemId: 'a', beforeId: 'c' });

    expect(pages[0].items.map(({ id }) => id)).toEqual(['b', 'a', 'c']);
  });

  it('moves a task after its new neighbor across loaded page boundaries', () => {
    const pages = reorderTaskPages([page(['a', 'b']), page(['c', 'd'])], { itemId: 'a', afterId: 'c' });

    expect(pages.map((entry) => entry.items.map(({ id }) => id))).toEqual([['b', 'c'], ['a', 'd']]);
  });

  it('leaves the cached pages unchanged when the target is unavailable', () => {
    const original = [page(['a', 'b'])];

    expect(reorderTaskPages(original, { itemId: 'a', beforeId: 'missing' })).toEqual(original);
  });
});
