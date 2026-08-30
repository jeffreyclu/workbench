import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_READ_SOFT_LIMIT_TOKENS, type AgentRun, type WorkItem } from '../shared/contracts.js';
import { agentSubprocessEnv } from './agent-security.js';
import { AGENT_DEBUGGER_CONTRACT, AGENT_EXECUTION_CONTRACT, CACHE_HANDOFF_INSTRUCTION, CACHE_HANDOFF_MARKER, CLAUDE_EXECUTION_CONTRACT, addUsage, autocompactCeilingTokens, cacheContinuationPrompt, checkpointActivityDetail, shouldCheckpointSession, EXTERNAL_ACTION_CONTRACT, RUNNER_SYSTEM_CONTRACT, TOOL_OUTPUT_CONTRACT, backoffDelayMs, buildPrompt, buildResumedPrompt, cancelAgentRun, claudeScopeRecoveryPrompt, classificationForKind, classifyExecution, classifyExecutionRobust, classifyExternalActionAuthorization, commandFor, compactPromptSection, executeAgentRun, executionProgressSteer, externalActionContractForAuthorization, hasCacheHandoff, hasUnsupportedClaudeScopeClaim, isAgentCapacityError, isAgentRunActive, isTransientAgentError, readableAgentEvent, resolveAgents, resolveExecutionProfileDecision, resolveWorkingDirectory, runAgentCommandWithFallback, selectAutoExecutionProfile, selectExecutionProfile, selectPromptExecutionProfile, shouldContinueCacheHandoff, terminalExitCheckpoint, terminalExitFailure, AgentTerminalWarningError } from './agent-runner.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { fakeAgentDirectory as sharedFakeAgentDirectory } from './test-fake-agent.js';

