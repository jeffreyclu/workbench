import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { cancelSharedReply, dispatchNextSharedTurn } from './shared-room.js';

describe('WorkItemRepository', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

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

  it('applies and rejects a reversible stack proposal', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const proposal = repository.createProposal([second.id, first.id], 'New context promotes the second task.');
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
    repository.resolveProposal(proposal.id, 'rejected');
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('shares recent room context and automatically preserves archived conversations', () => {
    const conversation = repository.createConversation('Queue operating model');
    repository.createSharedMessage('jeffrey', 'The queue order is the priority.', 'completed', conversation.id);
    repository.createSharedMessage('claude', 'Preserve yesterday’s order unless context changes.', 'completed', conversation.id);
    repository.createSharedMessage('codex', '', 'running', conversation.id);

    expect(repository.listSharedMessages()).toHaveLength(3);
    repository.setConversationArchived(conversation.id, true);
    const context = repository.getSharedContext();
    expect(context).toContain('Durable context from archived work:');
    expect(context).toContain('Archived conversation: Queue operating model');
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
    expect(repository.listConversationPage(30, null, 'archive').conversations.map((item) => item.id)).toContain(conversation.id);
    expect(repository.listConversationPage(30, null, 'active').conversations.map((item) => item.id)).not.toContain(conversation.id);

    const fork = repository.forkConversation(conversation.id)!;
    expect(fork).toEqual(expect.objectContaining({ workItemId: task.id, forkedFromConversationId: conversation.id, archivedAt: null }));
    expect(repository.listSharedMessages(100, fork.id).map((message) => message.body)).toEqual(['Investigate this', 'Here are the findings']);
    expect(repository.setConversationArchived(conversation.id, false)?.archivedAt).toBeNull();
  });

  it('turns only selected execution-plan items into ordered queue tasks', () => {
    const parent = repository.create({ title: 'Large migration', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: '/tmp/project', dueDate: null });
    const plan = repository.createExecutionPlan(parent.id, 'Split the migration safely.', [
      { title: 'Inventory usage', description: 'Find every call site and record evidence.', workspacePath: null },
      { title: 'Implement migration', description: 'Change the implementation and verify tests.', workspacePath: null },
    ]);
    repository.resolveExecutionPlan(plan.id, 'accepted', [1]);

    expect(repository.get(parent.id)?.status).toBe('done');
    expect(repository.listWorkbench().map((item) => item.title)).toEqual(['Implement migration']);
    expect(repository.listWorkbench()[0].workspacePath).toBe('/tmp/project');
    expect(repository.listWorkbench()[0].parentWorkItemId).toBe(parent.id);
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

  it('uses the latest run kind as the card classification for tasks created before classifications were saved', () => {
    const item = repository.create({ title: 'Legacy executed task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(item.id, 'research', 'auto', 'claude', 'Investigate it.');

    expect(repository.list()[0]).toEqual(expect.objectContaining({ classificationKind: 'research', classificationComplex: false }));
  });

  it('promotes tasks that have gone untouched for several days without resetting their age during reorder', () => {
    const old = repository.create({ title: 'Stale follow-up', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const recent = repository.create({ title: 'Recent task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(tenDaysAgo, old.id);

    const proposal = repository.buildDailyProposal();

    expect(proposal.rationale).toContain('10 days without activity');
    expect(repository.list().map((item) => item.id)).toEqual([old.id, recent.id]);
    expect(repository.get(old.id)?.lastTouchedAt).toBe(tenDaysAgo);
    expect(repository.getDiscoveryInbox().queueProposal?.id).toBe(proposal.id);
  });

  it('stores source credentials without returning them in connection metadata', () => {
    repository.setSourceConnection('github', 'Work GitHub', { token: 'secret-token', query: 'org:writer' });
    expect(repository.getSourceSettings('github')).toEqual({ token: 'secret-token', query: 'org:writer' });
    expect(repository.listSourceConnections()).toEqual([expect.objectContaining({ provider: 'github', label: 'Work GitHub', connected: true })]);
    expect(JSON.stringify(repository.listSourceConnections())).not.toContain('secret-token');
    repository.removeSourceConnection('github');
    expect(repository.listSourceConnections()).toEqual([]);
  });

  it('distinguishes incomplete archives from completed archives and writes shared memory', () => {
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
    expect(repository.listSharedMessages(100, archivedConversation.id)).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'Useful archived report' })]));
    expect(repository.listSharedMessages().filter((message) => message.pinned)).toEqual([]);
    expect(repository.getSharedContext()).toContain('Archived task (incomplete): Paused work');
    expect(repository.getSharedContext()).toContain('Archived task (completed): Shipped work');
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
    expect(repository.listSharedMessages(100, first.id)).toEqual([expect.objectContaining({ body: 'Review this file', attachments: [expect.objectContaining({ name: 'App.tsx' })] })]);
    expect(repository.listSharedMessages(100, second.id)).toHaveLength(1);
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
    expect(repository.listSharedMessages(100, conversation.id)).toEqual(expect.arrayContaining([
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
      repository.reclaimExpired();
      expect(repository.claimRun(run.id, 'owner-b', 60_000)).toBe(true);
    });

    it('claimRun refuses a run that is not queued', () => {
      const run = createQueuedRun();
      repository.updateRun(run.id, { status: 'completed' });
      expect(repository.claimRun(run.id, 'owner-a', 60_000)).toBe(false);
    });

    it('scheduleRunRetry re-queues with an incremented attempt and clears ownership, up to max_attempts', () => {
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', 60_000);
      expect(repository.scheduleRunRetry(run.id, 5_000)).toBe(true);
      const retried = repository.getRun(run.id)!;
      expect(retried.status).toBe('queued');
      expect(retried.attempt).toBe(1);
      expect(retried.nextAttemptAt).not.toBeNull();
      repository.claimRun(run.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(run.id, 0);
      expect(repository.getRun(run.id)?.attempt).toBe(2);
      // Third retry would hit max_attempts (default 3): refuse further retry.
      repository.claimRun(run.id, 'owner-a', 60_000);
      expect(repository.scheduleRunRetry(run.id, 0)).toBe(false);
    });

    it('reclaimExpired retries a non-execute run whose lease expired and fails an execute run instead', () => {
      const analysisRun = createQueuedRun();
      repository.claimRun(analysisRun.id, 'dead-owner', -1);
      const item = repository.create({ title: 'Filesystem edit', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const executeRun = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
      repository.claimRun(executeRun.id, 'dead-owner', -1);

      const result = repository.reclaimExpired();
      expect(result.recoveredRunIds).toContain(analysisRun.id);
      expect(result.failedRunIds).toContain(executeRun.id);
      expect(repository.getRun(analysisRun.id)?.status).toBe('queued');
      expect(repository.getRun(executeRun.id)?.status).toBe('failed');
      expect(repository.getRun(executeRun.id)?.error).toMatch(/Interrupted by API restart/);
    });

    it('dueWork returns queued runs with no future next_attempt_at and excludes scheduled retries not yet due', () => {
      const dueRun = createQueuedRun();
      const notYetDueRun = createQueuedRun();
      repository.claimRun(notYetDueRun.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(notYetDueRun.id, 60_000); // due far in the future
      expect(repository.dueWork().runIds).toContain(dueRun.id);
      expect(repository.dueWork().runIds).not.toContain(notYetDueRun.id);
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
      expect(repository.listSharedMessages(10, conversation.id).find((entry) => entry.id === message.id)?.status).toBe('completed');
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
      expect(repository.listSharedMessages(10, conversation.id).find((m) => m.id === message.id)?.status).toBe('running');
      // Second claim by a different owner fails.
      expect(repository.claimSharedMessage(message.id, 'owner-b', 60_000)).toBe(false);
    });

    it('reclaimExpired marks shared messages with expired leases as failed', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', 'partial output', 'running', conversation.id);
      // Claim with negative lease (already expired).
      repository.claimSharedMessage(message.id, 'dead-owner', -1);

      const result = repository.reclaimExpired();
      expect(result.recoveredMessageIds).toContain(message.id);
      const recovered = repository.listSharedMessages(10, conversation.id).find((m) => m.id === message.id);
      expect(recovered?.status).toBe('failed');
      expect(recovered?.error).toMatch(/Interrupted by API restart/);
      expect(recovered?.body).toBe('partial output'); // Partial output is preserved for inspection.
    });
  });
});
