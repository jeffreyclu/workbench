import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { WorkItemRepository } from '../repository.js';
import { ArtifactLibrary } from '../artifact-library.js';
import { liveRuntimeCapabilities } from '../runtime-capabilities.js';
import { ArtifactService } from './artifact-service.js';
import { WorkbenchAdminService } from './workbench-admin-service.js';

vi.mock('../agent-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent-runner.js')>(),
  executeAgentRun: vi.fn(),
}));

describe('WorkbenchAdminService.dispatchConversationTurn', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let admin: WorkbenchAdminService;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const artifacts = new ArtifactLibrary(database);
    admin = new WorkbenchAdminService(repository, liveRuntimeCapabilities, new ArtifactService(repository, artifacts));
  });

  afterEach(() => {
    database.close();
  });

  it('unpins a pinned conversation and its linked task when a turn is dispatched over MCP', () => {
    const task = repository.create({ title: 'Pinned MCP dispatch target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { status: 'pinned' });
    const conversation = repository.createConversation('Keep working', task.id);
    repository.setConversationPinned(conversation.id, true);

    admin.mcpActions().dispatchConversationTurn(conversation.id, 'codex', 'testing', 'claude', null);

    expect(repository.getConversation(conversation.id)?.pinned).toBe(false);
    expect(repository.get(task.id)?.status).not.toBe('pinned');
  });

  it('does not unpin when the turn is not dispatched to an agent', () => {
    const task = repository.create({ title: 'Pinned no-op dispatch target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { status: 'pinned' });
    const conversation = repository.createConversation('Stay pinned', task.id);
    repository.setConversationPinned(conversation.id, true);

    admin.mcpActions().dispatchConversationTurn(conversation.id, 'codex', 'note only', 'none', null);

    expect(repository.getConversation(conversation.id)?.pinned).toBe(true);
    expect(repository.get(task.id)?.status).toBe('pinned');
  });
});

describe('WorkbenchAdminService.startWorkItemExecution', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let admin: WorkbenchAdminService;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const artifacts = new ArtifactLibrary(database);
    admin = new WorkbenchAdminService(repository, liveRuntimeCapabilities, new ArtifactService(repository, artifacts));
  });

  afterEach(() => {
    database.close();
  });

  it('persists a pre-selected task agent on the execution conversation', async () => {
    const task = repository.create({ title: 'Fix assigned task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { assignees: ['claude'] });
    repository.setClassification(task.id, { kind: 'execute', agent: 'codex', complex: false, instructions: '' });

    const result = await admin.startWorkItemExecution(task.id, { executionProfile: null, force: false });

    expect('conversation' in result && result.conversation.preferredDispatchTarget).toBe('claude');
    expect(repository.listConversationsForWorkItem(task.id)[0]?.preferredDispatchTarget).toBe('claude');
    expect(repository.listRuns(task.id)).toEqual([
      expect.objectContaining({ agent: 'claude', requestedTarget: 'claude' }),
    ]);
  });

  it('persists the automatically routed agent on the execution conversation', async () => {
    const task = repository.create({ title: 'Fix automatic task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(task.id, { kind: 'execute', agent: 'codex', complex: false, instructions: '' });

    const result = await admin.startWorkItemExecution(task.id, { executionProfile: null, force: false });

    expect('conversation' in result && result.conversation.preferredDispatchTarget).toBe('codex');
    expect(repository.listConversationsForWorkItem(task.id)[0]?.preferredDispatchTarget).toBe('codex');
    expect(repository.listRuns(task.id)).toEqual([
      expect.objectContaining({ agent: 'codex', requestedTarget: 'auto' }),
    ]);
  });

  it('routes a review to the vendor other than its completed implementation', async () => {
    const task = repository.create({ title: 'Review routed task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const implementation = repository.createRun(task.id, 'execute', 'auto', 'codex', 'Implement it.');
    repository.updateRun(implementation.id, { status: 'completed', completedAt: new Date().toISOString() });
    repository.setClassification(task.id, { kind: 'review', agent: 'codex', complex: false, instructions: 'Review it.' });

    const result = await admin.startWorkItemExecution(task.id, { executionProfile: null, force: true });

    expect('run' in result && result.run.agent).toBe('claude');
    expect(repository.listActivity(task.id).find((entry) => entry.kind === 'execution_started')?.body).toContain('chosen because implementer was codex');
  });

  it('never selects Palmyra for a task\'s first Auto execution', async () => {
    const loaded = repository.create({ title: 'Existing load', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(loaded.id, 'execute', 'auto', 'codex', 'first');
    repository.createRun(loaded.id, 'execute', 'auto', 'claude', 'second');
    const task = repository.create({ title: 'First execution', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(task.id, { kind: 'execute', agent: 'codex', complex: false, instructions: '' });

    const result = await admin.startWorkItemExecution(task.id, { executionProfile: null, force: false });

    expect('run' in result && result.run.agent).toBe('codex');
    expect(repository.listRuns(task.id).map((run) => run.agent)).toEqual(['codex']);
  });

  it('never selects Palmyra for a manual Auto task run', async () => {
    const loaded = repository.create({ title: 'Existing manual load', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(loaded.id, 'execute', 'auto', 'codex', 'first');
    repository.createRun(loaded.id, 'execute', 'auto', 'claude', 'second');
    const task = repository.create({ title: 'Manual Auto run', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const result = await admin.startAgentRun(task.id, { kind: 'execute', target: 'auto', instructions: '', executionProfile: null }, { actor: 'jeffrey', force: false });

    expect('runs' in result && result.runs.map((run) => run.agent)).toEqual(['codex']);
  });

  it('retries a provider refusal with the other vendor', async () => {
    const task = repository.create({ title: 'Retry refused request', description: '', priority: 2, status: 'blocked', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(task.id, task.title);
    const message = repository.createSharedMessage('claude', '', 'failed', conversation.id);
    const run = repository.createRun(task.id, 'execute', 'claude', 'claude', 'Implement it.', conversation.id, message.id);
    repository.updateRun(run.id, { status: 'failed', error: 'Safeguards flagged this message.', failureKind: 'provider_refusal' });

    const result = await admin.retryRun(run.id, { force: false });

    expect('run' in result && result.run).toEqual(expect.objectContaining({
      id: run.id, status: 'queued', requestedAgent: 'claude', agent: 'codex', failureKind: null, fallbackFrom: 'claude',
    }));
    expect(repository.getSharedMessageById(message.id)).toEqual(expect.objectContaining({ status: 'running', author: 'codex', fallbackFrom: 'claude' }));
    expect(repository.listActivity(task.id).find((entry) => entry.kind === 'execution_retried')?.body).toBe('Retrying execute with codex because claude refused the request.');
  });

  it('puts dual task execution through the same durable conversation group as dual chat', async () => {
    const task = repository.create({ title: 'Review the connector PR', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { assignees: ['codex', 'claude'] });
    repository.setClassification(task.id, { kind: 'review', agent: 'codex', complex: false, instructions: 'Review it.' });

    const result = await admin.startWorkItemExecution(task.id, { executionProfile: 'deep', force: false });

    expect('runs' in result && result.runs).toHaveLength(2);
    const messages = repository.listAllSharedMessages(repository.listConversationsForWorkItem(task.id)[0]!.id);
    const request = messages.find((message) => message.author === 'system' && message.body.startsWith('Execute:'));
    const replies = messages.filter((message) => message.author === 'codex' || message.author === 'claude');
    expect(request).toEqual(expect.objectContaining({ dispatchTarget: 'both' }));
    expect(replies).toHaveLength(2);
    expect(replies.every((reply) => reply.dispatchGroupId === request?.id)).toBe(true);
  });
});
