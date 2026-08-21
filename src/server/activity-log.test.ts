import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../shared/contracts.js';
import { describeAgentFallback, describeExecutionRouting, describeLifecycleChange, describeModelSelection, summarizeWorkItemChanges } from './activity-log.js';

const item = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 'a', title: 'Ship the activity log', description: 'Explain agent decisions.', status: 'ready', priority: 2,
  queuePosition: 1, source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null,
  completionStatus: 'incomplete', agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [],
  projectName: 'Workbench', stack: 'attention', workspacePath: null, strategy: '', assignees: [], labels: [], dueDate: null,
  providerUpdatedAt: null, createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  lastTouchedAt: '2026-08-21T00:00:00.000Z', blockedBy: [], ...overrides,
});

describe('agent decision text', () => {
  it('states the execution type, the agent, and why each was chosen', () => {
    expect(describeExecutionRouting({
      kind: 'execute', agents: ['codex'], reason: 'AI classifier: the deliverable is code changes',
      agentSource: 'balanced', requestedProfile: null,
    })).toBe('Execution type: execute (AI classifier: the deliverable is code changes). Agent: codex (auto-picked to balance agent load). Model tier: auto (picked when the run starts).');
  });

  it('credits Jeffrey when he assigned the agent and picked the tier', () => {
    const body = describeExecutionRouting({
      kind: 'review', agents: ['claude'], reason: 'you picked this task type by hand',
      agentSource: 'assigned', requestedProfile: 'deep',
    });
    expect(body).toContain('Agent: claude (assigned to this task)');
    expect(body).toContain('Model tier: deep (you chose it)');
  });

  it('names the model, tier, and effort actually used for a run', () => {
    expect(describeModelSelection({ agent: 'claude', kind: 'execute', model: 'opus', profile: 'deep', source: 'task' }))
      .toBe('Model: claude opus · deep tier, high effort (matched to the task context). Running execute.');
    expect(describeModelSelection({ agent: 'codex', kind: 'analysis', model: 'gpt-5.6-luna', profile: 'economy', source: 'requested' }))
      .toContain('(you chose this tier)');
    expect(describeModelSelection({ agent: 'codex', kind: 'analysis', model: 'gpt-5.6-terra', profile: 'standard', source: 'prompt' }))
      .toContain('(raised by the assembled run prompt)');
  });

  it('explains lifecycle moves and names the cause when Workbench applied one', () => {
    expect(describeLifecycleChange('complete')).toBe('Completed and moved to the archive.');
    expect(describeLifecycleChange('archive')).toBe('Archived without completing.');
    expect(describeLifecycleChange('restore')).toBe('Restored from the archive.');
    expect(describeLifecycleChange('archive', 'its conversation was archived'))
      .toBe('Archived without completing because its conversation was archived.');
  });

  it('records the replacement model when an agent falls back', () => {
    expect(describeAgentFallback({ from: 'claude', to: 'codex', model: 'gpt-5.6-terra', reason: 'usage limit reached' }))
      .toBe('claude was unavailable (usage limit reached); continued with codex on gpt-5.6-terra.');
  });
});

describe('summarizeWorkItemChanges', () => {
  it('returns nothing when no pertinent field moved', () => {
    expect(summarizeWorkItemChanges(item(), item({ queuePosition: 9, updatedAt: 'later' }))).toEqual([]);
  });

  it('describes each pertinent field change in plain language', () => {
    const changes = summarizeWorkItemChanges(item(), item({
      title: 'Ship the decision log', status: 'in_progress', priority: 1, assignees: ['claude'],
      dueDate: '2026-08-25', projectName: null, workspacePath: '/Users/jeffrey.lu/dev/workbench',
      labels: ['activity'], description: 'New context.', strategy: 'Log every decision.',
    }));
    expect(changes).toEqual([
      'Renamed to "Ship the decision log"',
      'Status: ready → in_progress',
      'Priority: 2 → 1',
      'Owners: none → claude',
      'Due date: none → 2026-08-25',
      'Project: Workbench → none',
      'Workspace: none → /Users/jeffrey.lu/dev/workbench',
      'Labels: none → activity',
      'Edited the description',
      'Edited the strategy',
    ]);
  });

  it('reports prerequisite changes by count and calls out cleared text fields', () => {
    const blocked = item({ blockedBy: [{ id: 'b', title: 'First', status: 'ready', archivedAt: null, completedAt: null, isOpen: true }] });
    expect(summarizeWorkItemChanges(item(), blocked)).toEqual(['Prerequisites: 1 task']);
    expect(summarizeWorkItemChanges(blocked, item())).toEqual(['Cleared the prerequisites']);
    expect(summarizeWorkItemChanges(item({ strategy: 'Old plan.' }), item())).toEqual(['Cleared the strategy']);
  });

  it('truncates a long title instead of dumping it into the log', () => {
    const [line] = summarizeWorkItemChanges(item(), item({ title: 'x'.repeat(200) }));
    expect(line.length).toBeLessThan(100);
    expect(line).toContain('…');
  });
});