// The background risk scorer spawns model turns. Runner tests only care that it
// is scheduled at the moments a run comes to rest, never that it produces scores.
const scheduleReviewAutoScore = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}));
vi.mock('./review-auto-score.js', () => ({
  scheduleReviewAutoScore,
  reviewAutoScoreSnapshot: () => null,
  resetReviewAutoScore: () => {},
}));

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeAgentDirectory(codexBody: string, claudeBody: string): { directory: string; log: string } {
  const result = sharedFakeAgentDirectory(codexBody, claudeBody);
  temporaryDirectories.push(result.directory);
  return result;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for agent test condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const item = (title: string, description = ''): WorkItem => ({
  id: 'item', title, description, status: 'ready', priority: 2, queuePosition: 1,
  source: 'manual', isQueued: true, sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'],
  archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null,
  projectName: null, stack: 'attention', workspacePath: null, strategy: '', assignees: [], labels: [],
  dueDate: null, providerUpdatedAt: null, createdAt: '', updatedAt: '', lastTouchedAt: '',
});

describe('classifyExecution', () => {
  it('records verification commands only after Codex or Claude reports completion', () => {
    const codex = readableAgentEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pnpm typecheck', exit_code: 0 } }));
    expect(codex.audit).toEqual([expect.objectContaining({ command: 'pnpm typecheck', exitCode: 0 })]);

    const context = { subagents: new Map<string, string>(), pendingBash: new Map<string, string>() };
    readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pytest -q' } }] } }), context);
    const claude = readableAgentEvent('claude', JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', is_error: false }] } }), context);
    expect(claude.audit).toEqual([expect.objectContaining({ command: 'pytest -q', exitCode: 0 })]);
  });

  it('includes durable task attachment paths in the execution prompt', () => {
    const task = { ...item('Inspect the supplied design'), attachments: [{ name: 'brief.pdf', path: '/tmp/workbench-attachments/brief.pdf', mimeType: 'application/pdf', size: 42 }] };
    const prompt = buildPrompt(task, { agent: 'codex', kind: 'execute', instructions: '' } as AgentRun);
    expect(prompt).toContain('Attached task files:');
    expect(prompt).toContain('brief.pdf (application/pdf, 42 bytes): /tmp/workbench-attachments/brief.pdf');
  });

  it('scales execution effort with task complexity and risk', () => {
    expect(selectExecutionProfile(item('Summarize these notes'), { kind: 'analysis', instructions: '' })).toBe('economy');
    expect(selectExecutionProfile(item('Implement the task card'), { kind: 'execute', instructions: '' })).toBe('standard');
    expect(selectExecutionProfile(item('Migrate authentication across systems'), { kind: 'execute', instructions: '' })).toBe('deep');
    expect(selectPromptExecutionProfile('thanks, what changed?')).toBe('standard');
    expect(selectPromptExecutionProfile('debug and test the React component')).toBe('standard');
    expect(selectPromptExecutionProfile('Add a dropdown to the task card')).toBe('standard');
    expect(selectPromptExecutionProfile('Fix it')).toBe('standard');
    expect(selectPromptExecutionProfile('design a cross-system authentication migration')).toBe('deep');
    expect(selectAutoExecutionProfile(item('Implement the task card'), { kind: 'execute', instructions: '' }, 'go')).toBe('standard');
    expect(selectAutoExecutionProfile(item('Migrate authentication across systems'), { kind: 'execute', instructions: '' }, 'go')).toBe('deep');
    expect(selectExecutionProfile(item('Implement the whole settings page'), { kind: 'execute', instructions: '' })).toBe('deep');
  });

  it('does not let generated prompt scaffolding escalate a scoped execution task', () => {
    const task = item('Fix the task card loading state');
    const run = { agent: 'codex', kind: 'execute', instructions: 'Make the requested code change and verify it.' } as AgentRun;
    const generatedPrompt = buildPrompt(task, run, 'Architecture notes: preserve the existing security boundary.');
    expect(selectPromptExecutionProfile(generatedPrompt)).toBe('deep');
    expect(resolveExecutionProfileDecision(task, run, `${task.title}\n${task.description}\n${run.instructions}`)).toEqual({ profile: 'standard', source: 'task' });
  });
  it('recognizes provider quota failures that should trigger agent fallback', () => {
    expect(isAgentCapacityError(new Error("You've hit your usage limit; resets at 1am"))).toBe(true);
    expect(isAgentCapacityError(new Error("You've hit your session limit · resets 12am (America/New_York)"))).toBe(true);
    expect(isAgentCapacityError(new Error('HTTP 429: too many requests'))).toBe(true);
    expect(isAgentCapacityError(new Error('Task implementation failed a test'))).toBe(false);
  });

  it('runs agents in local-only, fail-closed modes while retaining the task workspace as cwd', () => {
    const codex = commandFor('codex', '/tmp/project', 'economy').args;
    const claude = commandFor('claude', '/tmp/project', 'economy').args;
    expect(codex).toEqual(expect.arrayContaining(['--ignore-user-config', '--sandbox', 'workspace-write']));
    expect(codex).toContain('mcp_servers.workbench.url="http://localhost:5180/mcp"');
    expect(codex).toContain('mcp_servers.workbench.bearer_token_env_var=""');
    expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(claude).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--no-chrome', '--disallowedTools', 'Task']));
    expect(claude).not.toContain('--safe-mode');
    expect(claude).not.toContain('--dangerously-skip-permissions');
    expect(claude).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
    expect(claude).not.toContain('--forward-subagent-text');
    expect(claude).toEqual(expect.arrayContaining(['--autocompact', '100k']));
    expect(claude).toEqual(expect.arrayContaining(['--add-dir', '/tmp/project', homedir()]));
    expect(commandFor('claude', '/tmp/project', 'standard').args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    expect(commandFor('claude', '/tmp/project', 'standard').args).not.toContain('--no-session-persistence');
  });

  it('passes the saved Claude session id to the provider resume primitive', () => {
    expect(commandFor('claude', '/tmp/project', 'standard', undefined, 'claude-session').args)
      .toEqual(expect.arrayContaining(['--resume', 'claude-session']));
  });

  it('bounds in-run context by profile so the ceiling actually fires on long runs', () => {
    expect(commandFor('claude', '/tmp/project', 'economy').args).toEqual(expect.arrayContaining(['--autocompact', '100k']));
    expect(commandFor('claude', '/tmp/project', 'standard').args).toEqual(expect.arrayContaining(['--autocompact', '200k']));
    expect(commandFor('claude', '/tmp/project', 'deep').args).toEqual(expect.arrayContaining(['--autocompact', '300k']));
  });

  it('parses the context ceiling into tokens so the checkpoint cannot drift from compaction', () => {
    expect(autocompactCeilingTokens('economy')).toBe(100_000);
    expect(autocompactCeilingTokens('standard')).toBe(200_000);
    expect(autocompactCeilingTokens('deep')).toBe(300_000);
  });

  it('falls back to the standard ceiling rather than zero when an override is unparseable', () => {
    // A zero ceiling would checkpoint every single turn, discarding live context.
    process.env.WORKBENCH_AUTOCOMPACT_STANDARD = 'not-a-size';
    try {
      expect(autocompactCeilingTokens('standard')).toBe(200_000);
    } finally {
      delete process.env.WORKBENCH_AUTOCOMPACT_STANDARD;
    }
  });

  it('does not pass Claude an out-of-range compact ceiling from the environment', () => {
    process.env.WORKBENCH_AUTOCOMPACT_ECONOMY = '60k';
    try {
      expect(commandFor('claude', '/tmp/project', 'economy').args).toEqual(expect.arrayContaining(['--autocompact', '100k']));
    } finally {
      delete process.env.WORKBENCH_AUTOCOMPACT_ECONOMY;
    }
  });

  it('retires a session whose turn peaked at the in-run ceiling', () => {
    expect(shouldCheckpointSession(200_000, 'standard')).toBe(true);
    expect(shouldCheckpointSession(300_000, 'deep')).toBe(true);
  });

  it('keeps a session that stayed under the ceiling so live context survives', () => {
    expect(shouldCheckpointSession(199_999, 'standard')).toBe(false);
    expect(shouldCheckpointSession(0, 'economy')).toBe(false);
  });

  it('keeps the session when the turn reported no usage at all', () => {
    // Missing usage samples are not evidence of bloat; discarding on unknown
    // peaks would throw away implementation context on every silent stream.
    expect(shouldCheckpointSession(undefined, 'standard')).toBe(false);
  });

  it('retires only a session whose active context crossed its profile threshold, not one with high cumulative spend', () => {
    const ceiling = autocompactCeilingTokens('deep');
    expect(shouldCheckpointSession(20_000, 'deep', CACHE_READ_SOFT_LIMIT_TOKENS * 20)).toBe(false);
    expect(shouldCheckpointSession(ceiling, 'deep')).toBe(true);
    expect(checkpointActivityDetail(ceiling, 'deep')).toContain('Context checkpoint');
  });

  it('reports the checkpoint with both the measured peak and the ceiling that tripped it', () => {
    const detail = checkpointActivityDetail(200_000, 'standard');
    expect(detail).toContain('200k');
  });

  it('passes invariant Claude runner rules through the static system-prompt channel', () => {
    const args = commandFor('claude', '/tmp/project', 'standard').args;
    const systemPromptIndex = args.indexOf('--append-system-prompt');
    expect(systemPromptIndex).toBeGreaterThan(-1);
    expect(args[systemPromptIndex + 1]).toBe(RUNNER_SYSTEM_CONTRACT);
    expect(args[systemPromptIndex + 1]).toContain('Workbench brokers connected sources through its own source-search capability.');
    expect(args[systemPromptIndex + 1]).toContain('A missing direct tool for Grafana');

    const task = item('Fix the task card', 'This full description must not be replayed after session resume.');
    const claudePrompt = buildPrompt(task, { agent: 'claude', kind: 'execute', instructions: '' } as AgentRun);
    const codexPrompt = buildPrompt(task, { agent: 'codex', kind: 'execute', instructions: '' } as AgentRun);
    expect(claudePrompt).not.toContain(RUNNER_SYSTEM_CONTRACT);
    expect(codexPrompt).toContain(RUNNER_SYSTEM_CONTRACT);
    expect(claudePrompt).toContain('write-enabled for the resolved workspace');
    expect(buildPrompt(task, { agent: 'claude', kind: 'analysis', instructions: '' } as AgentRun)).toContain('read-only by task type');
  });

  it('builds a bounded continuation prompt for an already-resumed Claude session', () => {
    const task = { ...item('Fix the task card', 'x'.repeat(10_000)), strategy: 'Keep the established strategy.' };
    const prompt = buildResumedPrompt(task, { agent: 'claude', kind: 'execute', instructions: 'Apply the latest fix.' } as AgentRun);

    expect(prompt).toContain('Continue the existing task session.');
    expect(prompt).toContain('Fix the task card');
    expect(prompt).toContain('Apply the latest fix.');
    expect(prompt).not.toContain('x'.repeat(1_000));
    expect(prompt).not.toContain('Shared context available to every agent:');
    expect(prompt).not.toContain('Retrieved memory');
    expect(prompt).not.toContain(RUNNER_SYSTEM_CONTRACT);
  });

  it('streams Claude partial messages so a long answer is visible while it is written', () => {
    expect(commandFor('claude', '/tmp/project', 'standard').args).toContain('--include-partial-messages');
    const delta = readableAgentEvent('claude', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading ' } } }));
    expect(delta).toEqual(expect.objectContaining({ delta: 'Reading ', progress: '', final: null }));
    // Thinking is silent in both forms. Announcing every block buried the answer
    // under dozens of identical markers, and the raw reasoning is never printed.
    expect(readableAgentEvent('claude', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } }))).toEqual({ progress: '', final: null, audit: [] });
    expect(readableAgentEvent('claude', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } } }))).toEqual({ progress: '', final: null, audit: [] });
  });

  it('narrows read-only task kinds to a read-only tool surface', () => {
    expect(commandFor('codex', '/tmp/project', 'standard', undefined, undefined, 'research').args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(commandFor('claude', '/tmp/project', 'standard', undefined, undefined, 'review').args).toEqual(expect.arrayContaining(['--disallowedTools', 'Task,Edit,Write,NotebookEdit']));
    expect(commandFor('codex', '/tmp/project', 'standard', undefined, undefined, 'execute').args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
  });

  it('keeps Claude stdin open and appends an interjection after the initial prompt', async () => {
    const fixture = fakeAgentDirectory('exit 1', 'exit 1');
    const { directory, log } = fixture;
    const script = `IFS= read -r first; printf '%s\\n' "$first" >> '${log}'; IFS= read -r second; printf '%s\\n' "$second" >> '${log}'; printf '%s\\n' '{"type":"result","result":"Applied the interjection."}'`;
    writeFileSync(join(directory, 'claude'), `#!/bin/sh\nprintf '%s\\n' 'claude' >> '${log}'\n${script}\n`);
    chmodSync(join(directory, 'claude'), 0o755);
    const result = await runAgentCommandWithFallback('claude', directory, 'Start the task.', undefined, undefined, undefined, 'economy', undefined, undefined, 'analysis', undefined, undefined, (steer) => {
      void steer('Change direction now.');
    });

    expect(result.output).toBe('Applied the interjection.');
    const lines = readFileSync(log, 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line));
    expect(lines.map((line) => line.message.content)).toEqual([
      `Start the task.\n\nAgent debugger:\n${AGENT_DEBUGGER_CONTRACT}\n\n${TOOL_OUTPUT_CONTRACT}\n\nAgent execution budget:\n${AGENT_EXECUTION_CONTRACT}`,
      'Change direction now.',
    ]);
  });

  it('shows streamed text once rather than twice when the completed block arrives', async () => {
    // Real deltas arrive over time. The pause exceeds the progress flush window,
    // so this tests incremental visibility rather than chunk luck.
    const streamed = [
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking the ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'failing test.' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the failing test.' }] } },
      { type: 'result', result: 'Fixed it.' },
    ].map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join('\n/bin/sleep 0.3\n');
    const { directory } = fakeAgentDirectory('exit 1', streamed);
    const snapshots: string[] = [];

    const result = await runAgentCommandWithFallback('claude', directory, 'Do it.', (partial) => snapshots.push(partial));

    const streamedProgress = snapshots.at(-1) ?? '';
    expect(streamedProgress).not.toContain('Thinking');
    expect(streamedProgress.match(/Checking the failing test\./g)).toHaveLength(1);
    // The text was visible in pieces before the block completed.
    expect(snapshots.some((snapshot) => snapshot.includes('Checking the ') && !snapshot.includes('failing test.'))).toBe(true);
    expect(result.output).toBe('Fixed it.');
  });

  it('keeps Claude in one foreground context to avoid multiplied cache reads', () => {
    for (const profile of ['economy', 'standard', 'deep'] as const) {
      const args = commandFor('claude', '/tmp/project', profile).args;
      expect(args).toEqual(expect.arrayContaining(['--disallowedTools', 'Task']));
      expect(args).not.toContain('--forward-subagent-text');
    }
  });

  it('tells Claude not to open extra cached subagent contexts', () => {
    expect(CLAUDE_EXECUTION_CONTRACT).toContain('do not delegate to subagents');
    expect(CLAUDE_EXECUTION_CONTRACT).toContain('Report a command as passing only if it ran in this run');
  });

  it('gives Codex and Claude the same execution contract without a cached-input kill switch', () => {
    expect(CLAUDE_EXECUTION_CONTRACT).toBe(AGENT_EXECUTION_CONTRACT);
    expect(AGENT_EXECUTION_CONTRACT).not.toContain('cached-input budgets');
    expect(AGENT_EXECUTION_CONTRACT).toContain("A user's observed live failure is authoritative evidence");
    expect(AGENT_EXECUTION_CONTRACT).toContain("The user's explicit request is the authoritative command");
    expect(AGENT_EXECUTION_CONTRACT).toContain('Never debate, reinterpret, downgrade, or substitute a different task');
  });

  it('uses one provider-neutral progress supervisor for action and cache handoff reminders', () => {
    expect(executionProgressSteer(7, false)).toBeNull();
    expect(executionProgressSteer(8, false)).toContain('make the smallest relevant edit now');
    expect(executionProgressSteer(1, true)).toBeNull();
    expect(executionProgressSteer(2, true)).toContain(CACHE_HANDOFF_MARKER);
    expect(shouldContinueCacheHandoff({ output: `${CACHE_HANDOFF_MARKER} useful checkpoint`, cacheHandoffRequested: true, terminalWarning: 'provider stopped' })).toBe(true);
    expect(shouldContinueCacheHandoff({ output: 'normal completion', cacheHandoffRequested: false, terminalWarning: null })).toBe(false);
  });

  it('keeps a non-zero provider exit diagnostic provider-authored and preserves the agent turn as a checkpoint', () => {
    // Both shapes are taken from failed runs: one stored the agent's own final
    // report in `error` (it read like a Workbench guardrail), the other stored
    // the raw Claude JSONL stream.
    const agentProse = 'Agent exceeded the standard tool-call limit (24) without completing. Verification must stay focused and terminate.';
    const failure = terminalExitFailure({ stderr: '', terminalError: '', finalOutput: agentProse, progress: '\u25cf Running a workspace command: grep -n classification-badge', command: 'claude', code: 1 });
    expect(failure.message).toBe('claude exited with code 1.');
    expect(failure).toBeInstanceOf(AgentTerminalWarningError);
    expect((failure as InstanceType<typeof AgentTerminalWarningError>).checkpoint).toContain(agentProse);
    expect((failure as InstanceType<typeof AgentTerminalWarningError>).checkpoint).toContain('Running a workspace command');

    const streamJson = '{"type":"system","subtype":"init","cwd":"/Users/jeffrey.lu/dev/writer-monorepo"}';
    expect(terminalExitFailure({ stderr: '', terminalError: '', finalOutput: '', progress: '', command: 'claude', code: 1 }).message).toBe('claude exited with code 1.');
    expect(terminalExitFailure({ stderr: '', terminalError: '', finalOutput: '', progress: streamJson, command: 'claude', code: 1 }).message).not.toContain('"type":"system"');

    // A real provider diagnostic still wins over the synthesized exit-code text.
    expect(terminalExitFailure({ stderr: 'spawn ENOENT', terminalError: '', finalOutput: '', progress: '', command: 'claude', code: 1 }).message).toBe('spawn ENOENT');
    expect(terminalExitFailure({ stderr: '', terminalError: 'Claude ended the turn with error_max_turns.', finalOutput: '', progress: '', command: 'claude', code: 1 }).message).toBe('Claude ended the turn with error_max_turns.');

    // Nothing to keep means an ordinary failure, not a terminal-warning checkpoint.
    expect(terminalExitFailure({ stderr: 'boom', terminalError: '', finalOutput: '', progress: '', command: 'codex', code: 2 })).not.toBeInstanceOf(AgentTerminalWarningError);
    expect(terminalExitCheckpoint('same report', 'lead-in\n\nsame report')).toBe('lead-in\n\nsame report');

    // A provider failure that only reached stdout must still classify for retry.
    const transient = terminalExitFailure({ stderr: '', terminalError: '', finalOutput: '', progress: '', stdout: 'noise\nError: socket hang up while streaming\nmore noise', command: 'claude', code: 1 });
    expect(transient.message).toBe('Error: socket hang up while streaming');
    expect(isTransientAgentError(transient)).toBe(true);
    const capacity = terminalExitFailure({ stderr: '', terminalError: '', finalOutput: 'usage limit reached for this account', progress: '', command: 'claude', code: 1 });
    expect(isAgentCapacityError(capacity)).toBe(true);
    // Agent prose that merely contains the word "limit" is not a provider failure.
    expect(isAgentCapacityError(failure)).toBe(false);
    expect(isTransientAgentError(failure)).toBe(false);
  });

  it.each(['codex', 'claude'] as const)('lets %s complete after more than the former economy tool-call ceiling', async (agent) => {
    const event = agent === 'codex'
      ? { type: 'item.started', item: { type: 'command_execution', command: 'rg pattern src' } }
      : { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.ts' } }] } };
    const finalEvent = agent === 'codex'
      ? { type: 'item.completed', item: { type: 'agent_message', text: 'Finished after 13 tool calls.' } }
      : { type: 'result', result: 'Finished after 13 tool calls.' };
    const body = [...Array.from({ length: 13 }, () => event), finalEvent]
      .map((item) => `printf '%s\\n' '${JSON.stringify(item)}'`).join('\n');
    const fixture = fakeAgentDirectory(agent === 'codex' ? body : 'exit 1', agent === 'claude' ? body : 'exit 1');

    const result = await runAgentCommandWithFallback(agent, fixture.directory, 'Verify the change.', undefined, undefined, undefined, 'economy');

    expect(result.output).toBe('Finished after 13 tool calls.');
  });

  it.each(['codex', 'claude'] as const)('does not terminate %s solely because cumulative cache usage is high', async (agent) => {
    const usageEvent = agent === 'codex'
      ? { type: 'token_count', info: { last_token_usage: { input_tokens: 1_600_010, cached_input_tokens: 1_600_000, output_tokens: 5 } } }
      : { type: 'assistant', request_id: 'large-cache-request', message: { usage: { input_tokens: 10, cache_read_input_tokens: 1_600_000, output_tokens: 5 } } };
    const finalEvent = agent === 'codex'
      ? { type: 'item.completed', item: { type: 'agent_message', text: 'Finished after the large cache read.' } }
      : { type: 'result', result: 'Finished after the large cache read.' };
    const body = [usageEvent, finalEvent].map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join('\n');
    const fixture = fakeAgentDirectory(agent === 'codex' ? body : 'exit 1', agent === 'claude' ? body : 'exit 1');

    await expect(runAgentCommandWithFallback(agent, fixture.directory, 'Verify the change.', undefined, undefined, undefined, 'economy'))
      .resolves.toMatchObject({ output: 'Finished after the large cache read.' });
  });

  it('continues a cooperative Claude cache checkpoint in a fresh process without terminating either segment', async () => {
    const countFile = join(tmpdir(), `workbench-cache-segments-${Date.now()}`);
    const checkpoint = JSON.stringify({ type: 'result', result: `${CACHE_HANDOFF_MARKER} edited the file; verification remains.`, usage: { input_tokens: 10, cache_read_input_tokens: CACHE_READ_SOFT_LIMIT_TOKENS, output_tokens: 5 } });
    const highUsage = JSON.stringify({ type: 'assistant', request_id: 'budget-crossing-request', message: { usage: { input_tokens: 10, cache_read_input_tokens: CACHE_READ_SOFT_LIMIT_TOKENS, output_tokens: 5 } } });
    const completed = JSON.stringify({ type: 'result', result: 'Finished in the compact continuation.', usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 7 } });
    const body = `count=0\nif [ -f '${countFile}' ]; then read count < '${countFile}'; fi\ncount=$((count + 1))\nprintf '%s' "$count" > '${countFile}'\nif [ "$count" -eq 1 ]; then\n  printf '%s\\n%s\\n' '${highUsage}' '${checkpoint}'\nelse\n  printf '%s\\n' '${completed}'\nfi`;
    const fixture = fakeAgentDirectory('exit 1', body);

    const result = await runAgentCommandWithFallback('claude', fixture.directory, 'Implement and verify the change.');

    expect(result.output).toBe('Finished in the compact continuation.');
    expect(result.usage.cacheReadInputTokens).toBe(CACHE_READ_SOFT_LIMIT_TOKENS + 100);
    expect(readFileSync(countFile, 'utf8')).toBe('2');
    rmSync(countFile, { force: true });
  });

  it('reports a concise Claude terminal diagnostic instead of exposing the entire failed handoff as the error', async () => {
    const failed = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'A very long user-facing handoff that must not become the error field.' });
    const fixture = fakeAgentDirectory('exit 1', `printf '%s\\n' '${failed}'`);

    await expect(runAgentCommandWithFallback('claude', fixture.directory, 'Implement it.'))
      .rejects.toThrow('Claude ended the turn with error_max_turns.');
  });

  it('recovers an expired Claude session through the same supervised fresh-session lifecycle', async () => {
    const countFile = join(tmpdir(), `workbench-expired-session-${Date.now()}`);
    const promptFile = join(tmpdir(), `workbench-expired-session-prompts-${Date.now()}`);
    const missing = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: expired-session' });
    const completed = JSON.stringify({ type: 'result', result: 'Completed after starting a fresh session.' });
    const body = `IFS= read -r prompt\nprintf '%s\\n' "$prompt" >> '${promptFile}'\ncount=0\nif [ -f '${countFile}' ]; then read count < '${countFile}'; fi\ncount=$((count + 1))\nprintf '%s' "$count" > '${countFile}'\nif [ "$count" -eq 1 ]; then printf '%s\\n' '${missing}'; else printf '%s\\n' '${completed}'; fi`;
    const fixture = fakeAgentDirectory('exit 1', body);

    const result = await runAgentCommandWithFallback('claude', fixture.directory, 'Incremental follow-up.', undefined, undefined, undefined, 'economy', undefined, undefined, 'analysis', undefined, undefined, undefined, 'expired-session', false, true, undefined, 'Full recovery prompt.');

    expect(result.output).toBe('Completed after starting a fresh session.');
    expect(readFileSync(countFile, 'utf8')).toBe('2');
    const prompts = readFileSync(promptFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).message.content as string);
    expect(prompts[0]).toContain('Incremental follow-up.');
    expect(prompts[1]).toContain('Full recovery prompt.');
    expect(prompts[1]).not.toContain('Incremental follow-up.');
    rmSync(countFile, { force: true });
    rmSync(promptFile, { force: true });
  });

  it('builds a bounded cache continuation and preserves null-aware usage accounting', () => {
    expect(CACHE_HANDOFF_INSTRUCTION).toContain('do not start another tool');
    expect(hasCacheHandoff(`${CACHE_HANDOFF_MARKER} saved`)).toBe(true);
    const continuation = cacheContinuationPrompt('x'.repeat(20_000), 'y'.repeat(20_000));
    expect(continuation.length).toBeLessThan(21_000);
    expect(addUsage(
      { inputTokens: null, cacheCreationInputTokens: 2, cacheReadInputTokens: 5, outputTokens: null },
      { inputTokens: 3, cacheCreationInputTokens: null, cacheReadInputTokens: 7, outputTokens: null },
    )).toEqual({ inputTokens: 3, cacheCreationInputTokens: 2, cacheReadInputTokens: 12, outputTokens: null });
  });

  it('injects the explicit-order external-source guardrail into every work-item prompt', () => {
    const prompt = buildPrompt(item('Fix a component'), { agent: 'codex', kind: 'execute', instructions: '' } as AgentRun);
    expect(prompt).toContain(EXTERNAL_ACTION_CONTRACT);
    expect(prompt).toContain('Workspace isolation:');
    expect(prompt).toContain('Never create or update `docs/shared-memory*`');
  });

  it('uses one model judgment, including immediate pending-operation context, for external authorization', async () => {
    const granted = await classifyExternalActionAuthorization({
      currentMessage: 'NOW YOU HAVE PERMISSION',
      precedingHumanMessage: 'Update GitHub PR #14337 with the Loom demo.',
    }, async () => '{"granted":true,"operation":"Update GitHub PR #14337 with the Loom demo."}');
    expect(externalActionContractForAuthorization(granted)).toContain('Supervisor-issued external-action capability');
    const denied = await classifyExternalActionAuthorization({ currentMessage: 'Sounds good.', precedingHumanMessage: 'Update GitHub PR #14337.' }, async () => '{"granted":false,"operation":null}');
    expect(externalActionContractForAuthorization(denied)).toBe(EXTERNAL_ACTION_CONTRACT);
  });

  it('sends both agents the same reasoning effort for a given tier', () => {
    const effortOf = (agent: 'codex' | 'claude', profile: 'economy' | 'standard' | 'deep') => {
      const args = commandFor(agent, '/tmp/project', profile).args;
      const flag = args.indexOf('--effort');
      return flag >= 0 ? args[flag + 1] : args.find((arg) => arg.startsWith('model_reasoning_effort='))?.split('"')[1];
    };
    for (const profile of ['economy', 'standard', 'deep'] as const) {
      expect(effortOf('claude', profile)).toBe(effortOf('codex', profile));
    }
    expect(effortOf('claude', 'standard')).toBe('medium');
    expect(effortOf('claude', 'deep')).toBe('high');
  });

  it('detects imaginary Claude scope claims and states the concrete fresh-session contract', () => {
    expect(hasUnsupportedClaudeScopeClaim('This session is read-only and my allowed directory is fixed elsewhere.')).toBe(true);
    expect(hasUnsupportedClaudeScopeClaim('I ran a read-only query against the live corpus.')).toBe(false);
    expect(hasUnsupportedClaudeScopeClaim('The GitHub credential is unavailable.')).toBe(false);
    const recovery = claudeScopeRecoveryPrompt('Fix the component.', '/Users/jeffrey.lu/dev/writer-monorepo');
    expect(recovery).toContain('freshly spawned Claude CLI invocation');
    expect(recovery).toContain('/Users/jeffrey.lu/dev/writer-monorepo');
    expect(recovery).toContain('bypassed permission checks');
  });

  it('does not fall back when a successful short answer mentions rate limit and capacity', async () => {
    const answer = 'A short answer about rate limit and capacity.';
    const { directory, log } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } })}'`,
      `printf '%s\\n' '${JSON.stringify({ type: 'result', result: 'Unexpected fallback.' })}'`,
    );

    const result = await runAgentCommandWithFallback('codex', directory, 'Explain rate limiting.');

    expect(result).toEqual(expect.objectContaining({ output: answer, agent: 'codex', fallbackFrom: null, fallbackReason: null }));
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['codex']);
  });

  it('uses the final Codex agent message instead of saving the live transcript as the reply', async () => {
    const progress = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decision: Inspect the renderer before changing it.' } });
    const interim = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I found the completed-message boundary.' } });
    const final = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixed the final response renderer and verified the focused test.' } });
    const { directory } = fakeAgentDirectory(`printf '%s\\n%s\\n%s\\n' '${progress}' '${interim}' '${final}'`, 'exit 1');

    const result = await runAgentCommandWithFallback('codex', directory, 'Fix the completed reply.');

    expect(result.output).toBe('Fixed the final response renderer and verified the focused test.');
  });

  it('reaps test workers left behind after an otherwise successful agent exit', async () => {
    const pidFile = join(tmpdir(), `workbench-orphan-worker-${Date.now()}.pid`);
    const completed = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Finished.' } });
    const { directory } = fakeAgentDirectory(`(trap '' TERM; while true; do /bin/sleep 0.1; done) >/dev/null 2>&1 & echo $! > '${pidFile}'\nprintf '%s\\n' '${completed}'`, 'exit 1');

    await expect(runAgentCommandWithFallback('codex', directory, 'Complete the task.')).resolves.toEqual(expect.objectContaining({ output: 'Finished.' }));
    const orphanPid = Number(readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => {
      try { process.kill(orphanPid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }, 5_000);
  });

  it('falls back on a non-zero 429 diagnostic and preserves requested and executing agents', async () => {
    const { directory, log } = fakeAgentDirectory(
      `printf '%s\\n' 'HTTP 429: usage limit reached' >&2\nexit 1`,
      `printf '%s\\n' '${JSON.stringify({ type: 'result', result: 'Fallback completed.' })}'`,
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Fix provider fallback', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'codex', 'codex', 'Implement it.');

    await executeAgentRun(repository, run, 'test-owner', 60_000);

    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['codex', 'claude']);
    expect(repository.getRun(run.id)).toEqual(expect.objectContaining({
      status: 'completed', requestedAgent: 'codex', agent: 'claude', fallbackFrom: 'codex', fallbackReason: expect.stringContaining('429'),
    }));
    expect(repository.getRun(run.id)?.reviewHandoff).toEqual(expect.objectContaining({
      agentRunId: run.id,
      formatVersion: 1,
      verification: [],
      uncertainties: ['No completed test, build, typecheck, or lint command was observed by the runner.'],
    }));
    database.close();
  });

  it('makes a second mutating run wait for a workspace another run is editing', async () => {
    const { directory, log } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Edited it.' } })}'`,
      `printf '%s\\n' '${JSON.stringify({ type: 'result', result: 'Edited it.' })}'`,
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    // Two different tasks, one working tree. The per-task guard never saw this.
    const editing = repository.create({ title: 'Task already editing', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const waiting = repository.create({ title: 'Task that must wait', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const holder = repository.createRun(editing.id, 'execute', 'codex', 'codex', 'Implement it.');
    const blocked = repository.createRun(waiting.id, 'execute', 'claude', 'claude', 'Implement it too.');
    expect(repository.claimWorkspace(directory, holder.id, 'owner-a', 60_000)).toBe(true);

    await executeAgentRun(repository, blocked, 'owner-b', 60_000);

    expect(existsSync(log)).toBe(false);
    expect(repository.getRun(blocked.id)).toEqual(expect.objectContaining({ status: 'queued', startedAt: null, attempt: 0, resolvedWorkspace: directory }));
    expect(repository.listActivity(waiting.id).some((entry) => entry.body.includes(`Waiting: another run is editing ${directory}`))).toBe(true);

    // Once the holder is done the same run proceeds without being re-requested.
    repository.releaseWorkspace(holder.id);
    await executeAgentRun(repository, repository.getRun(blocked.id)!, 'owner-b', 60_000);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['claude']);
    expect(repository.getRun(blocked.id)).toEqual(expect.objectContaining({ status: 'completed' }));
    database.close();
  });

  it('lets a read-only run start while another run holds the workspace', async () => {
    const { directory, log } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Analyzed it.' } })}'`,
      `printf '%s\\n' '${JSON.stringify({ type: 'result', result: 'Analyzed it.' })}'`,
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const editing = repository.create({ title: 'Task already editing', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const reading = repository.create({ title: 'Task only reading', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const holder = repository.createRun(editing.id, 'execute', 'codex', 'codex', 'Implement it.');
    const analysis = repository.createRun(reading.id, 'analysis', 'claude', 'claude', 'Explain it.');
    expect(repository.claimWorkspace(directory, holder.id, 'owner-a', 60_000)).toBe(true);

    await executeAgentRun(repository, analysis, 'owner-b', 60_000);

    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['claude']);
    expect(repository.getRun(analysis.id)).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(repository.workspaceLeaseHolder(directory)).toBe(holder.id);
    database.close();
  });

  it('hands an invalid Claude sandbox claim to Codex in the same tracked run', async () => {
    const { directory, log } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex fixed it and ran the focused test.' } })}'`,
      `printf '%s\\n' '${JSON.stringify({ type: 'result', result: 'I cannot write because this session is read-only and sandboxed to another directory.' })}'`,
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Fix the scoped file', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'claude', 'claude', 'Fix it.');

    await executeAgentRun(repository, run, 'test-owner', 60_000);

    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['claude', 'codex']);
    expect(repository.getRun(run.id)).toEqual(expect.objectContaining({
      status: 'completed', requestedAgent: 'claude', agent: 'codex', fallbackFrom: 'claude', fallbackReason: expect.stringContaining('sandbox or read-only'),
      output: 'Codex fixed it and ran the focused test.',
    }));
    database.close();
  });

  it('observes cancellation requested through a second database connection within one heartbeat', async () => {
    const { directory } = fakeAgentDirectory(
      `trap 'exit 143' TERM\nwhile true; do /bin/sleep 0.1; done`,
      'exit 1',
    );
    const databasePath = join(directory, 'shared.db');
    const ownerDatabase = openDatabase(databasePath);
    const ownerRepository = new WorkItemRepository(ownerDatabase);
    const task = ownerRepository.create({ title: 'Cross-process cancellation', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: directory, dueDate: null });
    const run = ownerRepository.createRun(task.id, 'execute', 'codex', 'codex', 'Wait until canceled.');
    const execution = executeAgentRun(ownerRepository, run, 'owner-process', 3_000);
    const cancelingDatabase = openDatabase(databasePath);
    const cancelingRepository = new WorkItemRepository(cancelingDatabase);

    try {
      expect(isAgentRunActive(run.id)).toBe(true);
      expect(cancelingRepository.requestRunCancellation(run.id)).toBe(true);
      await execution;
      expect(ownerRepository.getRun(run.id)?.status).toBe('canceled');
      expect(isAgentRunActive(run.id)).toBe(false);
    } finally {
      cancelingDatabase.close();
      ownerDatabase.close();
    }
  });

  it('scores what a canceled run already wrote, because cancelling stops the agent and not its edits', async () => {
    scheduleReviewAutoScore.mockClear();
    const { directory } = fakeAgentDirectory(
      `trap 'exit 143' TERM\nwhile true; do /bin/sleep 0.1; done`,
      'exit 1',
    );
    const database = openDatabase(join(directory, 'shared.db'));
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Canceled mid-edit', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'codex', 'codex', 'Wait until canceled.');
    const execution = executeAgentRun(repository, run, 'owner-process', 3_000);

    try {
      expect(isAgentRunActive(run.id)).toBe(true);
      expect(repository.requestRunCancellation(run.id)).toBe(true);
      await execution;
      expect(repository.getRun(run.id)?.status).toBe('canceled');
      expect(scheduleReviewAutoScore).toHaveBeenCalled();
      expect(scheduleReviewAutoScore.mock.calls[0][1]).toEqual({ workItemId: task.id });
    } finally {
      database.close();
    }
  });

  it('keeps cancellation authoritative when the agent completes just after a remote cancel', async () => {
    const partial = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Partial output' } });
    const completed = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Completed output' } });
    const { directory } = fakeAgentDirectory(
      `printf '%s\\n' '${partial}'\n/bin/sleep 0.2\nprintf '%s\\n' '${completed}'`,
      'exit 1',
    );
    const databasePath = join(directory, 'race.db');
    const ownerDatabase = openDatabase(databasePath);
    const ownerRepository = new WorkItemRepository(ownerDatabase);
    const task = ownerRepository.create({ title: 'Cancel completion race', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: directory, dueDate: null });
    const run = ownerRepository.createRun(task.id, 'execute', 'codex', 'codex', 'Produce output.');
    const cancelingDatabase = openDatabase(databasePath);
    const cancelingRepository = new WorkItemRepository(cancelingDatabase);
    const originalWebhook = process.env.SLACK_WEBHOOK_URL;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const execution = executeAgentRun(ownerRepository, run, 'owner-process', 3_000);
      await waitFor(() => ownerRepository.getRun(run.id)?.output.includes('Partial output') === true);
      expect(cancelAgentRun(cancelingRepository, run.id)?.status).toBe('canceled');
      expect(ownerRepository.isRunCancellationSettling(run.id)).toBe(true);
      cancelingRepository.update(task.id, { status: 'canceled' });
      await execution;

      expect(ownerRepository.getRun(run.id)?.status).toBe('canceled');
      expect(ownerRepository.isRunCancellationSettling(run.id)).toBe(false);
      expect(ownerRepository.get(task.id)?.status).toBe('canceled');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalWebhook === undefined) delete process.env.SLACK_WEBHOOK_URL;
      else process.env.SLACK_WEBHOOK_URL = originalWebhook;
      globalThis.fetch = originalFetch;
      cancelingDatabase.close();
      ownerDatabase.close();
    }
  });

  it('aborts the subprocess when the lease heartbeat can no longer renew ownership', async () => {
    const { directory } = fakeAgentDirectory(
      `trap 'exit 143' TERM\nwhile true; do /bin/sleep 0.1; done`,
      'exit 1',
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Lease ownership loss', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'codex', 'codex', 'Wait until ownership is lost.');
    vi.spyOn(repository, 'renewRunLease').mockReturnValue(false);

    try {
      await executeAgentRun(repository, run, 'stale-owner', 3_000);
      expect(isAgentRunActive(run.id)).toBe(false);
      expect(repository.getRun(run.id)?.status).toBe('running');
    } finally {
      database.close();
    }
  });

  it('does not immediately cancel an explicitly retried run after clearing the stale request', async () => {
    const completed = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Retry completed' } });
    const { directory } = fakeAgentDirectory(`printf '%s\\n' '${completed}'`, 'exit 1');
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Retry canceled run', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'codex', 'codex', 'Try again.');
    repository.claimRun(run.id, 'first-owner', 60_000);
    repository.requestRunCancellation(run.id);
    repository.updateRun(run.id, { status: 'canceled', completedAt: new Date().toISOString() });
    const retried = repository.prepareRunRetry(run.id)!;

    try {
      await executeAgentRun(repository, retried, 'retry-owner', 3_000);
      expect(repository.getRun(run.id)).toEqual(expect.objectContaining({ status: 'completed', output: 'Retry completed' }));
    } finally {
      database.close();
    }
  });

  it('terminates and settles when spawning the child emits an error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-agent-missing-'));
    temporaryDirectories.push(directory);
    process.env.PATH = directory;

    await expect(runAgentCommandWithFallback('codex', directory, 'Fail to spawn.')).rejects.toThrow(/ENOENT|spawn codex/);
  });

  it('sums Claude per-message usage and lets the terminal result event supersede it', async () => {
    // Two assistant messages plus a terminal result. Before this change reportUsage
    // overwrote on each event, so a multi-turn run kept only the last message.
    const assistantOne = '{"type":"assistant","message":{"usage":{"input_tokens":100,"output_tokens":40}}}';
    const assistantTwo = '{"type":"assistant","message":{"usage":{"input_tokens":200,"output_tokens":60}}}';
    const result = '{"type":"result","result":"done","usage":{"input_tokens":300,"output_tokens":100}}';
    fakeAgentDirectory('exit 1', `cat > /dev/null\nprintf '%s\\n%s\\n%s\\n' '${assistantOne}' '${assistantTwo}' '${result}'`);

    const run = await runAgentCommandWithFallback('claude', tmpdir(), 'Report usage.');

    expect(run.usage.inputTokens).toBe(300);
    expect(run.usage.outputTokens).toBe(100);
  });

  it('counts repeated Claude stream blocks for one provider request once', async () => {
    // Claude emits an assistant event for each content block. Text, thinking,
    // and tool blocks from the same request share requestId/message.id and
    // repeat the same usage. Counting each replica manufactured million-token
    // runs from roughly 150K tokens of actual provider traffic.
    const duplicateOne = JSON.stringify({ type: 'assistant', requestId: 'req-one', message: { id: 'msg-one', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 2 } } });
    const duplicateTwo = JSON.stringify({ type: 'assistant', requestId: 'req-one', message: { id: 'msg-one', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 2 } } });
    const nextRequest = JSON.stringify({ type: 'assistant', requestId: 'req-two', message: { id: 'msg-two', usage: { input_tokens: 20, cache_read_input_tokens: 180, output_tokens: 3 } } });
    fakeAgentDirectory('exit 1', `printf '%s\\n%s\\n%s\\n' '${duplicateOne}' '${duplicateTwo}' '${nextRequest}'`);

    const run = await runAgentCommandWithFallback('claude', tmpdir(), 'Report usage.');

    expect(run.usage.inputTokens).toBe(30);
    expect(run.usage.cacheReadInputTokens).toBe(270);
    expect(run.usage.outputTokens).toBe(5);
  });

  it('bounds large prompt sections while retaining the beginning and conclusion', () => {
    const compacted = compactPromptSection(`START ${'x'.repeat(20_000)} END`, 2_000);
    expect(compacted.length).toBeLessThan(2_100);
    expect(compacted).toContain('START');
    expect(compacted).toContain('END');
    expect(compacted).toContain('compacted for this turn');
  });

  it('infers the workspace from real paths in task context', () => {
    expect(resolveWorkingDirectory(item('Trim knowledge copy', 'Edit ~/notes/knowledge/index.md and preserve its conventions.')))
      .toBe(join(homedir(), 'notes/knowledge'));
  });

  it('allows an unlinked task resolved to the Workbench checkout to run there', () => {
    expect(resolveWorkingDirectory({ ...item('Fix Writer connectors'), projectName: 'Writer', workspacePath: process.cwd() }))
      .toBe(process.cwd());
  });

  it('allows a task to run from an explicit non-repository directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-repositoryless-task-'));
    temporaryDirectories.push(directory);

    expect(resolveWorkingDirectory({ ...item('Research Palmyra access'), projectName: null, workspacePath: directory }))
      .toBe(directory);
  });

  it('recovers a deleted Workbench subdirectory to the repository root', () => {
    const staleSubdirectory = join(process.cwd(), 'src/client/features/diff/views');
    expect(resolveWorkingDirectory({ ...item('Fix Changes panel'), projectName: 'Workbench', workspacePath: staleSubdirectory }))
      .toBe(process.cwd());
  });

  it('routes coding and review work to Codex', () => {
    expect(classifyExecution(item('Implement the connector UI')).kind).toBe('execute');
    expect(classifyExecution(item('Review PR for regressions')).kind).toBe('review');
  });

  it('does not confuse reading context with a code-review task', () => {
    expect(classifyExecution(item('Write CON-159 tech spec', 'Review all Markdown docs first, then write the proposal.')).kind).toBe('strategy');
    expect(classifyExecution(item('Fix the regression after reviewing the implementation')).kind).toBe('execute');
    expect(classifyExecution(item('Review architecture notes and create a summary')).kind).toBe('execute');
    expect(classifyExecution(item('Implement the connectors UI', 'Follow the approved design spec and proposal.')).kind).toBe('execute');
  });

  it('uses the model classifier for ambiguous tasks', async () => {
    let calls = 0;
    const result = await classifyExecutionRobust(item('Handle connector ownership'), async () => { calls += 1; return '<classification>{"kind":"research","complex":false,"reason":"Unknowns must be investigated."}</classification>'; });
    expect(result.kind).toBe('research');
    expect(calls).toBe(1);
    await classifyExecutionRobust(item('Review PR 5246'), async () => { calls += 1; return '<classification>{"kind":"review","complex":false,"reason":"The deliverable is PR findings."}</classification>'; });
    expect(calls).toBe(2);
  });

  it('never lets the model relabel an explicit imperative deliverable', async () => {
    const wrongResearchAnswer = async () => '<classification>{"kind":"research","complex":false,"reason":"Context should be inspected first."}</classification>';
    await expect(classifyExecutionRobust(item('Publish all Markdown artifacts'), wrongResearchAnswer)).resolves.toEqual(expect.objectContaining({ kind: 'execute' }));
    await expect(classifyExecutionRobust(item('Fix the connector modal'), wrongResearchAnswer)).resolves.toEqual(expect.objectContaining({ kind: 'execute' }));
    await expect(classifyExecutionRobust(item('Deploy the approved preview'), wrongResearchAnswer)).resolves.toEqual(expect.objectContaining({ kind: 'execute' }));
  });

  it('uses explicit research, strategy, and analysis imperatives', () => {
    expect(classifyExecution(item('Investigate connector pagination')).kind).toBe('research');
    expect(classifyExecution(item('Plan the connector migration strategy')).kind).toBe('strategy');
    expect(classifyExecution(item('Summarize the onboarding notes')).kind).toBe('analysis');
  });

  it('turns a model complexity judgment into a required multi-task decomposition', async () => {
    const result = await classifyExecutionRobust(item('Rework connector authentication across the control plane'), async () =>
      '<classification>{"kind":"execute","complex":true,"reason":"It spans independently deployable systems."}</classification>');

    expect(result.kind).toBe('strategy');
    expect(result.complex).toBe(true);
    expect(result.instructions).toContain('at least two independently executable follow-up tasks');
    expect(result.instructions).toContain('Do not implement yet');
  });

  it('honors a manually selected task type without invoking classification heuristics', () => {
    expect(classificationForKind(item('Implement a connector'), 'research')).toEqual(expect.objectContaining({ kind: 'research', complex: false }));
    expect(classificationForKind(item('Summarize a proposal'), 'execute')).toEqual(expect.objectContaining({ kind: 'execute', complex: false }));
    expect(classificationForKind(item('The task-type dropdown is missing Bug fix'), 'bugfix')).toEqual(expect.objectContaining({ kind: 'bugfix', complex: false }));
  });

  it('uses a dedicated persona for every run kind', () => {
    const expectedPersonas = {
      research: 'researcher', analysis: 'codebase-analyst', strategy: 'implementation-planner',
      execute: 'frontend-engineer', review: 'frontend-reviewer', bugfix: 'bug-investigator',
    } as const;
    for (const [kind, persona] of Object.entries(expectedPersonas)) {
      expect(buildPrompt(item('Inspect the task type UI'), { agent: 'codex', kind, instructions: '' } as AgentRun))
        .toContain(`Authoritative persona: ${persona}`);
    }
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
    expect(buildPrompt(item('Build it'), run)).toContain('no permission prompts or dialogs exist to approve');
  });

  it('makes durable recall frequent but non-mandatory for context-heavy task types', () => {
    expect(RUNNER_SYSTEM_CONTRACT).toContain('recall_context');
    expect(RUNNER_SYSTEM_CONTRACT).toContain('research, analysis, strategy, and bug-fix');
    expect(RUNNER_SYSTEM_CONTRACT).toContain('normally make one focused recall near the start');
    expect(RUNNER_SYSTEM_CONTRACT).toContain('not a mandatory preflight');
  });

  it('passes context handles to the agent without ambient retrieval payloads', () => {
    const task = item('Continue the token-bloat fix');
    const run = { agent: 'codex', kind: 'analysis', instructions: 'Assess prior approaches.', conversationId: 'conversation-id', messageId: 'message-id' } as AgentRun;
    const prompt = buildPrompt(task, run, 'Current shared brief.');

    expect(prompt).toContain(`Work item ID: ${task.id}`);
    expect(prompt).toContain('Conversation ID: conversation-id');
    expect(prompt).toContain('Current reply message ID: message-id');
    expect(prompt).toContain('recall_context');
    expect(prompt).not.toContain('Retrieved memory (');
  });

  it('turns Codex and Claude JSON events into readable live progress', () => {
    expect(readableAgentEvent('codex', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } })).progress).toBe('● Running tests');
    expect(readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'App.tsx' } }] } })).progress).toBe('● Reading App.tsx');
    const forwardedSubagentText = readableAgentEvent('claude', JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_subagent', message: { content: [{ type: 'text', text: 'I found the failing test.' }] } }));
    // Forwarded subagent text is now attributed to its worker: delegated work
    // must be traceable rather than read as the parent agent's own.
    expect(forwardedSubagentText).toEqual(expect.objectContaining({ progress: '[subagent] I found the failing test.', final: null }));
    expect(readableAgentEvent('claude', JSON.stringify({ type: 'system', subtype: 'init' })).progress).toBe('');
    expect(readableAgentEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'The failing test points to stale state.' } })).progress).toContain('Reasoning summary');
  });

  it('records a Why while allowing bounded related checks to share one tool call', () => {
    expect(AGENT_DEBUGGER_CONTRACT).toContain('Before each tool call');
    expect(AGENT_DEBUGGER_CONTRACT).toContain('bounded batch of directly related read-only checks');
    expect(AGENT_DEBUGGER_CONTRACT).toContain('unrelated later call');
  });

  it('extracts audit candidates for file reads, writes, and tool use out of the same parsed events', () => {
    const claudeDecision = readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Decision: The error may be in the route, so read it before editing.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'App.tsx' } }] } }));
    expect(claudeDecision.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ streamKind: 'decision', detail: 'The error may be in the route, so read it before editing.' }),
      expect.objectContaining({ streamKind: 'file_read', detail: 'App.tsx' }),
    ]));

    const claudeRead = readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'App.tsx' } }] } }));
    expect(claudeRead.audit).toEqual([expect.objectContaining({ category: 'agent_file_read', streamKind: 'file_read', detail: 'App.tsx' })]);

    const claudeWrite = readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } }] } }));
    expect(claudeWrite.audit).toEqual([expect.objectContaining({ category: 'agent_file_write', streamKind: 'file_write', detail: 'src/app.ts' })]);

    const claudeBash = readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }));
    expect(claudeBash.audit).toEqual([expect.objectContaining({ category: 'agent_tool_use', streamKind: 'tool', detail: 'Bash' })]);

    const codexCommand = readableAgentEvent('codex', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }));
    expect(codexCommand.audit).toEqual([expect.objectContaining({ category: 'agent_tool_use', streamKind: 'tool', detail: 'command_execution: npm test' })]);

    const codexFileChange = readableAgentEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/foo.ts', kind: 'update' }] } }));
    expect(codexFileChange.audit).toEqual([expect.objectContaining({ category: 'agent_file_write', streamKind: 'file_write', detail: 'update: src/foo.ts' })]);

    const codexDecision = readableAgentEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decision: Confirm the focused test still passes.' } }));
    expect(codexDecision.audit).toEqual([expect.objectContaining({ streamKind: 'decision', detail: 'Confirm the focused test still passes.' })]);

    const multiLineClaudeText = readableAgentEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Decision: Inspect the route.\n\nThe route is large.' }] } }));
    expect(multiLineClaudeText.audit).toEqual([expect.objectContaining({ streamKind: 'decision', detail: 'Inspect the route.' })]);

    expect(readableAgentEvent('claude', JSON.stringify({ type: 'system', subtype: 'init' })).audit).toEqual([]);
  });

  it('keeps a codex Decision preamble out of the composed final reply while still streaming it live', () => {
    const decisionEvent = readableAgentEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decision: Confirm the focused test still passes.' } }));
    expect(decisionEvent.final).toBeNull();
    expect(decisionEvent.progress).toBe('Decision: Confirm the focused test still passes.');

    const replyEvent = readableAgentEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixed the failing test.' } }));
    expect(replyEvent.final).toBe('Fixed the failing test.');
  });

  it('spawns agent subprocesses with an allowlisted environment, never Workbench secrets', () => {
    const spawnedEnv = agentSubprocessEnv({
      ...process.env,
      WORKBENCH_TOKEN: 'workbench-secret',
      LINEAR_API_KEY: 'linear-secret',
      GITHUB_TOKEN: 'github-secret',
    } as NodeJS.ProcessEnv);
    expect(spawnedEnv.WORKBENCH_TOKEN).toBeUndefined();
    expect(spawnedEnv.LINEAR_API_KEY).toBeUndefined();
    expect(spawnedEnv.GITHUB_TOKEN).toBeUndefined();
    if (process.env.PATH) expect(spawnedEnv.PATH).toBe(process.env.PATH);
    if (process.env.HOME) expect(spawnedEnv.HOME).toBe(process.env.HOME);
  });

  describe('error classification and backoff', () => {
    it('classifies network/transport failures as transient', () => {
      expect(isTransientAgentError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
      expect(isTransientAgentError(new Error('socket hang up'))).toBe(true);
      expect(isTransientAgentError(new Error('request timed out'))).toBe(true);
      expect(isTransientAgentError(new Error('503 Service Unavailable'))).toBe(true);
    });

    it('does not classify capacity errors or ordinary content failures as transient', () => {
      expect(isTransientAgentError(new Error('429 too many requests, usage limit hit'))).toBe(false);
      expect(isTransientAgentError(new Error('Agent returned an invalid task decomposition.'))).toBe(false);
      expect(isTransientAgentError(new Error('Every planned task needs a title and description.'))).toBe(false);
    });

    it('backoffDelayMs grows with attempt number and stays within the configured cap', () => {
      const first = backoffDelayMs(1, 1_000, 60_000);
      const second = backoffDelayMs(2, 1_000, 60_000);
      const large = backoffDelayMs(10, 1_000, 60_000);
      expect(first).toBeGreaterThanOrEqual(1_000);
      expect(second).toBeGreaterThan(first - 1_000); // jitter makes exact comparison unreliable, but exponential base grows
      expect(large).toBeLessThanOrEqual(60_000);
    });
  });
});
