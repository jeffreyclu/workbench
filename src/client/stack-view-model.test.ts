import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../shared/contracts';
import { createTaskStackViewModel } from './stack-view-model';

const item = (id: string, status: WorkItem['status']): WorkItem => ({
  id, title: id, description: '', status, priority: 2, queuePosition: 0,
  source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
  agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', stack: 'attention', workspacePath: null,
  strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
});

describe('createTaskStackViewModel', () => {
  it('uses the same status sections and ordering for attention and Workbench scopes', () => {
    const items = [item('pinned', 'pinned'), item('attention', 'ready'), item('progress', 'in_progress')];

    const attention = createTaskStackViewModel(items, 'attention');
    const workbench = createTaskStackViewModel(items, 'workbench');

    expect(workbench).toEqual(attention);
    expect(attention.rows.filter((row) => row.type === 'header').map((row) => [row.label, row.count])).toEqual([
      ['In progress', 1],
      ['Attention stack', 1],
      ['Pinned for you', 1],
    ]);
    expect(attention.items.map((entry) => entry.id)).toEqual(['progress', 'attention', 'pinned']);
  });

  it('keeps the empty pinned section visible as a standing destination', () => {
    const rows = createTaskStackViewModel([], 'workbench').rows;

    expect(rows).toEqual([
      { type: 'header', id: 'pinned-header', label: 'Pinned for you', count: 0, group: 'pinned' },
    ]);
  });
});
