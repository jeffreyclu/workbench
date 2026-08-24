import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { lifecycleCsv, lifecycleExportEvents, lifecycleXes } from './process-mining.js';
import { analyzeLifecycle, WORK_ITEM_LIFECYCLE_MODEL_VERSION } from './lifecycle-conformance.js';
import { WorkItemRepository } from './repository.js';

describe('process-mining export', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

  it('exports the intended lifecycle trace in stable timestamp order without task content', () => {
    const item = repository.create({ title: 'Sensitive title must not leave the database', description: 'Sensitive detail', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    repository.update(item.id, { status: 'ready' }, false, { actor: 'jeffrey', source: 'http', reason: 'triaged' });
    repository.archive(item.id, true, false, { actor: 'jeffrey', reason: 'verified' });

    const events = lifecycleExportEvents(database);
    expect(events.filter((event) => event.caseId === item.id).map((event) => ({ activity: event.activity, from: event.fromStatus, to: event.toStatus, initial: event.isInitial }))).toEqual([
      { activity: 'created', from: null, to: 'backlog', initial: true },
      { activity: 'status_changed', from: 'backlog', to: 'ready', initial: false },
      { activity: 'completed', from: 'ready', to: 'done', initial: false },
    ]);

    const csv = lifecycleCsv(events);
    const xes = lifecycleXes(events);
    expect(csv).toContain('case:concept:name,concept:name,time:timestamp');
    expect(csv).not.toContain('Sensitive title');
    expect(xes).toContain('<trace>');
    expect(xes).toContain('key="concept:name" value="completed"');
    expect(xes).not.toContain('Sensitive detail');
  });

  it('records Linear imports as an initial lifecycle state', () => {
    repository.upsertLinearItem({ sourceIdentifier: 'ENG-42', sourceUrl: null, title: 'Imported', description: '', status: 'ready', priority: 2, projectName: null, labels: [], dueDate: null, providerUpdatedAt: '2026-08-24T00:00:00.000Z', providerPayload: {} });
    expect(lifecycleExportEvents(database)).toEqual(expect.arrayContaining([
      expect.objectContaining({ activity: 'imported', fromStatus: null, toStatus: 'ready', isInitial: true, source: 'linear' }),
    ]));
  });

  it('preserves insertion order when transitions share a millisecond timestamp', () => {
    const item = repository.create({ title: 'Fast trace', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    repository.update(item.id, { status: 'ready' });
    database.prepare("UPDATE work_item_lifecycle_events SET occurred_at = '2030-01-01T00:00:00.000Z' WHERE work_item_id = ?").run(item.id);

    expect(lifecycleExportEvents(database).filter((event) => event.caseId === item.id).map((event) => event.activity))
      .toEqual(['created', 'status_changed']);
  });

  it('discovers the intended status graph and reports trace deviations against the lifecycle contract', () => {
    const item = repository.create({ title: 'Conformance trace', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    repository.update(item.id, { status: 'ready' });
    repository.archive(item.id, true);
    const events = lifecycleExportEvents(database);
    const valid = analyzeLifecycle(events, '2030-01-01T00:00:00.000Z');

    expect(valid.modelVersion).toBe(WORK_ITEM_LIFECYCLE_MODEL_VERSION);
    expect(valid.statusTransitionFrequencies).toEqual(expect.arrayContaining([
      { from: 'start', to: 'backlog', count: 1 }, { from: 'backlog', to: 'ready', count: 1 }, { from: 'ready', to: 'done', count: 1 },
    ]));
    expect(valid.deviations).toEqual([]);

    const invalid = analyzeLifecycle([{ ...events[1], caseId: 'broken', isInitial: false, fromStatus: null }], '2030-01-01T00:00:00.000Z');
    expect(invalid.deviations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_initial' }), expect.objectContaining({ code: 'invalid_transition' }),
    ]));
  });
});
