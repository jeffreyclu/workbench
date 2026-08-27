import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { DISCOVERY_RUN_MAX_AGE_MS, discoveryPriority, runDiscovery } from './discovery.js';
import type { SourceSignal } from './source-scanner.js';

vi.mock('./source-scanner.js', () => ({
  scanConnectedSources: vi.fn(),
}));

describe('discovery relevance', () => {
  it('keeps direct code review requests and connector work', () => {
    expect(discoveryPriority({ provider: 'slack', title: 'Can you review my PR?', summary: 'Teammate requested a code review', url: 'https://writer.slack.com/archives/C/p1', occurredAt: null })).toBe(2);
    expect(discoveryPriority({ provider: 'github', title: 'Refactor query', summary: '', url: 'https://github.com/writer/repo/pull/42', occurredAt: null })).toBe(2);
    expect(discoveryPriority({ provider: 'linear', title: 'Fix connector permissions', summary: 'Connectors team', url: 'https://linear.app/writer/issue/CON-1', occurredAt: null })).toBe(2);
  });

  it('keeps other actionable work below focus items and drops passive noise', () => {
    expect(discoveryPriority({ provider: 'slack', title: 'Could you prepare the demo?', summary: 'Direct request', url: null, occurredAt: null })).toBe(1);
    expect(discoveryPriority({ provider: 'linear', title: 'Billing cleanup', summary: 'Payments team', url: null, occurredAt: null })).toBe(1);
    expect(discoveryPriority({ provider: 'slack', title: 'Weekly update', summary: 'Jeffrey was mentioned in an announcement', url: null, occurredAt: null })).toBe(0);
    expect(discoveryPriority({ provider: 'confluence', title: 'Benefits enrollment', summary: 'Annual policy update', url: null, occurredAt: null })).toBe(0);
  });
});

describe('runDiscovery review cycle', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    vi.stubEnv('LINEAR_API_KEY', '');
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => {
    database.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('adds actionable signals to the review inbox without creating tasks', async () => {
    const { scanConnectedSources } = await import('./source-scanner.js');
    const now = Date.now();
    const at = (offsetMinutes: number) => new Date(now - offsetMinutes * 60_000).toISOString();
    const signals: SourceSignal[] = [
      { provider: 'github', title: 'Review PR: connector auth', summary: 'code review requested', url: 'https://github.com/writer/repo/pull/1', occurredAt: at(4) },
      { provider: 'linear', title: 'Fix connector permissions', summary: 'connectors team', url: 'https://linear.app/writer/issue/CON-1', occurredAt: at(3) },
      { provider: 'github', title: 'Review PR: mcp gateway', summary: 'code review requested', url: 'https://github.com/writer/repo/pull/2', occurredAt: at(2) },
      { provider: 'slack', title: 'Could you prepare the demo?', summary: 'direct request', url: 'https://writer.slack.com/archives/C/p2', occurredAt: at(1) },
      { provider: 'linear', title: 'Billing cleanup', summary: 'payments team', url: 'https://linear.app/writer/issue/BIL-1', occurredAt: at(0) },
    ];
    vi.mocked(scanConnectedSources).mockResolvedValue({ signals, errors: [] });

    await runDiscovery(repository);

    const inbox = repository.getDiscoveryInbox('pending');
    expect(inbox.candidates).toHaveLength(5);
    expect(inbox.candidates.map((candidate) => candidate.title)).toEqual([
      'Review PR: mcp gateway',
      'Fix connector permissions',
      'Review PR: connector auth',
      'Billing cleanup',
      'Could you prepare the demo?',
    ]);
    expect(inbox.candidates.every((candidate) => candidate.status === 'pending')).toBe(true);
    expect(repository.list()).toHaveLength(0);
  });

  it('refreshes existing candidates without duplicating them', async () => {
    const { scanConnectedSources } = await import('./source-scanner.js');
    const firstBatch: SourceSignal[] = [
      { provider: 'github', title: 'Review PR: connector auth', summary: 'code review requested', url: 'https://github.com/writer/repo/pull/1', occurredAt: new Date().toISOString() },
    ];
    vi.mocked(scanConnectedSources).mockResolvedValue({ signals: firstBatch, errors: [] });
    await runDiscovery(repository);
    expect(repository.getDiscoveryInbox('pending').candidates).toHaveLength(1);

    // Later than the first run's `completedAt`, so the second run's `since` cutoff keeps all of these.
    const secondBatch: SourceSignal[] = [
      { ...firstBatch[0], occurredAt: new Date().toISOString() },
      { provider: 'linear', title: 'Fix connector permissions', summary: 'connectors team', url: 'https://linear.app/writer/issue/CON-1', occurredAt: new Date().toISOString() },
      { provider: 'github', title: 'Review PR: mcp gateway', summary: 'code review requested', url: 'https://github.com/writer/repo/pull/2', occurredAt: new Date().toISOString() },
      { provider: 'linear', title: 'Review PR: billing service', summary: 'code review requested', url: 'https://linear.app/writer/issue/CON-2', occurredAt: new Date().toISOString() },
    ];
    vi.mocked(scanConnectedSources).mockResolvedValue({ signals: secondBatch, errors: [] });
    await runDiscovery(repository);

    // The already-pending candidate refreshes and the three new ones are added.
    expect(repository.getDiscoveryInbox('pending').candidates).toHaveLength(4);
  });

  it('recovers a stale durable run so a crashed scan cannot permanently block discovery', async () => {
    const { scanConnectedSources } = await import('./source-scanner.js');
    const abandoned = repository.startDiscoveryRun();
    database.prepare('UPDATE discovery_runs SET started_at = ? WHERE id = ?').run(new Date(Date.now() - DISCOVERY_RUN_MAX_AGE_MS - 1).toISOString(), abandoned.id);
    vi.mocked(scanConnectedSources).mockResolvedValue({
      signals: [{ provider: 'linear', title: 'Recover discovery', summary: 'action item', url: 'https://linear.app/recovered', occurredAt: new Date().toISOString() }],
      errors: [],
    });

    await runDiscovery(repository);

    expect(database.prepare('SELECT status, completed_at AS completedAt, errors_json AS errors FROM discovery_runs WHERE id = ?').get(abandoned.id)).toEqual(expect.objectContaining({ status: 'failed', completedAt: expect.any(String), errors: expect.stringContaining('recovered after runtime interruption') }));
    expect(repository.getDiscoveryInbox()).toMatchObject({ running: false, pendingCount: 1, lastRun: { status: 'completed' } });
  });

  it('keeps a candidate in review even when a similar task exists', async () => {
    const { scanConnectedSources } = await import('./source-scanner.js');
    repository.create({ title: 'Fix connector permission checks', description: 'Existing open task.', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    vi.mocked(scanConnectedSources).mockResolvedValue({
      signals: [{ provider: 'linear', title: 'Fix connector permissions', summary: 'Connectors team', url: 'https://linear.app/writer/issue/CON-1', occurredAt: new Date().toISOString() }],
      errors: [],
    });

    await runDiscovery(repository);

    expect(repository.getDiscoveryInbox('pending').candidates).toHaveLength(1);
    expect(repository.list().map((item) => item.title)).toEqual(['Fix connector permission checks']);
  });
});
