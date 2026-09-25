import type { TaskStackGroupCounts, WorkItem } from '../../shared/contracts';

export type TaskStackScope = 'attention' | 'workbench' | 'archive';
export type TaskStackGroup = 'progress' | 'attention' | 'pinned' | 'archive';

export type TaskStackRow =
  | { type: 'header'; id: string; label: string; count: number | undefined; group: TaskStackGroup }
  | { type: 'item'; id: string; item: WorkItem; group: TaskStackGroup };

export interface TaskStackViewModel {
  items: WorkItem[];
  rows: TaskStackRow[];
}

const activeGroups: Array<{ group: Extract<TaskStackGroup, 'progress' | 'attention' | 'pinned'>; id: string; label: string; matches: (item: WorkItem) => boolean }> = [
  { group: 'progress', id: 'in-progress-header', label: 'In progress', matches: (item) => item.status === 'in_progress' },
  { group: 'attention', id: 'attention-header', label: 'Attention stack', matches: (item) => item.status !== 'in_progress' && item.status !== 'pinned' },
  { group: 'pinned', id: 'pinned-header', label: 'Pinned for you', matches: (item) => item.status === 'pinned' },
];

/**
 * The attention and Workbench routes intentionally use this exact model. Their
 * query scope is the only distinction; card order and status grouping stay the
 * same as a task moves between the two stacks.
 */
/**
 * `groupCounts` are the server's section totals. Loaded pages never supply a
 * header number, because a partially loaded or searched list undercounts; with
 * no totals the header shows only its label.
 */
export function createTaskStackViewModel(items: WorkItem[], scope: TaskStackScope, groupCounts?: TaskStackGroupCounts): TaskStackViewModel {
  if (scope === 'archive') {
    return {
      items,
      rows: items.map((item) => ({ type: 'item', id: item.id, item, group: 'archive' })),
    };
  }

  const groups = activeGroups.map((definition) => ({ ...definition, items: items.filter(definition.matches) }));
  return {
    items: groups.flatMap((group) => group.items),
    // Pinned is a standing destination, not a transient label. Keeping it on
    // screen makes the place to return work obvious even before anything is
    // pinned there.
    rows: groups.flatMap((group) => group.items.length === 0 && group.group !== 'pinned' ? [] : [
      { type: 'header' as const, id: group.id, label: group.label, count: groupCounts?.[group.group], group: group.group },
      ...group.items.map((item) => ({ type: 'item' as const, id: item.id, item, group: group.group })),
    ]),
  };
}
