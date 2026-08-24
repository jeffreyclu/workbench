import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { createWorkbenchMcpServer, type WorkbenchAdminActions } from './workbench-mcp.js';

describe('Workbench MCP', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let client: Client;
  let calls: Array<{ method: string; args: unknown[] }>;

  /**
   * The admin port is implemented by `createApp` against real execution and
   * publishing. Here it records the call so the tests can assert the tool
   * contract and the argument mapping without spawning agents or deploying.
   */
  function stubAdmin(overrides: Partial<WorkbenchAdminActions> = {}): WorkbenchAdminActions {
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return { ok: method };
    };
    return {
      startWorkItemExecution: record('startWorkItemExecution'),
      startAgentRun: record('startAgentRun'),
      cancelRun: record('cancelRun'),
      retryRun: record('retryRun'),
      resolvePlan: record('resolvePlan'),
      deleteWorkItem: record('deleteWorkItem'),
      deleteConversation: record('deleteConversation'),
      dispatchConversationTurn: record('dispatchConversationTurn'),
      cancelSharedMessage: record('cancelSharedMessage'),
      publishArtifact: record('publishArtifact'),
      listArtifacts: record('listArtifacts'),
      revokeArtifact: record('revokeArtifact'),
      runDiscoveryScan: record('runDiscoveryScan'),
      promoteRuntime: record('promoteRuntime'),
      listSourceConnections: record('listSourceConnections'),
      authorizeSource: record('authorizeSource'),
      setFigmaScope: record('setFigmaScope'),
      disconnectSource: record('disconnectSource'),
      getLinearProvider: record('getLinearProvider'),
      syncLinearProvider: record('syncLinearProvider'),
      configureLinearProvider: record('configureLinearProvider'),
      queueLinearWorkItem: record('queueLinearWorkItem'),
      ...overrides,
    } as WorkbenchAdminActions;
  }

  beforeEach(async () => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    calls = [];
    const server = createWorkbenchMcpServer(repository, stubAdmin());
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

  it('advertises the complete Workbench admin surface, including destructive and control-plane actions', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'add_activity',
      'add_conversation_message',
      'authorize_source_connection',
      'cancel_agent_run',
      'cancel_conversation_message',
      'configure_linear_provider',
      'create_agent_run',
      'create_conversation',
      'create_work_item',
      'delete_work_item',
      'disconnect_source_connection',
      'dispatch_conversation_turn',
      'execute_work_item',
      'get_conversation',
      'get_linear_provider',
      'get_work_item',
      'list_artifacts',
      'list_audit_log',
      'list_conversations',
      'list_discoveries',
      'list_execution_plans',
      'list_projects',
      'list_results',
      'list_source_connections',
      'list_stacks',
      'list_work_items',
      'manage_conversation',
      'manage_work_item_link',
      'manage_work_item_reference',
      'promote_runtime',
      'propose_execution_plan',
      'publish_artifact',
      'queue_linear_work_item',
      'reorder_stack',
      'resolve_discovery',
      'resolve_execution_plan',
      'retry_agent_run',
      'revoke_artifact',
      'run_discovery_scan',
      'set_figma_discovery_scope',
      'set_work_item_lifecycle',
      'sync_linear_provider',
      'unblock_work_item',
      'update_work_item',
    ]);
    expect(tools.tools.find((tool) => tool.name === 'list_results')?.annotations).toEqual(expect.objectContaining({ readOnlyHint: true }));
    expect(tools.tools.find((tool) => tool.name === 'create_work_item')?.annotations).toEqual(expect.objectContaining({ readOnlyHint: false, openWorldHint: false }));
    // Irreversible actions stay available, but they announce themselves as destructive.
    for (const name of ['delete_work_item', 'revoke_artifact']) {
      expect(tools.tools.find((tool) => tool.name === name)?.annotations).toEqual(expect.objectContaining({ destructiveHint: true }));
    }
    const updateProperties = tools.tools.find((tool) => tool.name === 'update_work_item')?.inputSchema.properties ?? {};
    expect(Object.keys(updateProperties)).not.toEqual(expect.arrayContaining(['source', 'sourceIdentifier', 'providerUpdatedAt', 'queuePosition', 'archivedAt']));
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

  it('exposes plan proposals and the immutable execution-result record', async () => {
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
  it('routes every execution and control-plane tool to the shared admin actions', async () => {
    const item = repository.create({ title: 'Admin control', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Control plane', item.id);
    const plan = repository.createExecutionPlan(item.id, 'Split it.', [{ title: 'Step one', description: '', workspacePath: null }]);
    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', 'Look.');

    await callData('execute_work_item', { workItemId: item.id, executionProfile: 'deep', force: true });
    await callData('create_agent_run', { workItemId: item.id, kind: 'review', target: 'claude', instructions: 'Review it.', actor: 'claude' });
    await callData('cancel_agent_run', { runId: run.id });
    await callData('retry_agent_run', { runId: run.id, force: true });
    await callData('resolve_execution_plan', { planId: plan.id, resolution: 'accepted' });
    await callData('dispatch_conversation_turn', { conversationId: conversation.id, actor: 'codex', body: 'Take this.', dispatchTo: 'claude' });
    await callData('publish_artifact', { path: 'notes/report.md', workItemId: item.id });
    await callData('revoke_artifact', { artifactId: 'artifact-1' });
    await callData('run_discovery_scan', {});
    await callData('promote_runtime', { conversationId: conversation.id });
    await callData('delete_work_item', { workItemId: item.id, actor: 'claude' });

    expect(calls.map((call) => call.method)).toEqual([
      'startWorkItemExecution', 'startAgentRun', 'cancelRun', 'retryRun', 'resolvePlan',
      'dispatchConversationTurn', 'publishArtifact', 'revokeArtifact', 'runDiscoveryScan',
      'promoteRuntime', 'deleteWorkItem',
    ]);
    expect(calls[0].args).toEqual([item.id, { executionProfile: 'deep', force: true }]);
    expect(calls[1].args).toEqual([item.id, { kind: 'review', target: 'claude', instructions: 'Review it.', executionProfile: null }, { actor: 'claude', force: false }]);
    expect(calls[5].args).toEqual([conversation.id, 'codex', 'Take this.', 'claude', null]);
  });

  it('administers source connections and Linear without exposing credentials', async () => {
    await callData('list_source_connections', {});
    await callData('authorize_source_connection', { provider: 'figma', mode: 'managed' });
    await callData('set_figma_discovery_scope', { roots: ['https://www.figma.com/design/abc123/Workbench'] });
    await callData('disconnect_source_connection', { provider: 'slack', actor: 'codex' });
    await callData('get_linear_provider', { teamId: 'team-1' });
    await callData('sync_linear_provider', {});
    await callData('configure_linear_provider', { teamIds: ['team-1'], projectIds: ['project-1'] });
    await callData('queue_linear_work_item', { workItemId: '00000000-0000-4000-8000-000000000001' });

    expect(calls.slice(-8)).toEqual([
      { method: 'listSourceConnections', args: [] },
      { method: 'authorizeSource', args: [{ provider: 'figma', mode: 'managed' }] },
      { method: 'setFigmaScope', args: [['https://www.figma.com/design/abc123/Workbench']] },
      { method: 'disconnectSource', args: ['slack', 'codex'] },
      { method: 'getLinearProvider', args: ['team-1'] },
      { method: 'syncLinearProvider', args: [] },
      { method: 'configureLinearProvider', args: [['team-1'], ['project-1']] },
      { method: 'queueLinearWorkItem', args: ['00000000-0000-4000-8000-000000000001'] },
    ]);
  });

  it('surfaces a refused admin action as a domain error rather than an internal failure', async () => {
    await client.close();
    const server = createWorkbenchMcpServer(repository, stubAdmin({
      startWorkItemExecution: async () => ({ status: 409, body: { error: 'This task already has an active agent run.' } }),
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'workbench-mcp-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const item = repository.create({ title: 'Busy', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const result = await client.callTool({ name: 'execute_work_item', arguments: { workItemId: item.id } });
    expect(result.structuredContent).toEqual({ error: { code: 'CONFLICT', message: 'This task already has an active agent run.' } });
  });

  it('administers conversations through the recoverable and permanent paths', async () => {
    const conversation = repository.createConversation('Archive me', null);

    await callData('manage_conversation', { conversationId: conversation.id, action: 'archive' });
    expect(repository.getConversation(conversation.id)?.archivedAt).not.toBeNull();
    await callData('manage_conversation', { conversationId: conversation.id, action: 'restore' });
    expect(repository.getConversation(conversation.id)?.archivedAt).toBeNull();

    await callData('manage_conversation', { conversationId: conversation.id, action: 'set_brief', brief: 'Shared brief.' });
    expect(repository.getConversation(conversation.id)?.sharedBrief).toBe('Shared brief.');

    await callData('manage_conversation', { conversationId: conversation.id, action: 'delete', actor: 'codex' });
    expect(calls.at(-1)).toEqual({ method: 'deleteConversation', args: [conversation.id, 'codex'] });
  });

  it('manages task links and external references in both directions', async () => {
    const item = repository.create({ title: 'Linked', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const other = repository.create({ title: 'Other', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    await callData('manage_work_item_link', { workItemId: item.id, action: 'add', linkedWorkItemId: other.id });
    expect(repository.listLinkedTasks(item.id).map((linked) => linked.id)).toEqual([other.id]);
    await callData('manage_work_item_link', { workItemId: item.id, action: 'remove', linkedWorkItemId: other.id });
    expect(repository.listLinkedTasks(item.id)).toEqual([]);

    const added = await callData<{ reference: { id: string } }>('manage_work_item_reference', {
      workItemId: item.id, action: 'add', type: 'pull_request', url: 'https://github.com/example/repo/pull/7', title: 'PR 7',
    });
    expect(repository.listReferences(item.id).map((reference) => reference.url)).toEqual(['https://github.com/example/repo/pull/7']);
    await callData('manage_work_item_reference', { workItemId: item.id, action: 'remove', referenceId: added.reference.id });
    expect(repository.listReferences(item.id)).toEqual([]);
  });
});
