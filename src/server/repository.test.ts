import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemDependencyError, WorkItemRepository } from './repository.js';
import { cancelSharedReply, dispatchNextSharedTurn } from './shared-room.js';

describe('WorkItemRepository', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

  it('aggregates reported token usage by provider and model for terminal runs', () => {
    const item = repository.create({ title: 'Measure usage', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const codexRun = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Implement it.');
    const claudeRun = repository.createRun(item.id, 'review', 'claude', 'claude', 'Review it.');
    const unreportedRun = repository.createRun(item.id, 'research', 'codex', 'codex', 'Research it.');
    repository.updateRun(codexRun.id, { status: 'completed', model: 'gpt-5.6-terra', inputTokens: 1_200, outputTokens: 300 });
    repository.updateRun(claudeRun.id, { status: 'failed', model: 'claude-sonnet', inputTokens: 400, outputTokens: 100 });
    repository.updateRun(unreportedRun.id, { status: 'completed', model: 'gpt-5.6-terra' });

    expect(repository.getRunInsights()).toMatchObject({
      inputTokens: 1_600,
      outputTokens: 400,
      tokenUsageByModel: [
        { provider: 'codex', model: 'gpt-5.6-terra', inputTokens: 1_200, outputTokens: 300 },
        { provider: 'claude', model: 'claude-sonnet', inputTokens: 400, outputTokens: 100 },
      ],
    });
  });

  it('attributes cursing to the model that most recently replied in the conversation', () => {
    const conversation = repository.createConversation('Model attribution');
    const claudeReply = repository.createSharedMessage('claude', 'Here is the first answer.', 'completed', conversation.id);
    repository.updateSharedMessage(claudeReply.id, { model: 'sonnet' });
    repository.createSharedMessage('jeffrey', 'This is fucking wrong.', 'completed', conversation.id);
    const codexReply = repository.createSharedMessage('codex', 'Here is the revised answer.', 'completed', conversation.id);
    repository.updateSharedMessage(codexReply.id, { model: 'gpt-5.6-terra' });
    repository.createSharedMessage('jeffrey', 'Still shit.', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', 'What the fuck?', 'completed', conversation.id);

    expect(repository.getRunInsights().cursing.byModel).toEqual([
      expect.objectContaining({ model: 'gpt-5.6-terra', count: 2, messagesWithCurses: 2 }),
      expect.objectContaining({ model: 'sonnet', count: 1, messagesWithCurses: 1 }),
    ]);
  });

  it('backfills cost for historical runs that recorded tokens but no cost, and does not overwrite an existing cost', () => {
    const item = repository.create({ title: 'Backfill cost', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const priced = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Implement it.');
    const alreadyPriced = repository.createRun(item.id, 'review', 'claude', 'claude', 'Review it.');
    const unknownModel = repository.createRun(item.id, 'research', 'codex', 'codex', 'Research it.');
    repository.updateRun(priced.id, { status: 'completed', model: 'opus', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    repository.updateRun(alreadyPriced.id, { status: 'completed', model: 'opus', inputTokens: 1_000_000, outputTokens: 1_000_000, estimatedCostUsd: 0.5 });
    repository.updateRun(unknownModel.id, { status: 'completed', model: 'not-a-real-model', inputTokens: 500, outputTokens: 500 });

    expect(repository.backfillEstimatedCosts()).toBe(1);
    // opus list price: $15/M in + $75/M out.
    expect(repository.getRun(priced.id)?.estimatedCostUsd).toBe(90);
    // A provider-reported total must survive the backfill untouched.
    expect(repository.getRun(alreadyPriced.id)?.estimatedCostUsd).toBe(0.5);
    // No rate for the model means no invented number.
    expect(repository.getRun(unknownModel.id)?.estimatedCostUsd).toBeNull();
    // Idempotent: a second pass finds nothing left to fill.
    expect(repository.backfillEstimatedCosts()).toBe(0);
  });

  it('reports total, per-agent, and per-model cost, and counts runs it could not price', () => {
    const item = repository.create({ title: 'Cost insights', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const claudeRun = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Implement it.');
    const codexRun = repository.createRun(item.id, 'review', 'codex', 'codex', 'Review it.');
    const unpriced = repository.createRun(item.id, 'research', 'codex', 'codex', 'Research it.');
    repository.updateRun(claudeRun.id, { status: 'completed', model: 'opus', inputTokens: 100, outputTokens: 200, estimatedCostUsd: 2 });
    repository.updateRun(codexRun.id, { status: 'completed', model: 'gpt-5.6-terra', inputTokens: 100, outputTokens: 200, estimatedCostUsd: 0.5 });
    repository.updateRun(unpriced.id, { status: 'completed', model: 'not-a-real-model', inputTokens: 100, outputTokens: 200 });

    const insights = repository.getRunInsights();
    expect(insights.costUsd).toBe(2.5);
    expect(insights.pricedRuns).toBe(2);
    expect(insights.unpricedRuns).toBe(1);
    // No history before this window, so there is nothing to trend against.
    expect(insights.previousCostUsd).toBeNull();
    expect(insights.byAgent.find((agent) => agent.agent === 'claude')?.costUsd).toBe(2);
    expect(insights.byAgent.find((agent) => agent.agent === 'codex')?.costUsd).toBe(0.5);
    expect(insights.tokenUsageByModel.find((row) => row.model === 'opus')).toMatchObject({ costUsd: 2, runs: 1, rateSource: 'default' });
    expect(insights.tokenUsageByModel.find((row) => row.model === 'not-a-real-model')).toMatchObject({ costUsd: 0, rateSource: null });
    expect(insights.costByDay.reduce((total, day) => total + day.costUsd, 0)).toBe(2.5);
  });

  it('uses lifecycle events for retry and handoff insights, including chat-era history', () => {
    const item = repository.create({ title: 'Lifecycle telemetry', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Implement it.');
    repository.updateRun(run.id, { status: 'canceled', completedAt: new Date().toISOString() });
    repository.addActivity(item.id, 'system', 'execution_retried', 'Retrying claude execute after the prior attempt canceled.');
    repository.addActivity(item.id, 'system', 'agent_fallback', 'claude was unavailable; continued with codex.');

    expect(repository.getRunInsights()).toMatchObject({
      retryCount: 1,
      handoffCount: 1,
      retryRate: 1,
      fallbackRate: 1,
    });
  });

  it('excludes extreme task-cycle outliers before calculating the median insight', () => {
    const hour = 60 * 60 * 1_000;
    const completedAt = new Date().toISOString();
    const durations = [hour, 2 * hour, 3 * hour, 4 * hour, 5 * hour, 90 * 24 * hour];

    for (const [index, duration] of durations.entries()) {
      const item = repository.create({ title: `Cycle ${index}`, description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const startedAt = new Date(new Date(completedAt).getTime() - duration).toISOString();
      const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Do it.');
      repository.updateRun(run.id, { status: 'completed', startedAt, completedAt });
      database.prepare('UPDATE work_items SET completed_at = ? WHERE id = ?').run(completedAt, item.id);
    }

    const medianTaskCycleMs = repository.getRunInsights().medianTaskCycleMs;
    expect(medianTaskCycleMs).not.toBeNull();
    expect(medianTaskCycleMs!).toBeGreaterThan(2.9 * hour);
    expect(medianTaskCycleMs!).toBeLessThan(3.1 * hour);
  });

  it('keeps every task-cycle value when there is not enough history to identify an outlier', () => {
    const hour = 60 * 60 * 1_000;
    const completedAt = new Date().toISOString();
    const durations = [hour, 2 * hour, 3 * hour, 90 * 24 * hour];

    for (const [index, duration] of durations.entries()) {
      const item = repository.create({ title: `Small sample ${index}`, description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const startedAt = new Date(new Date(completedAt).getTime() - duration).toISOString();
      const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Do it.');
      repository.updateRun(run.id, { status: 'completed', startedAt, completedAt });
      database.prepare('UPDATE work_items SET completed_at = ? WHERE id = ?').run(completedAt, item.id);
    }

    const medianTaskCycleMs = repository.getRunInsights().medianTaskCycleMs;
    expect(medianTaskCycleMs).not.toBeNull();
    expect(medianTaskCycleMs!).toBeGreaterThan(2.9 * hour);
    expect(medianTaskCycleMs!).toBeLessThan(3.1 * hour);
  });

  it('creates and updates a manual work item', () => {
    const item = repository.create({
      title: 'Ship the queue',
      description: '',
      priority: 1,
      status: 'ready',
      projectName: 'Workbench',
      workspacePath: null,
      dueDate: null,
    });

    expect(item.source).toBe('manual');
    expect(item.isQueued).toBe(true);
    expect(repository.listWorkbench().map((entry) => entry.id)).toContain(item.id);
    expect(repository.update(item.id, { status: 'in_progress' })?.status).toBe('in_progress');
    expect(repository.listActivity(item.id)).toHaveLength(1);
  });

  it('never archives a task when editing its title and can restore archived tasks', () => {
    const item = repository.create({ title: 'Old title', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const renamed = repository.update(item.id, { title: 'New title' })!;
    expect(renamed.title).toBe('New title');
    expect(renamed.archivedAt).toBeNull();

    expect(repository.archive(item.id, true)).toEqual(expect.objectContaining({ archivedAt: expect.any(String), completionStatus: 'completed' }));
    const restored = repository.restore(item.id)!;
    expect(restored).toEqual(expect.objectContaining({ archivedAt: null, completedAt: null, completionStatus: 'incomplete', status: 'ready', isQueued: true }));
    expect(repository.listConversations().find((conversation) => conversation.workItemId === item.id)?.archivedAt).toBeUndefined();
  });

  it('logs every lifecycle move so a task never leaves the queue unexplained', () => {
    const item = repository.create({ title: 'Ship the log', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    repository.archive(item.id, true, false, { actor: 'jeffrey' });
    repository.restore(item.id, false, { actor: 'jeffrey' });
    repository.archive(item.id, false, false, { reason: 'its conversation was archived' });

    expect(repository.listActivity(item.id).map((entry) => ({ actor: entry.actor, kind: entry.kind, body: entry.body })))
      .toEqual(expect.arrayContaining([
        { actor: 'jeffrey', kind: 'completed', body: 'Completed and moved to the archive.' },
        { actor: 'jeffrey', kind: 'restored', body: 'Restored from the archive.' },
        { actor: 'system', kind: 'archived', body: 'Archived without completing because its conversation was archived.' },
      ]));
  });

  it('logs a rejected plan so the task does not look untouched after a proposal', () => {
    const parent = repository.create({ title: 'Big migration', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const plan = repository.createExecutionPlan(parent.id, 'Split it.', [
      { title: 'First', description: 'Do it.', workspacePath: null },
      { title: 'Second', description: 'Then this.', workspacePath: null },
    ]);

    repository.resolveExecutionPlan(plan.id, 'rejected');

    expect(repository.listActivity(parent.id).find((entry) => entry.kind === 'decomposed'))
      .toMatchObject({ actor: 'jeffrey', body: 'Rejected the proposed breakdown into 2 tasks.' });
  });

  it('keeps same-millisecond activity in insertion order so a decision precedes its consequence', () => {
    const item = repository.create({ title: 'Fast writer', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    // These land inside one millisecond in practice, which is exactly when a
    // created_at-only sort used to flip the routing decision behind its model.
    repository.addActivity(item.id, 'system', 'execution_started', 'Execution type: execute.');
    repository.addActivity(item.id, 'system', 'model_selected', 'Model: codex gpt-5.6-terra.');

    expect(repository.listActivity(item.id).map((entry) => entry.kind).slice(0, 2)).toEqual(['model_selected', 'execution_started']);
  });

  it('does not repeat a lifecycle entry when the same move is applied twice', () => {
    const item = repository.create({ title: 'Double tapped', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const lifecycle = () => repository.listActivity(item.id).filter((entry) => ['archived', 'completed'].includes(entry.kind));

    repository.archive(item.id, false);
    repository.archive(item.id, false);
    expect(lifecycle().map((entry) => entry.kind)).toEqual(['archived']);

    // Completing a task that was already archived incomplete is a real transition.
    repository.archive(item.id, true);
    repository.archive(item.id, true);
    expect(lifecycle().map((entry) => entry.kind)).toEqual(['completed', 'archived']);
  });

  it('preserves local strategy, assignment, and priority during Linear sync', () => {
    const providerItem = {
      sourceIdentifier: 'ENG-42',
      sourceUrl: 'https://linear.app/example/issue/ENG-42',
      title: 'Initial title',
      description: '',
      status: 'ready' as const,
      priority: 2,
      projectName: 'Core',
      labels: ['frontend'],
      dueDate: null,
      providerUpdatedAt: '2026-08-18T10:00:00.000Z',
      providerPayload: {},
    };
    expect(repository.upsertLinearItem(providerItem)).toBe('imported');
    expect(repository.list()).toHaveLength(0);
    const item = repository.searchLinear('ENG-42')[0];
    repository.queueLinearItem(item.id);
    expect(repository.list()).toHaveLength(1);
    repository.update(item.id, { strategy: 'Codex plans; Claude reviews.', assignees: ['codex'], priority: 0 });

    repository.upsertLinearItem({
      ...providerItem,
      title: 'Updated in Linear',
      providerUpdatedAt: '2026-08-18T11:00:00.000Z',
    });
    const updated = repository.get(item.id)!;
    expect(updated.title).toBe('Updated in Linear');
    expect(updated.strategy).toBe('Codex plans; Claude reviews.');
    expect(updated.assignees).toEqual(['codex']);
    expect(updated.priority).toBe(0);
  });

  it('syncs terminal Linear status in an enclosing transaction without overwriting local fields', () => {
    const input = { sourceIdentifier: 'ENG-TERMINAL', sourceUrl: null, title: 'Provider item', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: [], dueDate: null, providerUpdatedAt: '2026-08-20T00:00:00.000Z', providerPayload: {} };
    repository.upsertLinearItem(input);
    const item = repository.searchLinear('ENG-TERMINAL')[0];
    repository.update(item.id, { strategy: 'Locally owned', priority: 0 });

    expect(repository.transaction(() => repository.upsertLinearItems([{ ...input, status: 'done' as const, providerUpdatedAt: '2026-08-21T00:00:00.000Z' }]))).toEqual(['updated']);
    expect(repository.get(item.id)).toEqual(expect.objectContaining({ status: 'done', strategy: 'Locally owned', priority: 0 }));
  });

  it('preserves a local Linear field edit and records a conflict only when Linear also changes it', () => {
    const input = { sourceIdentifier: 'ENG-43', sourceUrl: null, title: 'Provider title', description: 'Provider description', status: 'ready' as const, priority: 2, projectName: 'Core', labels: ['frontend'], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };
    repository.upsertLinearItem(input);
    const item = repository.searchLinear('ENG-43')[0];
    repository.update(item.id, { title: 'Local title' });
    repository.upsertLinearItem({ ...input, description: 'Provider description v2', providerUpdatedAt: '2026-08-18T11:00:00.000Z' });
    expect(repository.get(item.id)?.title).toBe('Local title');
    expect(repository.get(item.id)?.description).toBe('Provider description v2');
    expect(repository.listProviderConflicts(item.id)).toEqual([]);

    repository.upsertLinearItem({ ...input, title: 'Provider title v2', description: 'Provider description v2', providerUpdatedAt: '2026-08-18T12:00:00.000Z' });
    expect(repository.get(item.id)?.title).toBe('Local title');
    expect(repository.listProviderConflicts(item.id)).toEqual([expect.objectContaining({ field: 'title', localValue: 'Local title', providerValue: 'Provider title v2' })]);
    repository.resolveProviderConflict(item.id, 'title', 'use_provider');
    expect(repository.get(item.id)?.title).toBe('Provider title v2');
    expect(repository.listProviderConflicts(item.id)).toEqual([]);
  });

  it('preserves locally edited labels and exposes the provider value when they conflict', () => {
    const input = { sourceIdentifier: 'ENG-44', sourceUrl: null, title: 'Provider title', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: ['backend'], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };
    repository.upsertLinearItem(input);
    const item = repository.searchLinear('ENG-44')[0];
    repository.update(item.id, { labels: ['frontend', 'backend'] });
    repository.upsertLinearItem({ ...input, labels: ['api'], providerUpdatedAt: '2026-08-18T11:00:00.000Z' });

    expect(repository.get(item.id)?.labels).toEqual(['backend', 'frontend']);
    expect(repository.listProviderConflicts(item.id)).toEqual([expect.objectContaining({ field: 'labels', localValue: ['backend', 'frontend'], providerValue: ['api'] })]);
    repository.resolveProviderConflict(item.id, 'labels', 'keep_local');
    expect(repository.listProviderConflicts(item.id)).toEqual([]);
  });

  it('keeps a proposal side-effect-free until acceptance and rejects stale decisions', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const proposal = repository.createProposal([first.id, second.id], 'New context promotes the first task.');
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
    expect(repository.resolveProposal(proposal.id, 'accepted')?.status).toBe('accepted');
    expect(repository.list().map((item) => item.id)).toEqual([first.id, second.id]);
    const stale = repository.createProposal([second.id, first.id], 'Undo the move.');
    repository.move(second.id, { beforeId: first.id });
    expect(repository.resolveProposal(stale.id, 'rejected')?.status).toBe('superseded');
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('plans the Workbench roadmap without reordering the attention stack', () => {
    const attention = repository.create({ title: 'Customer task', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const fresh = repository.create({ title: 'Fresh Workbench task', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const stale = repository.create({ title: 'Stale Workbench task', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * 86_400_000).toISOString(), stale.id);

    const proposal = repository.buildDailyProposal(Date.now(), 'workbench');

    expect(proposal.stack).toBe('workbench');
    expect(repository.listWorkbench().map((item) => item.id)).toEqual([stale.id, fresh.id]);
    expect(repository.list().map((item) => item.id)).toEqual([attention.id]);
    expect(repository.getPendingProposal('workbench')?.id).toBe(proposal.id);
    expect(repository.getPendingProposal('attention')).toBeNull();
  });

  it('shares recent completed room context without synthesizing durable records', () => {
    const conversation = repository.createConversation('Queue operating model');
    repository.createSharedMessage('jeffrey', 'The queue order is the priority.', 'completed', conversation.id);
    repository.createSharedMessage('claude', 'Preserve yesterday’s order unless context changes.', 'completed', conversation.id);
    repository.createSharedMessage('codex', '', 'running', conversation.id);

    expect(repository.listSharedMessages().messages).toHaveLength(3);
    repository.setConversationArchived(conversation.id, true);
    const context = repository.getSharedContext();
    expect(context).toContain('jeffrey: The queue order is the priority.');
    expect(context).toContain('claude: Preserve yesterday’s order unless context changes.');
    expect(context).not.toContain('codex: ');
  });

  it('archives, restores, and forks conversations with their thread and task link', () => {
    const task = repository.create({ title: 'Conversation task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Original thread', task.id);
    repository.createSharedMessage('jeffrey', 'Investigate this', 'completed', conversation.id);
    repository.createSharedMessage('codex', 'Here are the findings', 'completed', conversation.id);

    expect(repository.setConversationArchived(conversation.id, true)?.archivedAt).toEqual(expect.any(String));
    expect(repository.get(task.id)).toEqual(expect.objectContaining({ archivedAt: expect.any(String), completionStatus: 'incomplete' }));
    expect(repository.listConversationPage(30, null, 'archive').conversations.map((item) => item.id)).toContain(conversation.id);
    expect(repository.listConversationPage(30, null, 'active').conversations.map((item) => item.id)).not.toContain(conversation.id);

    const fork = repository.forkConversation(conversation.id)!;
    expect(fork).toEqual(expect.objectContaining({ workItemId: task.id, forkedFromConversationId: conversation.id, archivedAt: null }));
    expect(repository.listSharedMessages(100, null, fork.id).messages.map((message) => message.body)).toEqual(['Investigate this', 'Here are the findings']);
    expect(repository.setConversationArchived(conversation.id, false)?.archivedAt).toBeNull();
  });

  it('unlinks the source conversation from its task when it is forked', () => {
    const task = repository.create({ title: 'Forked task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Original thread', task.id);
    repository.createSharedMessage('codex', 'Working on it.', 'completed', conversation.id);

    const fork = repository.forkConversation(conversation.id)!;
    expect(fork.workItemId).toBe(task.id);
    expect(repository.getConversation(conversation.id)?.workItemId).toBeNull();
    expect(repository.listActivity(task.id).some((activity) => activity.kind === 'conversation_unlinked')).toBe(true);
  });

  it('links and unlinks an existing conversation from a task', () => {
    const task = repository.create({ title: 'Link target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Manual thread');
    const reply = repository.createSharedMessage('codex', 'The implementation is complete.', 'completed', conversation.id);

    expect(repository.setConversationWorkItem(conversation.id, task.id)).toEqual(expect.objectContaining({ workItemId: task.id }));
    expect(repository.listRuns(task.id)).toEqual([expect.objectContaining({ agent: 'codex', messageId: reply.id, conversationId: conversation.id, output: reply.body, status: 'completed' })]);
    expect(repository.listActivity(task.id).some((entry) => entry.kind === 'conversation_linked')).toBe(true);
    expect(repository.setConversationWorkItem(conversation.id, null)).toEqual(expect.objectContaining({ workItemId: null }));
    expect(repository.listRuns(task.id)).toEqual([]);
    expect(repository.listActivity(task.id).some((entry) => entry.kind === 'conversation_unlinked')).toBe(true);
  });

  it('logs a model preference activity on the linked task when Jeffrey sets or clears a conversation tier', () => {
    const task = repository.create({ title: 'Model tier task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Tier thread', task.id);

    repository.setConversationExecutionProfile(conversation.id, 'deep');
    expect(repository.listActivity(task.id).some((entry) => entry.kind === 'model_preference' && entry.body.includes('deep'))).toBe(true);

    repository.setConversationExecutionProfile(conversation.id, null);
    expect(repository.listActivity(task.id).filter((entry) => entry.kind === 'model_preference')).toHaveLength(2);

    const before = repository.listActivity(task.id).length;
    repository.setConversationExecutionProfile(conversation.id, null);
    expect(repository.listActivity(task.id)).toHaveLength(before);
  });

  it('protects task-linked conversations from direct deletion and deletes them with their task', () => {
    const task = repository.create({ title: 'Owned conversation', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Task history', task.id);

    expect(repository.deleteConversation(conversation.id)).toBe(false);
    expect(repository.getConversation(conversation.id)).not.toBeNull();

    expect(repository.delete(task.id)).toBe(true);
    expect(repository.getConversation(conversation.id)).toBeNull();
  });

  it('summarizes conversation states for the navigation cards', () => {
    const working = repository.createConversation('Working thread');
    repository.createSharedMessage('codex', '', 'running', working.id);
    const failed = repository.createConversation('Failed thread');
    repository.createSharedMessage('claude', 'Stopped', 'canceled', failed.id);
    const finished = repository.createConversation('Finished thread');
    repository.createSharedMessage('codex', 'Done', 'completed', finished.id);
    const task = repository.create({ title: 'Approval task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const approval = repository.createConversation('Approval thread', task.id);
    repository.createSharedMessage('claude', 'Plan ready', 'completed', approval.id);
    repository.createExecutionPlan(task.id, 'Choose follow-ups.', [{ title: 'Follow-up', description: 'Do it.', workspacePath: null }]);

    const states = new Map(repository.listConversations().map((conversation) => [conversation.id, conversation.state]));
    expect(states.get(working.id)).toBe('working');
    expect(states.get(failed.id)).toBe('needs_attention');
    expect(states.get(finished.id)).toBe('finished');
    expect(states.get(approval.id)).toBe('waiting_approval');
    expect(repository.countUnreadConversations()).toBe(4);
    repository.markConversationRead(finished.id);
    expect(repository.countUnreadConversations()).toBe(3);
  });

  it('turns only selected execution-plan items into ordered queue tasks', () => {
    const parent = repository.create({ title: 'Large migration', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: '/tmp/project', dueDate: null });
    const plan = repository.createExecutionPlan(parent.id, 'Split the migration safely.', [
      { title: 'Inventory usage', description: 'Find every call site and record evidence.', workspacePath: null },
      { title: 'Implement migration', description: 'Change the implementation and verify tests.', workspacePath: null },
    ]);
    repository.resolveExecutionPlan(plan.id, 'accepted', [1]);

    expect(repository.get(parent.id)).toEqual(expect.objectContaining({ status: 'ready', archivedAt: null, completionStatus: 'incomplete' }));
    expect(repository.listArchived().map((item) => item.id)).not.toContain(parent.id);
    expect(repository.listWorkbench().map((item) => item.title)).toEqual(['Large migration', 'Implement migration']);
    expect(repository.listWorkbench()[1].workspacePath).toBe('/tmp/project');
    expect(repository.listWorkbench()[1].parentWorkItemId).toBe(parent.id);

    const archivalParent = repository.create({ title: 'Archive after split', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const archivalPlan = repository.createExecutionPlan(archivalParent.id, 'Archive deliberately.', [{ title: 'Child', description: 'Continue.', workspacePath: null }]);
    repository.resolveExecutionPlan(archivalPlan.id, 'accepted', undefined, true);
    expect(repository.get(archivalParent.id)?.archivedAt).toEqual(expect.any(String));
  });

  it('preserves relative order when daily context does not justify a move', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.buildDailyProposal();
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('moves ready work ahead of backlog work instead of tying nearly every task at zero', () => {
    const ready = repository.create({ title: 'Ready to execute', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const backlog = repository.create({ title: 'Still vague', description: '', priority: 2, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });

    const proposal = repository.buildDailyProposal();

    expect(proposal.previousOrder).toEqual([backlog.id, ready.id]);
    expect(proposal.proposedOrder).toEqual([ready.id, backlog.id]);
    expect(proposal.rationale).toContain('ready');
  });

  it('includes saved classifications in queue items', () => {
    const item = repository.create({ title: 'Implement the card', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(item.id, { kind: 'execute', agent: 'codex', complex: false, instructions: 'Implement it.' });

    expect(repository.list()[0]).toEqual(expect.objectContaining({ classificationKind: 'execute', classificationComplex: false }));
  });

  it('never clears a manually selected classification when task copy changes', () => {
    const item = repository.create({ title: 'Implement the card', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(item.id, { kind: 'review', agent: 'codex', complex: false, instructions: 'Review it.' }, 'manual');

    repository.update(item.id, { title: 'Implement and review the card', description: 'Updated details.' });

    expect(repository.getClassification(item.id)).toEqual(expect.objectContaining({ kind: 'review', source: 'manual' }));
  });

  it('clears an automatic classification when task copy changes', () => {
    const item = repository.create({ title: 'Investigate the card', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(item.id, { kind: 'research', agent: 'claude', complex: false, instructions: 'Research it.' });

    repository.update(item.id, { title: 'Implement the card' });

    expect(repository.getClassification(item.id)).toBeNull();
  });

  it('invalidates stale automatic classifications without invalidating manual choices', () => {
    const automatic = repository.create({ title: 'Publish the artifact', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const manual = repository.create({ title: 'Research the artifact', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(automatic.id, { kind: 'research', agent: 'claude', complex: false, instructions: 'Research it.' });
    repository.setClassification(manual.id, { kind: 'research', agent: 'claude', complex: false, instructions: 'Research it.' }, 'manual');
    database.prepare('UPDATE work_item_classifications SET classifier_version = 1').run();

    expect(repository.getClassification(automatic.id)).toBeNull();
    expect(repository.getClassification(manual.id)).toEqual(expect.objectContaining({ kind: 'research', source: 'manual' }));
  });

  it('does not misrepresent a generic chat run as a saved task classification', () => {
    const item = repository.create({ title: 'Legacy executed task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(item.id, 'research', 'auto', 'claude', 'Investigate it.');

    expect(repository.list()[0]).toEqual(expect.objectContaining({ classificationKind: null, classificationComplex: false }));
  });

  it('promotes tasks that have gone untouched for several days without resetting their age during reorder', () => {
    const old = repository.create({ title: 'Stale follow-up', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const recent = repository.create({ title: 'Recent task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(tenDaysAgo, old.id);

    const proposal = repository.buildDailyProposal();

    expect(proposal.rationale).toContain('10 days without activity');
    expect(repository.list().map((item) => item.id)).toEqual([recent.id, old.id]);
    repository.resolveProposal(proposal.id, 'accepted');
    expect(repository.list().map((item) => item.id)).toEqual([old.id, recent.id]);
    expect(repository.get(old.id)?.lastTouchedAt).toBe(tenDaysAgo);
    expect(repository.getPendingProposal()?.id).toBeUndefined();
  });

  it('records every ordering change and undoes them one step at a time', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const third = repository.create({ title: 'Third', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    expect(repository.list().map((item) => item.id)).toEqual([third.id, second.id, first.id]);

    repository.move(first.id, { beforeId: third.id });
    expect(repository.list().map((item) => item.id)).toEqual([first.id, third.id, second.id]);
    repository.move(second.id, { beforeId: first.id });
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id, third.id]);

    expect(repository.listQueueHistory().map((change) => change.actor)).toEqual(['jeffrey', 'jeffrey']);
    expect(repository.listQueueHistory()[0].reason).toContain('Second');

    expect(repository.undoLastQueueChange()?.items.map((item) => item.id)).toEqual([first.id, third.id, second.id]);
    expect(repository.undoLastQueueChange()?.items.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    expect(repository.undoLastQueueChange()).toBeNull();
  });

  it('skips ordering snapshots that no longer describe the stack instead of resurrecting tasks', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.move(first.id, { beforeId: second.id });
    repository.update(second.id, { status: 'done' });

    expect(repository.undoLastQueueChange()).toBeNull();
    expect(repository.list().map((item) => item.id)).toEqual([first.id]);
  });

  it('journals neither a no-op reorder nor the reseating that follows creating a task', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.reorder([second.id, first.id]);

    expect(repository.listQueueHistory()).toHaveLength(0);
    expect(repository.undoLastQueueChange()).toBeNull();
  });

  it('attaches a per-task explanation to every daily proposal', () => {
    const fresh = repository.create({ title: 'Fresh', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const stale = repository.create({ title: 'Stale', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 86_400_000).toISOString(), stale.id);
    repository.reorder([fresh.id, stale.id]);

    const proposal = repository.buildDailyProposal();

    expect(proposal.proposedOrder).toEqual([stale.id, fresh.id]);
    const explanation = proposal.explanations.find((entry) => entry.itemId === stale.id)!;
    expect(explanation.signals.map((signal) => signal.key)).toEqual(['status', 'aging']);
    expect(explanation.score).toBe(10);
    expect(explanation.previousPosition).toBe(2);
    expect(explanation.proposedPosition).toBe(1);
    expect(repository.getPendingProposal()?.explanations).toHaveLength(2);
  });

  it('demotes a parent that is waiting on its own open subtasks', () => {
    const parent = repository.create({ title: 'Parent epic', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const sibling = repository.create({ title: 'Independent work', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.create({ title: 'Subtask', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null, parentWorkItemId: parent.id });
    repository.reorder([parent.id, sibling.id, ...repository.list().map((item) => item.id).filter((id) => id !== parent.id && id !== sibling.id)]);

    const plan = repository.explainQueue();

    expect(plan.orderedItemIds[plan.orderedItemIds.length - 1]).toBe(parent.id);
    expect(plan.rationale).toContain('waiting on 1 open subtask');
  });

  it('promotes a task whose provider source changed since the last plan', () => {
    const quiet = repository.create({ title: 'Quiet', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const moved = repository.create({ title: 'Source moved', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.reorder([quiet.id, moved.id]);
    repository.buildDailyProposal();
    database.prepare('UPDATE work_items SET provider_updated_at = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), moved.id);

    const plan = repository.explainQueue();

    expect(plan.orderedItemIds).toEqual([moved.id, quiet.id]);
    expect(plan.rationale).toContain('source changed since the last plan');
  });

  it('learns from resolved proposals and reports the weight it applied', () => {
    const fresh = repository.create({ title: 'Fresh', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const stale = repository.create({ title: 'Stale', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 86_400_000).toISOString(), stale.id);
    repository.reorder([fresh.id, stale.id]);

    for (let round = 0; round < 3; round += 1) {
      const proposal = repository.buildDailyProposal();
      repository.resolveProposal(proposal.id, 'accepted');
      repository.reorder([fresh.id, stale.id]);
    }

    expect(repository.getQueueFeedbackWeights().get('aging')).toEqual({ weight: 1.3, accepted: 3, rejected: 0 });
    const plan = repository.explainQueue();
    expect(plan.explanations.find((entry) => entry.itemId === stale.id)?.signals.map((signal) => signal.key))
      .toEqual(['status', 'aging', 'feedback']);
  });

  it('stores source credentials without returning them in connection metadata', () => {
    repository.setSourceConnection('github', 'Work GitHub', { token: 'secret-token', query: 'org:writer' });
    expect(repository.getSourceSettings('github')).toEqual({ token: 'secret-token', query: 'org:writer' });
    expect(repository.listSourceConnections()).toEqual([expect.objectContaining({ provider: 'github', label: 'Work GitHub', connected: true })]);
    expect(JSON.stringify(repository.listSourceConnections())).not.toContain('secret-token');
    repository.removeSourceConnection('github');
    expect(repository.listSourceConnections()).toEqual([]);
  });

  it('distinguishes incomplete archives from completed archives and preserves conversation history', () => {
    const incomplete = repository.create({ title: 'Paused work', description: 'Useful context', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const completed = repository.create({ title: 'Shipped work', description: 'Finished context', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const archivedConversation = repository.getOrCreateWorkConversation(incomplete.id, incomplete.title);
    repository.createSharedMessage('claude', 'Useful archived report', 'completed', archivedConversation.id);
    repository.archive(incomplete.id, false);
    repository.archive(completed.id, true);

    expect(repository.list()).toEqual([]);
    expect(repository.get(incomplete.id)?.completionStatus).toBe('incomplete');
    expect(repository.get(completed.id)?.completionStatus).toBe('completed');
    expect(repository.get(completed.id)?.status).toBe('done');
    expect(repository.listConversations().some((conversation) => conversation.id === archivedConversation.id)).toBe(false);
    expect(repository.listSharedMessages(100, null, archivedConversation.id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'Useful archived report' })]));
    expect(repository.listSharedMessages().messages.filter((message) => message.pinned)).toEqual([]);
    expect(repository.getSharedContext()).toContain('Useful archived report');
  });

  describe('full-text search over shared conversations and messages', () => {
    it('ranks a matching message above an unrelated one and links back to its conversation', () => {
      const conversation = repository.createConversation('Queue redesign');
      repository.createSharedMessage('jeffrey', 'We should switch the queue to bm25 ranking.', 'completed', conversation.id);
      repository.createSharedMessage('claude', 'Unrelated note about lunch.', 'completed', conversation.id);

      const results = repository.searchShared('bm25');

      expect(results).toEqual([
        expect.objectContaining({ type: 'message', conversationId: conversation.id, conversationTitle: 'Queue redesign' }),
      ]);
    });

    it('matches a conversation title as well as message bodies', () => {
      const conversation = repository.createConversation('Search feature planning');
      repository.createSharedMessage('jeffrey', 'No matching keyword here.', 'completed', conversation.id);

      const results = repository.searchShared('planning');

      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'conversation', conversationId: conversation.id, conversationTitle: 'Search feature planning' }),
      ]));
    });

    it('returns an empty array for an empty or whitespace-only query', () => {
      repository.createConversation('Some conversation');
      expect(repository.searchShared('')).toEqual([]);
      expect(repository.searchShared('   ')).toEqual([]);
    });

    it('returns an empty array when nothing matches', () => {
      repository.createConversation('Some conversation');
      expect(repository.searchShared('zzz-no-such-token')).toEqual([]);
    });

    it('does not throw on FTS5 special characters in the query', () => {
      const conversation = repository.createConversation('Special characters');
      repository.createSharedMessage('jeffrey', 'A message with "quotes" and colons.', 'completed', conversation.id);

      expect(() => repository.searchShared('"quotes" AND OR NOT * : -- ;')).not.toThrow();
    });

    it('keeps the FTS index in sync when a message is edited or a conversation is deleted', () => {
      const conversation = repository.createConversation('Editable thread');
      const message = repository.createSharedMessage('jeffrey', 'original wording', 'completed', conversation.id);
      repository.updateSharedMessage(message.id, { body: 'updated wording' });

      expect(repository.searchShared('original')).toEqual([]);
      expect(repository.searchShared('updated')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'message', messageId: message.id }),
      ]));

      repository.deleteConversation(conversation.id);
      expect(repository.searchShared('updated')).toEqual([]);
    });
  });

  it('moves agent-owned work down and attention-ready work to the top', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const third = repository.create({ title: 'Third', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.moveForAttention(first.id, 'bottom', 'agent started');
    expect(repository.list().map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    repository.moveForAttention(first.id, 'top', 'agent finished');
    expect(repository.list().map((item) => item.id)).toEqual([first.id, third.id, second.id]);
  });

  it('balances automatic agent selection using recent and active load', () => {
    const task = repository.create({ title: 'Balanced task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(task.id, 'execute', 'auto', 'codex', 'first');
    expect(repository.selectBalancedAgent('codex')).toBe('claude');
    repository.createRun(task.id, 'execute', 'auto', 'claude', 'second');
    expect(repository.selectBalancedAgent('claude')).toBe('codex');
    repository.createRun(task.id, 'execute', 'codex', 'codex', 'explicit selection');
    // Explicit work still consumes capacity, even though it must not skew the historical auto split.
    expect(repository.selectBalancedAgent('claude')).toBe('claude');
  });

  it('routes an automatic shared-room turn away from an agent with an active reply', () => {
    const conversation = repository.createConversation('Balanced chat');
    repository.createSharedMessage('codex', 'Working', 'running', conversation.id);
    expect(repository.selectBalancedAgent('codex')).toBe('claude');
  });

  it('distinguishes explicit agent owners from automatic assignments', () => {
    const task = repository.create({ title: 'Owned task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.updateAutomaticAgentAssignees(task.id, ['codex']);
    expect(repository.getExplicitAgentAssignees(task.id)).toEqual([]);

    repository.update(task.id, { assignees: ['codex', 'claude'] });
    expect(repository.getExplicitAgentAssignees(task.id)).toEqual(['codex', 'claude']);
  });

  it('creates a manual follow-up immediately after its parent', () => {
    const parent = repository.create({ title: 'Parent', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    repository.create({ title: 'Existing next task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const followUp = repository.createFollowUp(parent.id, 'Follow-up', 'Carry this forward.');
    expect(followUp).toEqual(expect.objectContaining({ title: 'Follow-up', projectName: 'Connectors' }));
    expect(followUp?.parentWorkItemId).toBe(parent.id);
    expect(repository.list().map((item) => item.title)).toEqual(['Existing next task', 'Parent', 'Follow-up']);
  });

  it('lists a task graph of children, conversations, artifacts, and linked references', () => {
    const parent = repository.create({ title: 'Parent task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const followUp = repository.createFollowUp(parent.id, 'Follow-up', 'Carry this forward.');
    expect(repository.listChildren(parent.id).map((item) => item.id)).toEqual([followUp!.id]);

    const conversation = repository.createConversation('Attached thread', parent.id);
    expect(repository.listConversationsForWorkItem(parent.id).map((entry) => entry.id)).toEqual([conversation.id]);

    const linear = repository.addReference(parent.id, { type: 'linear_issue', url: 'https://linear.app/writer/issue/CON-1', title: 'CON-1' });
    const pr = repository.addReference(parent.id, { type: 'pull_request', url: 'https://github.com/org/repo/pull/9', title: '' });
    expect(pr.title).toBe('github.com');
    const references = repository.listReferences(parent.id);
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: linear.id, type: 'linear_issue', title: 'CON-1' }),
      expect.objectContaining({ id: pr.id, type: 'pull_request' }),
    ]));
    expect(repository.listActivity(parent.id).some((entry) => entry.kind === 'reference_added')).toBe(true);

    expect(repository.removeReference(parent.id, linear.id)).toBe(true);
    expect(repository.listReferences(parent.id).map((entry) => entry.id)).toEqual([pr.id]);
  });

  it('links existing tasks from either side without allowing duplicate or self links', () => {
    const first = repository.create({ title: 'First task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    repository.addTaskLink(first.id, second.id);
    repository.addTaskLink(second.id, first.id);

    expect(repository.listLinkedTasks(first.id).map((item) => item.id)).toEqual([second.id]);
    expect(repository.listLinkedTasks(second.id).map((item) => item.id)).toEqual([first.id]);
    expect(repository.listActivity(first.id).filter((entry) => entry.kind === 'task_linked')).toHaveLength(1);
    expect(() => repository.addTaskLink(first.id, first.id)).toThrow('cannot link to itself');
    expect(repository.removeTaskLink(second.id, first.id)).toBe(true);
    expect(repository.listLinkedTasks(first.id)).toEqual([]);
  });

  it('includes compact follow-up lineage in queue items', () => {
    const parent = repository.create({ title: 'Parent task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const openChild = repository.createFollowUp(parent.id, 'Open follow-up', '');
    const archivedChild = repository.createFollowUp(parent.id, 'Archived follow-up', '');
    repository.archive(archivedChild!.id, true);

    const items = repository.list();
    expect(items.find((item) => item.id === parent.id)?.lineage).toEqual({ parentTitle: null, followUpCount: 2, openFollowUpCount: 1 });
    expect(items.find((item) => item.id === openChild!.id)?.lineage).toEqual({ parentTitle: 'Parent task', followUpCount: 0, openFollowUpCount: 0 });
  });

  it('keeps children, conversations, and references reachable across archive and restore', () => {
    const parent = repository.create({ title: 'Archivable parent', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createFollowUp(parent.id, 'Follow-up', '');
    repository.createConversation('Linked thread', parent.id);
    repository.addReference(parent.id, { type: 'document', url: 'https://example.com/doc', title: 'Doc' });

    repository.archive(parent.id, true);
    expect(repository.listChildren(parent.id)).toHaveLength(1);
    expect(repository.listConversationsForWorkItem(parent.id)).toHaveLength(1);
    expect(repository.listConversationsForWorkItem(parent.id)[0].archivedAt).not.toBeNull();
    expect(repository.listReferences(parent.id)).toHaveLength(1);

    repository.restore(parent.id);
    expect(repository.listConversationsForWorkItem(parent.id)[0].archivedAt).toBeNull();
    expect(repository.listReferences(parent.id)).toHaveLength(1);
  });

  it('keeps messages and file references isolated by conversation', () => {
    const first = repository.createConversation('First thread');
    const second = repository.createConversation('Second thread');
    repository.createSharedMessage('jeffrey', 'Review this file', 'completed', first.id, [{ name: 'App.tsx', path: '/tmp/App.tsx', mimeType: 'text/plain', size: 42 }]);
    repository.createSharedMessage('jeffrey', 'Separate context', 'completed', second.id);
    expect(repository.listSharedMessages(100, null, first.id).messages).toEqual([expect.objectContaining({ body: 'Review this file', attachments: [expect.objectContaining({ name: 'App.tsx' })] })]);
    expect(repository.listSharedMessages(100, null, second.id).messages).toHaveLength(1);
  });

  it('paginates shared messages in stable chronological order beyond the old 100-message cap', () => {
    const conversation = repository.createConversation('Long thread');
    const created = Array.from({ length: 5 }, (_, index) => repository.createSharedMessage('jeffrey', `message ${index}`, 'completed', conversation.id));

    const firstPage = repository.listSharedMessages(2, null, conversation.id);
    expect(firstPage.messages.map((message) => message.body)).toEqual(['message 3', 'message 4']);
    expect(firstPage.totalCount).toBe(5);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = repository.listSharedMessages(2, firstPage.nextCursor, conversation.id);
    expect(secondPage.messages.map((message) => message.body)).toEqual(['message 1', 'message 2']);
    expect(secondPage.nextCursor).toBeTruthy();

    const thirdPage = repository.listSharedMessages(2, secondPage.nextCursor, conversation.id);
    expect(thirdPage.messages.map((message) => message.body)).toEqual(['message 0']);
    expect(thirdPage.nextCursor).toBeNull();

    expect(repository.listAllSharedMessages(conversation.id).map((message) => message.id)).toEqual(created.map((message) => message.id));
    expect(() => repository.listSharedMessages(2, 'not-a-real-cursor', conversation.id)).toThrow('Invalid message cursor.');
  });

  it('persists queued chat turns with their requested agent target', () => {
    const conversation = repository.createConversation('Queued thread');
    const message = repository.createSharedMessage('jeffrey', 'Do this next', 'queued', conversation.id, [], 'both');
    expect(repository.nextQueuedSharedTurn(conversation.id)).toEqual({ message, dispatchTarget: 'both' });
    repository.updateSharedMessage(message.id, { status: 'completed' });
    expect(repository.nextQueuedSharedTurn(conversation.id)).toBeNull();
  });

  it('does not dispatch or cancel a queued turn while the same agent is active', () => {
    const conversation = repository.createConversation('Busy thread');
    const running = repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const queued = repository.createSharedMessage('jeffrey', 'Do this afterward', 'queued', conversation.id, [], 'codex');

    expect(dispatchNextSharedTurn(repository, conversation.id)).toEqual([]);
    expect(repository.listSharedMessages(100, null, conversation.id).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running.id, status: 'running' }),
      expect.objectContaining({ id: queued.id, status: 'queued' }),
    ]));
  });

  it('makes a turn addressed to a different agent eligible while another agent is busy', () => {
    const conversation = repository.createConversation('Busy thread, different target');
    repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const queued = repository.createSharedMessage('jeffrey', 'Claude, take this', 'queued', conversation.id, [], 'claude');

    expect(repository.nextQueuedSharedTurn(conversation.id, new Set(['codex']))).toEqual({ message: queued, dispatchTarget: 'claude' });
    expect(repository.nextQueuedSharedTurn(conversation.id, new Set(['codex', 'claude']))).toBeNull();
  });

  it('promotes a queued turn ahead of earlier-queued turns in the same conversation', () => {
    const conversation = repository.createConversation('Queue jump');
    repository.createSharedMessage('jeffrey', 'First in line', 'queued', conversation.id, [], 'claude');
    const second = repository.createSharedMessage('jeffrey', 'Second in line', 'queued', conversation.id, [], 'claude');
    expect(repository.promoteQueuedSharedMessage(second.id)).toEqual(expect.objectContaining({ id: second.id }));
    expect(repository.nextQueuedSharedTurn(conversation.id)).toEqual(expect.objectContaining({ message: expect.objectContaining({ id: second.id }) }));
  });

  it('does not promote a message that is not queued', () => {
    const conversation = repository.createConversation('Not queued');
    const completed = repository.createSharedMessage('jeffrey', 'Already answered', 'completed', conversation.id);
    expect(repository.promoteQueuedSharedMessage(completed.id)).toBeNull();
  });

  it('cancels a queued message before it dispatches, without touching a running reply', () => {
    const conversation = repository.createConversation('Cancel queued');
    const queued = repository.createSharedMessage('jeffrey', 'Never mind', 'queued', conversation.id, [], 'claude');
    const canceled = cancelSharedReply(repository, queued.id);
    expect(canceled).toEqual(expect.objectContaining({ id: queued.id, status: 'canceled' }));
    expect(repository.nextQueuedSharedTurn(conversation.id)).toBeNull();
  });

  it('durably cancels the task run linked to a canceled chat reply', () => {
    const task = repository.create({ title: 'Fix cancellation', description: '', priority: 2, status: 'in_progress', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(task.id, task.title);
    const reply = repository.createSharedMessage('claude', 'Working', 'running', conversation.id);
    const run = repository.createRun(task.id, 'execute', 'claude', 'claude', 'Fix it', conversation.id, reply.id);
    repository.updateRun(run.id, { status: 'running' });

    cancelSharedReply(repository, reply.id);

    expect(repository.getRun(run.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
    expect(repository.listSharedMessages(100, null, conversation.id).messages.find((message) => message.id === reply.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
  });

  it('cancels a legacy chat run that predates durable reply linkage', () => {
    const task = repository.create({ title: 'Fix legacy cancellation', description: '', priority: 2, status: 'in_progress', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(task.id, task.title);
    const reply = repository.createSharedMessage('claude', 'Working', 'running', conversation.id);
    const run = repository.createRun(task.id, 'analysis', 'claude', 'claude', 'Continue', conversation.id);
    repository.updateRun(run.id, { status: 'running' });

    cancelSharedReply(repository, reply.id);

    expect(repository.getRun(run.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
  });

  it('paginates conversations in stable updated order', () => {
    repository.createConversation('First');
    repository.createConversation('Second');
    repository.createConversation('Third');
    const firstPage = repository.listConversationPage(2, null);
    expect(firstPage.conversations).toHaveLength(2);
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = repository.listConversationPage(2, firstPage.nextCursor);
    expect(secondPage.conversations).toHaveLength(1);
    expect(new Set([...firstPage.conversations, ...secondPage.conversations].map((conversation) => conversation.title))).toEqual(new Set(['First', 'Second', 'Third']));
    expect(secondPage.nextCursor).toBeNull();
  });

  it('puts queued and running conversations ahead of more recently updated idle conversations', () => {
    const working = repository.createConversation('Working first');
    repository.createSharedMessage('claude', 'On it.', 'queued', working.id);
    const idle = repository.createConversation('Recent idle');

    expect(repository.listConversationPage(30, null).conversations.map((conversation) => conversation.id)).toEqual([working.id, idle.id]);
  });

  it('reports active and archive counts independently of pagination', () => {
    repository.create({ title: 'Active', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const archived = repository.create({ title: 'Archived', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.archive(archived.id, false);
    expect(repository.getWorkItemCounts()).toEqual({ active: 1, workbench: 0, archive: 1 });
  });

  it('keeps Workbench roadmap tasks in an independently ordered stack', () => {
    const attention = repository.create({ title: 'Customer task', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const first = repository.create({ title: 'Workbench one', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Workbench two', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.move(first.id, { beforeId: second.id });
    expect(repository.list().map((item) => item.id)).toEqual([attention.id]);
    expect(repository.listWorkbench().map((item) => item.id)).toEqual([first.id, second.id]);
    expect(repository.getWorkItemCounts()).toEqual({ active: 1, workbench: 2, archive: 0 });
  });

  it('deduplicates discoveries and only creates a task after approval', () => {
    const run = repository.startDiscoveryRun();
    expect(repository.upsertDiscoveryCandidate({ fingerprint: 'same', provider: 'slack', title: 'Review proposal', description: 'Jeffrey was mentioned.', sourceUrl: 'https://writer.slack.com/a', occurredAt: null, runId: run.id })).toBe(true);
    expect(repository.upsertDiscoveryCandidate({ fingerprint: 'same', provider: 'slack', title: 'Review updated proposal', description: 'New context', sourceUrl: 'https://writer.slack.com/a', occurredAt: null, runId: run.id })).toBe(false);
    repository.finishDiscoveryRun(run.id, 1, []);
    const inbox = repository.getDiscoveryInbox();
    expect(inbox.pendingCount).toBe(1);
    expect(repository.list()).toHaveLength(0);
    const resolved = repository.resolveDiscoveryCandidate(inbox.candidates[0].id, 'convert')!;
    expect(resolved.status).toBe('converted');
    expect(repository.list()).toEqual([expect.objectContaining({ title: 'Review updated proposal', sourceUrl: 'https://writer.slack.com/a' })]);
  });

  it('suggests updating an existing task when discovery resolves to the same source URL', () => {
    const existing = repository.create({ title: 'Review connector PR', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null, sourceUrl: 'https://github.com/writer/repo/pull/42' });
    const run = repository.startDiscoveryRun();
    repository.upsertDiscoveryCandidate({ fingerprint: 'pr-42', provider: 'github', title: 'Please review PR 42', description: 'New review request', sourceUrl: existing.sourceUrl, occurredAt: null, runId: run.id, relevance: 2 });

    expect(repository.getDiscoveryInbox().candidates[0]).toEqual(expect.objectContaining({ suggestedWorkItemId: existing.id, relevance: 2 }));
  });

  it('edits, merges, and bulk resolves pending discoveries', () => {
    const target = repository.create({ title: 'Existing task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const run = repository.startDiscoveryRun();
    for (const [fingerprint, title] of [['one', 'First signal'], ['two', 'Second signal'], ['three', 'Third signal']]) {
      repository.upsertDiscoveryCandidate({ fingerprint, provider: 'linear', title, description: '', sourceUrl: `https://linear.app/${fingerprint}`, occurredAt: null, runId: run.id });
    }
    const candidates = repository.getDiscoveryInbox().candidates;
    const first = candidates.find((candidate) => candidate.title === 'First signal')!;
    const second = candidates.find((candidate) => candidate.title === 'Second signal')!;
    const third = candidates.find((candidate) => candidate.title === 'Third signal')!;
    expect(repository.updateDiscoveryCandidate(first.id, { title: 'Edited signal', description: 'Useful context' })).toEqual(expect.objectContaining({ title: 'Edited signal', description: 'Useful context' }));
    expect(repository.resolveDiscoveryCandidate(second.id, 'merge', target.id)).toEqual(expect.objectContaining({ status: 'merged', workItemId: target.id }));
    expect(repository.listActivity(target.id).some((entry) => entry.body.includes('Second signal'))).toBe(true);
    expect(repository.get(target.id)?.sourceTags).toEqual(['Linear']);
    expect(repository.resolveDiscoveryCandidates([first.id, third.id], 'dismiss').map((candidate) => candidate.status)).toEqual(['dismissed', 'dismissed']);
    expect(repository.getDiscoveryInbox().pendingCount).toBe(0);
    expect(repository.getDiscoveryInbox('reviewed').reviewedCount).toBe(3);
    expect(repository.restoreDiscoveryCandidate(first.id)).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(repository.getDiscoveryInbox().candidates.map((candidate) => candidate.id)).toContain(first.id);
    expect(repository.restoreDiscoveryCandidate(second.id)).toBeNull();
  });

  describe('claim/retry primitives', () => {
    it('retries a failed task run in place without creating a second run or chat reply', () => {
      const item = repository.create({ title: 'Retry in place', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
      const message = repository.createSharedMessage('codex', 'Partial output', 'failed', conversation.id);
      const run = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Continue', conversation.id, message.id);
      repository.updateRun(run.id, { status: 'failed', error: 'Agent process stopped reporting progress.' });

      const retried = repository.prepareRunRetry(run.id);

      expect(retried?.id).toBe(run.id);
      expect(retried?.status).toBe('queued');
      expect(repository.listRuns(item.id)).toHaveLength(1);
      expect(repository.listAllSharedMessages(conversation.id).filter((entry) => entry.author === 'codex')).toHaveLength(1);
      expect(repository.getSharedMessageById(message.id)?.status).toBe('running');

      repository.updateRun(run.id, { status: 'completed' });
      repository.updateSharedMessage(message.id, { status: 'completed' });
      expect(repository.getRun(run.id)?.error).toBe('');
      expect(repository.getSharedMessageById(message.id)?.error).toBe('');
    });

    function createQueuedRun() {
      const item = repository.create({ title: 'Reliability task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      return repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    }

    it('claimRun is atomic: only one of two concurrent claimants wins', () => {
      const run = createQueuedRun();
      expect(repository.claimRun(run.id, 'owner-a', 60_000)).toBe(true);
      expect(repository.claimRun(run.id, 'owner-b', 60_000)).toBe(false);
      expect(repository.getRun(run.id)?.status).toBe('running');
    });

    it('a run reclaimed after its lease expired can be claimed by a new owner', () => {
      // claimRun only matches status = 'queued': once claimed, a run is 'running' and
      // a second direct claimRun always loses, by design. An expired lease is instead
      // surfaced by reclaimExpired(), which resets status back to 'queued' so a fresh
      // claim can succeed.
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', -1); // lease already expired
      repository.reclaimExpired(0);
      expect(repository.claimRun(run.id, 'owner-b', 60_000)).toBe(true);
    });

    it('claimRun refuses a run that is not queued', () => {
      const run = createQueuedRun();
      repository.updateRun(run.id, { status: 'completed' });
      expect(repository.claimRun(run.id, 'owner-a', 60_000)).toBe(false);
    });

    it('lets only the current uncanceled owner finish a running attempt', () => {
      const run = createQueuedRun();
      expect(repository.claimRun(run.id, 'owner-a', 60_000)).toBe(true);
      expect(repository.finishRun(run.id, 'owner-b', { status: 'completed' })).toBe(false);
      expect(repository.requestRunCancellation(run.id)).toBe(true);
      expect(repository.isCancellationRequested(run.id)).toBe(true);
      expect(repository.finishRun(run.id, 'owner-a', { status: 'completed' })).toBe(false);
      expect(repository.getRun(run.id)?.status).toBe('running');
    });

    it('clears durable cancellation when a canceled run is prepared for retry', () => {
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', 60_000);
      repository.requestRunCancellation(run.id);
      repository.updateRun(run.id, { status: 'canceled', completedAt: new Date().toISOString() });

      const retried = repository.prepareRunRetry(run.id);

      expect(retried?.status).toBe('queued');
      expect(repository.isCancellationRequested(run.id)).toBe(false);
      expect(database.prepare('SELECT cancel_requested, cancel_requested_at FROM agent_runs WHERE id = ?').get(run.id)).toEqual({
        cancel_requested: 0,
        cancel_requested_at: null,
      });
      expect(repository.claimRun(run.id, 'owner-b', 60_000)).toBe(true);
      expect(repository.renewRunLease(run.id, 'owner-b', 60_000)).toBe(true);
    });

    it('scheduleRunRetry re-queues with an incremented attempt and clears ownership, up to max_attempts', () => {
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', 60_000);
      expect(repository.scheduleRunRetry(run.id, 'owner-a', 5_000)).toBe(true);
      const retried = repository.getRun(run.id)!;
      expect(retried.status).toBe('queued');
      expect(retried.attempt).toBe(1);
      expect(retried.nextAttemptAt).not.toBeNull();
      repository.claimRun(run.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(run.id, 'owner-a', 0);
      expect(repository.getRun(run.id)?.attempt).toBe(2);
      // Third retry would hit max_attempts (default 3): refuse further retry.
      repository.claimRun(run.id, 'owner-a', 60_000);
      expect(repository.scheduleRunRetry(run.id, 'owner-a', 0)).toBe(false);
    });

    it('reclaimExpired retries a non-execute run whose lease expired and fails an execute run instead', () => {
      const analysisRun = createQueuedRun();
      repository.claimRun(analysisRun.id, 'dead-owner', -1);
      const item = repository.create({ title: 'Filesystem edit', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const executeRun = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
      repository.claimRun(executeRun.id, 'dead-owner', -1);

      const result = repository.reclaimExpired(0);
      expect(result.recoveredRunIds).toContain(analysisRun.id);
      expect(result.failedRunIds).toContain(executeRun.id);
      expect(repository.getRun(analysisRun.id)?.status).toBe('queued');
      expect(repository.getRun(executeRun.id)?.status).toBe('failed');
      expect(repository.getRun(executeRun.id)?.error).toMatch(/stopped reporting progress/);
    });

    it('does not mark a linked chat failed while its interrupted run is being retried', () => {
      const item = repository.create({ title: 'Recover linked reply', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
      const message = repository.createSharedMessage('codex', 'Partial response', 'running', conversation.id);
      const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '', conversation.id, message.id);
      repository.claimRun(run.id, 'dead-owner', -1);
      repository.claimSharedMessage(message.id, 'dead-owner', -1);

      repository.reclaimExpired(0);

      expect(repository.getRun(run.id)?.status).toBe('queued');
      expect(repository.getSharedMessageById(message.id)?.status).toBe('running');
      expect(repository.getSharedMessageById(message.id)?.error).toBe('');
    });

    it('dueWork returns queued runs with no future next_attempt_at and excludes scheduled retries not yet due', () => {
      const dueRun = createQueuedRun();
      const notYetDueRun = createQueuedRun();
      repository.claimRun(notYetDueRun.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(notYetDueRun.id, 'owner-a', 60_000); // due far in the future
      expect(repository.dueWork().runIds).toContain(dueRun.id);
      expect(repository.dueWork().runIds).not.toContain(notYetDueRun.id);
    });

    it('dueWork(limit) returns only the oldest N queued runs when the backlog exceeds the ceiling', () => {
      const runs = [createQueuedRun(), createQueuedRun(), createQueuedRun(), createQueuedRun(), createQueuedRun()];
      const due = repository.dueWork(2).runIds;
      expect(due).toHaveLength(2);
      expect(due).toEqual([runs[0].id, runs[1].id]);
    });

    it('dueWork(limit) returns nothing once the running count already meets the ceiling', () => {
      const runningA = createQueuedRun();
      const runningB = createQueuedRun();
      createQueuedRun(); // still queued, would otherwise be due
      repository.claimRun(runningA.id, 'owner-a', 60_000);
      repository.claimRun(runningB.id, 'owner-b', 60_000);

      expect(repository.dueWork(2).runIds).toEqual([]);
    });

    it('dueWork(limit) frees up capacity as running runs complete', () => {
      const runningA = createQueuedRun();
      const queuedB = createQueuedRun();
      const queuedC = createQueuedRun();
      repository.claimRun(runningA.id, 'owner-a', 60_000);

      // One slot free (ceiling 2, one running): only the oldest queued run is due.
      expect(repository.dueWork(2).runIds).toEqual([queuedB.id]);

      repository.updateRun(runningA.id, { status: 'completed' });

      // Both slots free now: both remaining queued runs are due, oldest first.
      expect(repository.dueWork(2).runIds).toEqual([queuedB.id, queuedC.id]);
    });

    it('hasLiveWork reflects queued/running rows regardless of which process created them', () => {
      expect(repository.hasLiveWork()).toBe(false);
      createQueuedRun();
      expect(repository.hasLiveWork()).toBe(true);
    });

    it('activeRunsForItem lists only queued/running runs for dedup guards', () => {
      const item = repository.create({ title: 'Dedup task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
      expect(repository.activeRunsForItem(item.id)).toHaveLength(1);
      repository.updateRun(run.id, { status: 'completed' });
      expect(repository.activeRunsForItem(item.id)).toHaveLength(0);
    });

    it('claimQueuedTurn promotes a queued jeffrey message exactly once', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('jeffrey', 'hi', 'queued', conversation.id);
      expect(repository.claimQueuedTurn(message.id)).toBe(true);
      expect(repository.claimQueuedTurn(message.id)).toBe(false);
      expect(repository.listSharedMessages(10, null, conversation.id).messages.find((entry) => entry.id === message.id)?.status).toBe('completed');
    });

    it('renewLeases extends only the caller-owned, still-live leases', () => {
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', 1_000);
      const before = repository.getRun(run.id);
      repository.renewLeases('owner-a', 60_000);
      // Renewing does not change status; this asserts renewal does not throw and leaves status running.
      expect(repository.getRun(run.id)?.status).toBe('running');
      expect(before?.status).toBe('running');
    });

    it('claimSharedMessage acquires a lease and prevents double-claim', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', '', 'running', conversation.id);
      expect(repository.claimSharedMessage(message.id, 'owner-a', 60_000)).toBe(true);
      expect(repository.listSharedMessages(10, null, conversation.id).messages.find((m) => m.id === message.id)?.status).toBe('running');
      // Second claim by a different owner fails.
      expect(repository.claimSharedMessage(message.id, 'owner-b', 60_000)).toBe(false);
    });

    it('reclaimExpired marks shared messages with expired leases as failed', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', 'partial output', 'running', conversation.id);
      // Claim with negative lease (already expired).
      repository.claimSharedMessage(message.id, 'dead-owner', -1);

      const result = repository.reclaimExpired(0);
      expect(result.recoveredMessageIds).toContain(message.id);
      const recovered = repository.listSharedMessages(10, null, conversation.id).messages.find((m) => m.id === message.id);
      expect(recovered?.status).toBe('failed');
      expect(recovered?.error).toMatch(/stopped reporting progress/);
      expect(recovered?.body).toBe('partial output'); // Partial output is preserved for inspection.
    });
  });

  describe('audit log', () => {
    it('records and lists append-only audit entries, newest first', () => {
      repository.addAuditEntry('outbound_call', 'linear', 'POST https://api.linear.app/graphql');
      repository.addAuditEntry('agent_file_read', 'codex', 'src/index.ts');
      const page = repository.listAuditLog();
      expect(page.entries).toHaveLength(2);
      expect(page.entries[0]).toMatchObject({ category: 'agent_file_read', source: 'codex', detail: 'src/index.ts' });
      expect(page.entries[1]).toMatchObject({ category: 'outbound_call', source: 'linear' });
      expect(page.nextCursor).toBeNull();
    });

    it('associates an audit entry with a work item and survives its deletion via SET NULL', () => {
      const item = repository.create({ title: 'Task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      repository.addAuditEntry('agent_file_write', 'claude', 'src/app.ts', item.id);
      expect(repository.listAuditLog(100, null, undefined, item.id).entries).toHaveLength(1);
      expect(repository.listAuditLog(100, null, 'agent_file_write').entries).toHaveLength(1);
      expect(repository.listAuditLog(100, null, 'agent_tool_use').entries).toHaveLength(0);
    });

    it('paginates with a bounded cursor and rejects an invalid one', () => {
      for (let index = 0; index < 5; index += 1) repository.addAuditEntry('outbound_call', 'slack', `call ${index}`);
      const firstPage = repository.listAuditLog(2);
      expect(firstPage.entries).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = repository.listAuditLog(2, firstPage.nextCursor);
      expect(secondPage.entries).toHaveLength(2);
      expect(secondPage.entries.map((entry) => entry.detail)).not.toEqual(firstPage.entries.map((entry) => entry.detail));
      expect(() => repository.listAuditLog(2, 'not-a-real-cursor')).toThrow('Invalid audit log cursor.');
    });
  });

  describe('stack ownership', () => {
    const make = (title: string, projectName: string | null, stack?: 'attention' | 'workbench') =>
      repository.create({ title, description: '', priority: 2, status: 'ready', projectName, stack, workspacePath: null, dueDate: null });

    it('seeds the stack from the project name once, then stores it explicitly', () => {
      expect(make('Build it', 'Workbench').stack).toBe('workbench');
      expect(make('Ship it', 'Writer').stack).toBe('attention');
      expect(make('No project', null).stack).toBe('attention');
      // Case-insensitively, matching the predicate this replaced.
      expect(make('Lowercase', 'workbench').stack).toBe('workbench');
    });

    it('honours an explicit stack over the project name', () => {
      expect(make('Explicit attention', 'Workbench', 'attention').stack).toBe('attention');
      expect(make('Explicit workbench', 'Writer', 'workbench').stack).toBe('workbench');
      expect(repository.listWorkbench().map((item) => item.title)).toEqual(['Explicit workbench']);
      expect(repository.list().map((item) => item.title)).toEqual(['Explicit attention']);
    });

    it('does not move a task between stacks when its project is renamed', () => {
      const item = make('Roadmap work', 'Workbench');
      expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([item.id]);

      const renamed = repository.update(item.id, { projectName: 'Workbench Platform' })!;

      expect(renamed.stack).toBe('workbench');
      expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([item.id]);
      expect(repository.list()).toHaveLength(0);
      expect(repository.getWorkItemCounts()).toEqual(expect.objectContaining({ active: 0, workbench: 1 }));
    });

    it('does not pull a task into the workbench stack by naming its project Workbench', () => {
      const item = make('Attention work', 'Writer');
      const renamed = repository.update(item.id, { projectName: 'Workbench' })!;

      expect(renamed.stack).toBe('attention');
      expect(repository.listWorkbench()).toHaveLength(0);
      expect(repository.list().map((entry) => entry.id)).toEqual([item.id]);
    });

    it('moves a task only on an explicit stack change and reseats its queue position', () => {
      const first = make('Workbench first', 'Workbench');
      const second = make('Workbench second', 'Workbench');
      const attention = make('Attention only', null);

      const moved = repository.update(second.id, { stack: 'attention' })!;

      expect(moved.stack).toBe('attention');
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([first.id]);
      // Reseated at the top of its new stack rather than keeping a position
      // that belonged to the stack it left.
      expect(repository.list().map((item) => item.id)).toEqual([second.id, attention.id]);
      expect(repository.listActivity(second.id).some((entry) => entry.kind === 'stack_changed')).toBe(true);
    });

    it('keeps the stack local when Linear sync rewrites the project name', () => {
      repository.upsertLinearItem({
        sourceIdentifier: 'CON-1', sourceUrl: null, title: 'Imported', description: '', status: 'ready',
        priority: 2, projectName: 'Workbench', labels: [], dueDate: null,
        providerUpdatedAt: '2026-08-20T09:00:00.000Z', providerPayload: {},
      });
      const imported = repository.searchLinear('Imported')[0];
      // A provider project literally named "Workbench" no longer captures the task.
      expect(imported.stack).toBe('attention');

      repository.queueLinearItem(imported.id);
      repository.update(imported.id, { stack: 'workbench' });
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([imported.id]);

      repository.upsertLinearItem({
        sourceIdentifier: 'CON-1', sourceUrl: null, title: 'Imported', description: '', status: 'ready',
        priority: 2, projectName: 'Something Else', labels: [], dueDate: null,
        providerUpdatedAt: '2026-08-20T10:00:00.000Z', providerPayload: {},
      });

      const synced = repository.get(imported.id)!;
      expect(synced.projectName).toBe('Something Else');
      expect(synced.stack).toBe('workbench');
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([imported.id]);
    });

    it('gives follow-ups and approved plan children the parent stack, not its project name', () => {
      const parent = make('Parent', 'Writer', 'workbench');
      const followUp = repository.createFollowUp(parent.id, 'Follow up', '')!;
      expect(followUp.stack).toBe('workbench');
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([parent.id, followUp.id]);

      const plan = repository.createExecutionPlan(parent.id, 'Split it.', [
        { title: 'Child task', description: 'Do the work.', workspacePath: null },
      ]);
      repository.resolveExecutionPlan(plan.id, 'accepted');
      expect(repository.listWorkbench().map((item) => item.title)).toContain('Child task');
      expect(repository.listWorkbench().every((item) => item.stack === 'workbench')).toBe(true);
    });

    it('restores an archived task to the stack it was archived from', () => {
      const item = make('Archived roadmap task', 'Writer', 'workbench');
      repository.archive(item.id, false);
      expect(repository.listWorkbench()).toHaveLength(0);

      const restored = repository.restore(item.id)!;
      expect(restored.stack).toBe('workbench');
      expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([item.id]);
      expect(repository.list()).toHaveLength(0);
    });

    it('moves tasks in bulk through set_stack and renumbers both stacks', () => {
      const first = make('First', 'Workbench');
      const second = make('Second', 'Workbench');
      const attention = make('Attention', null);

      const result = repository.bulkUpdate({ action: 'set_stack', ids: [first.id, second.id], stack: 'attention' });

      expect(result.conflicts).toEqual([]);
      expect(result.appliedIds).toEqual([first.id, second.id]);
      expect(repository.listWorkbench()).toHaveLength(0);
      expect(repository.list().map((item) => item.id)).toEqual([first.id, second.id, attention.id]);
      expect(repository.list().map((item) => item.queuePosition)).toEqual([1, 2, 3]);
    });

    it('leaves a bulk project rename from moving anything between stacks', () => {
      const item = make('Roadmap', 'Workbench');
      repository.bulkUpdate({ action: 'set_project', ids: [item.id], projectName: 'Renamed' });

      expect(repository.get(item.id)!.stack).toBe('workbench');
      expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([item.id]);
    });

    it('logs an edit entry for each item touched by a bulk status or assignee change', () => {
      const first = make('First', 'Workbench');
      const second = make('Second', 'Workbench');

      repository.bulkUpdate({ action: 'set_status', ids: [first.id, second.id], status: 'in_progress' });
      expect(repository.listActivity(first.id).some((entry) => entry.kind === 'edited')).toBe(true);
      expect(repository.listActivity(second.id).some((entry) => entry.kind === 'edited')).toBe(true);

      repository.bulkUpdate({ action: 'set_assignees', ids: [first.id], assignees: ['codex'] });
      expect(repository.listActivity(first.id).filter((entry) => entry.kind === 'edited')).toHaveLength(2);

      repository.bulkUpdate({ action: 'set_project', ids: [first.id], projectName: 'Renamed' });
      expect(repository.listActivity(first.id).filter((entry) => entry.kind === 'edited')).toHaveLength(3);
    });

    it('rejects a stack value outside the allowed set at the database boundary', () => {
      const item = make('Guarded', null);
      expect(() => database.prepare('UPDATE work_items SET stack = ? WHERE id = ?').run('nonsense', item.id))
        .toThrow(/CHECK constraint failed/);
    });
  });

describe('task dependencies', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

  const makeTask = (title: string) => repository.create({
    title, description: 'Original brief.', priority: 1, status: 'ready',
    projectName: 'Workbench', workspacePath: null, dueDate: null,
  });

    const make = (title: string) => repository.create({
      title, description: '', priority: 2, status: 'ready',
      projectName: 'Workbench', workspacePath: null, dueDate: null,
    });

    it('records prerequisites and reports them on every queue read', () => {
      const blocker = make('Schema first');
      const dependent = make('API second');

      expect(repository.replaceDependencies(dependent.id, [blocker.id]).map((entry) => entry.id)).toEqual([blocker.id]);
      expect(repository.get(dependent.id)!.blockedBy).toEqual([
        expect.objectContaining({ id: blocker.id, title: 'Schema first', isOpen: true }),
      ]);
      // The list read must carry the same edges, or the queue UI would show a
      // blocked task as dispatchable. These tasks carry the "Workbench" project
      // name, so create() seats them in the workbench stack rather than attention.
      expect(repository.listWorkbench().find((entry) => entry.id === dependent.id)!.blockedBy)
        .toEqual([expect.objectContaining({ id: blocker.id })]);
      expect(repository.get(blocker.id)!.blockedBy).toEqual([]);
    });

    it('closes the gate only when a prerequisite reaches a terminal state', () => {
      const blocker = make('Schema first');
      const dependent = make('API second');
      repository.replaceDependencies(dependent.id, [blocker.id]);

      expect(repository.listOpenDependencies(dependent.id)).toHaveLength(1);

      repository.update(blocker.id, { status: 'in_progress' });
      expect(repository.listOpenDependencies(dependent.id)).toHaveLength(1);

      repository.update(blocker.id, { status: 'done' });
      expect(repository.listOpenDependencies(dependent.id)).toHaveLength(0);
      expect(repository.listDependencies(dependent.id)).toEqual([
        expect.objectContaining({ id: blocker.id, isOpen: false }),
      ]);
    });

    it('treats terminal and tombstoned prerequisites as absent from active blockers', () => {
      const canceled = make('Dropped approach');
      const archived = make('Parked work');
      const dependent = make('Downstream');
      repository.replaceDependencies(dependent.id, [canceled.id, archived.id]);

      repository.update(canceled.id, { status: 'canceled' });
      repository.archive(archived.id, false);

      expect(repository.listOpenDependencies(dependent.id).map((entry) => entry.id)).toEqual([]);
    });

    it('rejects a self-dependency', () => {
      const item = make('Alone');
      expect(() => repository.replaceDependencies(item.id, [item.id])).toThrow(WorkItemDependencyError);
      expect(repository.listDependencies(item.id)).toEqual([]);
    });

    it('rejects a prerequisite that does not exist', () => {
      const item = make('Real');
      expect(() => repository.replaceDependencies(item.id, ['00000000-0000-4000-8000-000000000000']))
        .toThrow(/existing task/i);
    });

    it('rejects a direct cycle and leaves the existing edges untouched', () => {
      const first = make('First');
      const second = make('Second');
      repository.replaceDependencies(second.id, [first.id]);

      expect(() => repository.replaceDependencies(first.id, [second.id])).toThrow(/cycle/i);
      // The rollback matters: a failed write must not strip the edge it replaced.
      expect(repository.listDependencies(first.id)).toEqual([]);
      expect(repository.listDependencies(second.id).map((entry) => entry.id)).toEqual([first.id]);
    });

    it('rejects an indirect cycle across three tasks', () => {
      const first = make('First');
      const second = make('Second');
      const third = make('Third');
      repository.replaceDependencies(second.id, [first.id]);
      repository.replaceDependencies(third.id, [second.id]);

      expect(() => repository.replaceDependencies(first.id, [third.id])).toThrow(/cycle/i);
      expect(repository.listDependencies(first.id)).toEqual([]);
    });

    it('replaces the whole edge set and de-duplicates repeated prerequisites', () => {
      const first = make('First');
      const second = make('Second');
      const dependent = make('Dependent');

      repository.replaceDependencies(dependent.id, [first.id, first.id]);
      expect(repository.listDependencies(dependent.id).map((entry) => entry.id)).toEqual([first.id]);

      repository.replaceDependencies(dependent.id, [second.id]);
      expect(repository.listDependencies(dependent.id).map((entry) => entry.id)).toEqual([second.id]);

      repository.replaceDependencies(dependent.id, []);
      expect(repository.listDependencies(dependent.id)).toEqual([]);
    });

    it('sets prerequisites through update() and rolls back the field changes when the edge is invalid', () => {
      const blocker = make('Blocker');
      const dependent = make('Dependent');

      expect(repository.update(dependent.id, { blockedByIds: [blocker.id] })!.blockedBy)
        .toEqual([expect.objectContaining({ id: blocker.id })]);

      // A rejected dependency edit must not leak a half-applied title change.
      expect(() => repository.update(dependent.id, { title: 'Renamed', blockedByIds: [dependent.id] }))
        .toThrow(WorkItemDependencyError);
      expect(repository.get(dependent.id)!.title).toBe('Dependent');
      expect(repository.listDependencies(dependent.id).map((entry) => entry.id)).toEqual([blocker.id]);
    });

    it('lists the work waiting on a blocker and drops the edge when a task is deleted', () => {
      const blocker = make('Blocker');
      const first = make('Waiting one');
      const second = make('Waiting two');
      repository.replaceDependencies(first.id, [blocker.id]);
      repository.replaceDependencies(second.id, [blocker.id]);

      expect(repository.listBlockedWork(blocker.id).map((entry) => entry.id).sort())
        .toEqual([first.id, second.id].sort());

      repository.delete(first.id);
      expect(repository.listBlockedWork(blocker.id).map((entry) => entry.id)).toEqual([second.id]);
      expect(repository.listDependencies(second.id).map((entry) => entry.id)).toEqual([blocker.id]);
    });

    it('excludes the task itself from its own prerequisite candidates', () => {
      const item = make('Self');
      const other = make('Other');

      const candidates = repository.searchDependencyCandidates(item.id);
      expect(candidates.map((entry) => entry.id)).toContain(other.id);
      expect(candidates.map((entry) => entry.id)).not.toContain(item.id);
      expect(repository.searchDependencyCandidates(item.id, 'Other').map((entry) => entry.id)).toEqual([other.id]);
    });

    it('counts only still-open dependents when building the planner context', () => {
      const blocker = make('Critical path');
      const open = make('Waiting');
      const finished = make('Already done');
      repository.replaceDependencies(open.id, [blocker.id]);
      repository.replaceDependencies(finished.id, [blocker.id]);
      repository.update(finished.id, { status: 'done' });

      expect(repository.buildQueueContext().openDependents.get(blocker.id)).toBe(1);
    });
  });
});
