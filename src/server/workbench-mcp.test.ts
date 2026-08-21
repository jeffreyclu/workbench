import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { createWorkbenchMcpServer } from './workbench-mcp.js';

describe('Workbench MCP', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let client: Client;

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const server = createWorkbenchMcpServer(repository);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'workbench-mcp-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    database.close();
  });

  async function callData<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return (result.structuredContent as { data: T }).data;
  }

  it('advertises one explicit contract for every requested state area', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'add_activity',
      'add_conversation_message',
      'create_conversation',
      'create_work_item',
      'get_conversation',
      'get_work_item',
      'list_conversations',
      'list_discoveries',
      'list_execution_plans',
      'list_results',
      'list_stacks',
      'list_work_items',
      'propose_execution_plan',
      'reorder_stack',
      'resolve_discovery',
      'set_work_item_lifecycle',
      'update_work_item',
    ]);
    expect(tools.tools.find((tool) => tool.name === 'list_results')?.annotations).toEqual(expect.objectContaining({ readOnlyHint: true }));
    expect(tools.tools.find((tool) => tool.name === 'create_work_item')?.annotations).toEqual(expect.objectContaining({ readOnlyHint: false, openWorldHint: false }));
    const updateProperties = tools.tools.find((tool) => tool.name === 'update_work_item')?.inputSchema.properties ?? {};
    expect(Object.keys(updateProperties)).not.toEqual(expect.arrayContaining(['source', 'sourceIdentifier', 'providerUpdatedAt', 'queuePosition', 'archivedAt']));
    expect(tools.tools.some((tool) => /delete|dispatch|cancel|sync/i.test(tool.name))).toBe(false);
  });

  it('reads and atomically replaces stack order, then applies a recoverable lifecycle transition', async () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const initial = await callData<{ stacks: Array<{ name: string; orderedWorkItemIds?: string[] }> }>('list_stacks', {});
    expect(initial.stacks.find((stack) => stack.name === 'attention')?.orderedWorkItemIds).toEqual([second.id, first.id]);

    await callData('reorder_stack', { stack: 'attention', orderedWorkItemIds: [first.id, second.id] });
    const page = await callData<{ items: Array<{ id: string }> }>('list_work_items', { stack: 'attention' });
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);

    await callData('set_work_item_lifecycle', { workItemId: first.id, action: 'complete' });
    const archive = await callData<{ items: Array<{ id: string; completionStatus: string }> }>('list_work_items', { stack: 'archive' });
    expect(archive.items).toContainEqual(expect.objectContaining({ id: first.id, completionStatus: 'completed' }));
    await callData('set_work_item_lifecycle', { workItemId: first.id, action: 'restore' });
    expect(repository.get(first.id)).toEqual(expect.objectContaining({ archivedAt: null, completionStatus: 'incomplete' }));
  });

  it('creates and updates only local task state, then exposes the same canonical detail', async () => {
    const created = await callData<{ item: { id: string; source: string } }>('create_work_item', {
      title: 'Expose Workbench through MCP',
      description: 'One shared state boundary.',
      priority: 1,
      status: 'ready',
      projectName: 'Workbench',
    });
    expect(created.item.source).toBe('manual');

    await callData('update_work_item', {
      workItemId: created.item.id,
      strategy: 'Reuse the repository boundary.',
      assignees: ['codex', 'claude'],
    });
    await callData('add_activity', {
      workItemId: created.item.id,
      actor: 'codex',
      kind: 'decision',
      body: 'Provider-owned fields remain outside MCP.',
    });

    const detail = await callData<{
      item: { strategy: string; assignees: string[] };
      activity: Array<{ actor: string; kind: string; body: string }>;
    }>('get_work_item', { workItemId: created.item.id });
    expect(detail.item).toEqual(expect.objectContaining({ strategy: 'Reuse the repository boundary.', assignees: ['codex', 'claude'] }));
    expect(detail.activity).toContainEqual(expect.objectContaining({ actor: 'codex', kind: 'decision', body: 'Provider-owned fields remain outside MCP.' }));
  });

  it('logs an attributed activity entry for the fields an assistant changes', async () => {
    const item = repository.create({ title: 'Assistant edit', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    await callData('update_work_item', { workItemId: item.id, actor: 'claude', status: 'blocked', priority: 0 });

    const logged = repository.listActivity(item.id).find((entry) => entry.kind === 'edited');
    expect(logged).toEqual(expect.objectContaining({ actor: 'claude', body: 'Status: ready → blocked · Priority: 2 → 0.' }));
  });

  it('rejects assistant impersonation at the tool contract boundary', async () => {
    const item = repository.create({ title: 'Scoped actor', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const result = await client.callTool({
      name: 'add_activity',
      arguments: { workItemId: item.id, actor: 'jeffrey', kind: 'note', body: 'Not allowed.' },
    });
    expect(result.isError).toBe(true);
    expect(repository.listActivity(item.id)).toHaveLength(1);
  });

  it('exposes plan proposals and immutable execution results but not plan approval or run mutation', async () => {
    const item = repository.create({ title: 'Plan work', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: '/tmp/work', dueDate: null });
    const proposed = await callData<{ plan: { id: string; status: string } }>('propose_execution_plan', {
      workItemId: item.id,
      summary: 'Split safely.',
      tasks: [{ title: 'Inventory', description: 'Find all call sites.', workspacePath: null }],
    });
    expect(proposed.plan.status).toBe('pending');

    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', 'Inspect the boundary.');
    repository.updateRun(run.id, { status: 'completed', output: 'Boundary verified.', completedAt: new Date().toISOString() });
    const plans = await callData<{ plans: Array<{ id: string }> }>('list_execution_plans', { workItemId: item.id });
    const results = await callData<{ results: Array<{ id: string; output: string }> }>('list_results', { workItemId: item.id, status: 'completed' });
    expect(plans.plans.map((plan) => plan.id)).toEqual([proposed.plan.id]);
    expect(results.results).toEqual([expect.objectContaining({ id: run.id, output: 'Boundary verified.' })]);
  });

  it('resolves only pending discoveries and returns stable domain errors afterward', async () => {
    const discoveryRun = repository.startDiscoveryRun();
    repository.upsertDiscoveryCandidate({
      fingerprint: 'mcp-discovery', provider: 'github', title: 'New backend task', description: 'Investigate it.',
      sourceUrl: 'https://github.com/example/repo/issues/1', occurredAt: null, runId: discoveryRun.id,
    });
    const discovery = repository.getDiscoveryInbox('pending').candidates[0];
    const resolved = await callData<{ candidate: { status: string }; item: { source: string } }>('resolve_discovery', { discoveryId: discovery.id, action: 'convert' });
    expect(resolved.candidate.status).toBe('converted');
    expect(resolved.item.source).toBe('manual');

    const duplicate = await client.callTool({ name: 'resolve_discovery', arguments: { discoveryId: discovery.id, action: 'dismiss' } });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.structuredContent).toEqual({ error: { code: 'NOT_FOUND', message: 'Pending discovery not found.' } });
  });
});
