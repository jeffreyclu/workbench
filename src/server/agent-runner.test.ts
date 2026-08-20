import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun, WorkItem } from '../shared/contracts.js';
import { buildPrompt, classifyExecution, isAgentCapacityError, readableAgentEvent, resolveAgents, resolveWorkingDirectory, selectExecutionProfile, selectPromptExecutionProfile } from './agent-runner.js';

const item = (title: string, description = ''): WorkItem => ({
  id: 'item', title, description, status: 'ready', priority: 2, queuePosition: 1,
  source: 'manual', isQueued: true, sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'],
  archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null,
  projectName: null, workspacePath: null, strategy: '', assignees: [], labels: [],
  dueDate: null, providerUpdatedAt: null, createdAt: '', updatedAt: '', lastTouchedAt: '',
});

describe('classifyExecution', () => {
  it('scales execution effort with task complexity and risk', () => {
    expect(selectExecutionProfile(item('Summarize these notes'), { kind: 'analysis', instructions: '' })).toBe('economy');
    expect(selectExecutionProfile(item('Implement the task card'), { kind: 'execute', instructions: '' })).toBe('standard');
    expect(selectExecutionProfile(item('Migrate authentication across systems'), { kind: 'execute', instructions: '' })).toBe('deep');
    expect(selectPromptExecutionProfile('thanks, what changed?')).toBe('economy');
    expect(selectPromptExecutionProfile('debug and test the React component')).toBe('standard');
    expect(selectPromptExecutionProfile('design a cross-system authentication migration')).toBe('deep');
  });
  it('recognizes provider quota failures that should trigger agent fallback', () => {
    expect(isAgentCapacityError(new Error("You've hit your usage limit; resets at 1am"))).toBe(true);
    expect(isAgentCapacityError(new Error("You've hit your session limit · resets 12am (America/New_York)"))).toBe(true);
    expect(isAgentCapacityError(new Error('HTTP 429: too many requests'))).toBe(true);
    expect(isAgentCapacityError(new Error('Task implementation failed a test'))).toBe(false);
  });

  it('infers the workspace from real paths in task context', () => {
    expect(resolveWorkingDirectory(item('Trim knowledge copy', 'Edit ~/notes/knowledge/index.md and preserve its conventions.')))
      .toBe(join(homedir(), 'notes/knowledge'));
  });

  it('routes coding and review work to Codex', () => {
    expect(classifyExecution(item('Implement the connector UI')).kind).toBe('execute');
    expect(classifyExecution(item('Review PR for regressions')).kind).toBe('review');
  });

  it('makes frontend-reviewer the only entry point for every review run', () => {
    expect(resolveAgents('review', 'claude')).toEqual(['claude']);
    expect(resolveAgents('review', 'both')).toEqual(['codex', 'claude']);
    expect(classifyExecution(item('Review a complex cross-team PR', 'x'.repeat(2_000))).kind).toBe('review');
  });

  it('applies the read-only principal frontend reviewer protocol', () => {
    const run = { agent: 'codex', kind: 'review', instructions: '' } as AgentRun;
    const prompt = buildPrompt(item('Review PR 5246'), run);
    expect(prompt).toContain('Authoritative persona: frontend-reviewer');
    expect(prompt).toContain('Read the Linear issue context and PR description first');
    expect(prompt).toContain('Do not install dependencies, run tests, run the app, inspect CI');
    expect(prompt).toContain('Label every finding or risk as Blocking or Non-blocking');
  });

  it('applies the principal frontend engineer protocol to implementation work', () => {
    const run = { agent: 'codex', kind: 'execute', instructions: '' } as AgentRun;
    const prompt = buildPrompt(item('Implement the connector UI'), run);
    expect(prompt).toContain('Authoritative persona: frontend-engineer');
    expect(prompt).toContain('Read and follow every applicable repository instruction');
    expect(prompt).toContain('correctness, readability, maintainability, performance, then scalability');
    expect(prompt).toContain('Start from an implementation plan');
    expect(prompt).toContain('Separate concerns explicitly');
    expect(prompt).toContain('Prefer pure, memoized React presentation components');
    expect(prompt).toContain("TanStack Query's caching and targeted invalidation capabilities");
    expect(prompt).toContain('represent every criterion in tests');
  });

  it('routes backend implementation through the principal backend engineer protocol', () => {
    const run = { agent: 'codex', kind: 'execute', instructions: '' } as AgentRun;
    const backendItem = item('Implement provider sync API endpoint');
    const prompt = buildPrompt(backendItem, run);
    expect(prompt).toContain('Authoritative persona: backend-engineer');
    expect(prompt).toContain('correctness, reliability, security, readability, maintainability, performance, then scalability');
    expect(prompt).toContain('Separate transport, application logic, domain logic, persistence, and provider integrations');
    expect(prompt).toContain('retries, timeouts, cancellation, idempotency, concurrency, and partial failure');
    expect(prompt).toContain('safe migrations and staged rollouts');
    expect(classifyExecution(backendItem).instructions).toContain('authoritative backend-engineer persona');
  });

  it('gates complex work behind a strategy', () => {
    const result = classifyExecution(item('Redesign the connector architecture'));
    expect(result.complex).toBe(true);
    expect(result.kind).toBe('strategy');
  });

  it('executes detailed self-contained tasks instead of decomposing them by length', () => {
    const task = item('Reduce the private memory copy', `Edit ~/.claude/memory/design-access-gate.md and preserve its behavior. ${'Detailed constraint. '.repeat(150)}`);
    const result = classifyExecution(task);
    expect(result.complex).toBe(false);
    expect(result.kind).toBe('execute');
    expect(result.agent).toBe('claude');
    expect(buildPrompt(task, { agent: 'claude', kind: 'execute', instructions: '' } as AgentRun)).toContain('Authoritative persona: document-writer');
  });

  it('keeps the assigned agent independent from the execution capability', () => {
    const assigned = { ...item('Implement the connector UI'), assignees: ['claude'] as WorkItem['assignees'] };
    expect(classifyExecution(assigned)).toEqual(expect.objectContaining({ kind: 'execute', agent: 'claude', complex: false }));
  });

  it('injects shared room context into execution prompts', () => {
    const run = { agent: 'codex', kind: 'execute', instructions: '' } as AgentRun;
    expect(buildPrompt(item('Build it'), run, 'jeffrey: Prefer small React components.'))
      .toContain('Shared context available to every agent:\njeffrey: Prefer small React components.');
    expect(buildPrompt(item('Build it'), run)).toContain('Never ask Jeffrey to grant a filesystem permission');
  });

  it('turns Codex and Claude JSON events into readable live progress', () => {
    expect(readableAgentEvent('codex', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } })).progress).toBe('● Running tests');
    expect(readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'App.tsx' } }] } })).progress).toBe('● Reading App.tsx');
    expect(readableAgentEvent('claude', JSON.stringify({ type: 'system', subtype: 'init' })).progress).toBe('');
    expect(readableAgentEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'The failing test points to stale state.' } })).progress).toContain('Reasoning summary');
  });
});
