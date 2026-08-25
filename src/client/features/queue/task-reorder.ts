import type { WorkItem, WorkItemPage } from '../../../shared/contracts';

export interface TaskReorderTarget {
  itemId: string;
  beforeId?: string;
  afterId?: string;
}

/** Moves one visible task without waiting for the server-confirmed queue. */
export function reorderTasks(current: readonly WorkItem[], target: TaskReorderTarget): WorkItem[] {
  const items = [...current];
  const activeIndex = items.findIndex((item) => item.id === target.itemId);
  if (activeIndex < 0) return [...current];

  const [active] = items.splice(activeIndex, 1);
  const adjacentId = target.beforeId ?? target.afterId;
  const adjacentIndex = adjacentId ? items.findIndex((item) => item.id === adjacentId) : -1;
  if (adjacentIndex < 0) return [...current];

  const insertionIndex = target.beforeId ? adjacentIndex : adjacentIndex + 1;
  items.splice(insertionIndex, 0, active);
  return items;
}

/** Preserves loaded page boundaries while applying the same optimistic move. */
export function reorderTaskPages(pages: readonly WorkItemPage[], target: TaskReorderTarget): WorkItemPage[] {
  const pageSizes = pages.map((page) => page.items.length);
  const items = reorderTasks(pages.flatMap((page) => page.items), target);

  let offset = 0;
  return pages.map((page, index) => {
    const nextItems = items.slice(offset, offset + pageSizes[index]);
    offset += pageSizes[index];
    return { ...page, items: nextItems };
  });
}
