import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeAgentRun } from './agent-runner.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { buildReviewHarness } from '../shared/review-harness.js';
import { getWorkspaceDiff } from './workspace-diff.js';
import { fakeAgentDirectory } from './test-fake-agent.js';

const editFinalResponse = vi.hoisted(() => vi.fn());
vi.mock('./final-response-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./final-response-policy.js')>()),
  editFinalResponse,
}));
vi.mock('./review-auto-score.js', () => ({
  scheduleReviewAutoScore: vi.fn(async () => {}),
  reviewAutoScoreSnapshot: () => null,
  resetReviewAutoScore: () => {},
}));

// Fake-agent tests replace PATH wholesale; the harness tests still need git.
const SYSTEM_PATH = process.env.PATH;

describe('task-run final response supervision', () => {
  afterEach(() => {
    delete process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY;
    vi.clearAllMocks();
  });

  it('edits the task result before the run is completed', async () => {
    process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY = '1';
    editFinalResponse.mockResolvedValue('## Problem\nThe cache was stale.\n\n## Solution\nI traced the invalidation path.\n\n## Context\nNo files changed.');
    const { directory } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'The cache was stale.\n\nI traced the invalidation path.' } })}'`,
      'exit 1',
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Inspect stale cache', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'analysis', 'codex', 'codex', 'Find the cause.');

    await executeAgentRun(repository, run, 'test-owner', 60_000);

    expect(repository.getRun(run.id)).toMatchObject({
      status: 'completed',
      output: '## Problem\nThe cache was stale.\n\n## Solution\nI traced the invalidation path.\n\n## Context\nNo files changed.',
    });
    expect(editFinalResponse).toHaveBeenCalledWith(expect.stringContaining('\n\n'), 'Inspect stale cache\nFind the cause.', { verbose: false });
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('never lets final-response formatting remove review passes', async () => {
    process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY = '1';
    editFinalResponse.mockResolvedValue('## Problem\nReview the PR.\n\n## Solution\nFive comment drafts.\n\n## Context\nNo additional context.');
    const ledger = { version: 1, passes: [1, 2, 3, 4, 5].map((pass) => ({ pass, clear: [], findings: [{ decision: 0, severity: 'non-blocking', finding: `src/a.ts:${pass} has a concrete issue.` }] })) };
    const review = `${[1, 2, 3, 4, 5].map((pass) => (
      `### Pass ${pass}\n\n- **Non-blocking:** src/a.ts:${pass} has a concrete issue. Correct it.`
    )).join('\n\n')}\n\n<review-ledger>${JSON.stringify(ledger)}</review-ledger>`;
    const { directory } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: review } })}'`,
      'exit 1',
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Review PR 5371', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'review', 'codex', 'codex', 'Review the remote PR.');

    await executeAgentRun(repository, run, 'test-owner', 60_000);

    const output = repository.getRun(run.id)?.output ?? '';
    expect(repository.getRun(run.id)?.status).toBe('completed');
    expect(output).toContain('## Problem');
    expect(output).toContain('## Solution');
    expect(output).toContain('### Pass 1');
    expect(output).toContain('### Pass 5');
    expect(output).not.toContain('Five comment drafts.');
    expect(output).not.toContain('review-ledger');
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs the review harness over the Review Director queue and records verdicts without overwriting Jeffrey', async () => {
    const originalPath = SYSTEM_PATH;
    process.env.PATH = SYSTEM_PATH;
    const checkout = mkdtempSync(join(tmpdir(), 'workbench-review-harness-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: checkout });
    git('init', '-q');
    writeFileSync(join(checkout, 'auth.ts'), 'export function gate(request: Request) {\n  return deny(request);\n}\n');
    writeFileSync(join(checkout, 'format.ts'), 'export function label(value: string) {\n  return value.trim();\n}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    writeFileSync(join(checkout, 'auth.ts'), 'export function gate(request: Request) {\n  return allow(request);\n}\n');
    writeFileSync(join(checkout, 'format.ts'), 'export function label(value: string) {\n  return value.trim().toLowerCase();\n}\n');
    const diff = await getWorkspaceDiff(checkout);
    const expected = buildReviewHarness({ source: { kind: 'workspace', workspacePath: checkout }, revision: diff.revision, files: diff.files, reviews: [] });
    const [authDecision, formatDecision] = ['auth.ts', 'format.ts'].map((path) => expected.required.find((decision) => decision.hunks[0].filePath === path)!);
    const ordinals = expected.required.map((decision) => decision.ordinal);
    const ledger = { version: 1, passes: [1, 2, 3, 4, 5].map((pass) => pass === 5
      ? { pass, clear: [], findings: ordinals.map((decision) => ({ decision, severity: 'blocking', finding: `D${decision} lets a refused request through.` })) }
      : { pass, clear: ordinals, findings: [] }) };
    const review = `Reject.\n\n${[1, 2, 3, 4].map((pass) => `### Pass ${pass}\nNo material issues.`).join('\n\n')}\n\n### Pass 5\n- Blocking: auth.ts:2 now allows refused requests. Restore deny.\n\n<review-ledger>${JSON.stringify(ledger)}</review-ledger>`;
    const { directory } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: review } })}'`,
      'exit 1',
    );
    process.env.PATH = `${directory}:${originalPath}`;
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Review the auth change', description: '', priority: 1, status: 'ready', projectName: 'Harness', workspacePath: checkout, dueDate: null });
    // Jeffrey already approved the formatting change by hand.
    repository.upsertDiffHunkReviews({ workItemId: task.id }, { revision: diff.revision, hunks: formatDecision.hunks, state: 'reviewed' });
    const run = repository.createRun(task.id, 'review', 'codex', 'codex', 'Review the local change.');

    try {
      await executeAgentRun(repository, run, 'test-owner', 60_000);

      const completed = repository.getRun(run.id);
      expect(completed?.status, completed?.error ?? '').toBe('completed');
      expect(completed?.output).not.toContain('review-ledger');
      expect(completed?.output).toContain('### Pass 5');
      const verdicts = repository.listDiffHunkReviews({ workItemId: task.id }, diff.revision);
      expect(verdicts.find((row) => row.filePath === 'auth.ts')).toMatchObject({ state: 'needs_changes', note: expect.stringMatching(/^Agent review \(codex, run [0-9a-f-]{8}\):\nPass 5 Blocking: D\d+ lets a refused request through\.$/) });
      expect(verdicts.find((row) => row.filePath === 'format.ts')).toMatchObject({ state: 'reviewed', note: null });
      const activity = repository.listActivity(task.id).map((entry) => entry.body);
      expect(activity).toContain('Review harness v1: 2 Review Director decision(s) × 5 passes required; 0 settled by proof.');
      expect(activity).toContain('Review harness passed: every decision was checked in all five passes. 1 verdict(s) recorded in the review queue; 1 left alone because Jeffrey or the Review Director already decided them.');
      expect(authDecision.tier).toBe('T3');
    } finally {
      process.env.PATH = originalPath;
      database.close();
      rmSync(directory, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('retries a review whose ledger skips a decision and fails the run if the retry still skips it', async () => {
    const originalPath = SYSTEM_PATH;
    process.env.PATH = SYSTEM_PATH;
    const checkout = mkdtempSync(join(tmpdir(), 'workbench-review-harness-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: checkout });
    git('init', '-q');
    writeFileSync(join(checkout, 'auth.ts'), 'export function gate(request: Request) {\n  return deny(request);\n}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    writeFileSync(join(checkout, 'auth.ts'), 'export function gate(request: Request) {\n  return allow(request);\n}\n');
    const ledger = { version: 1, passes: [1, 2, 3, 4, 5].map((pass) => ({ pass, clear: [], findings: [] })) };
    const review = `Approve.\n\n${[1, 2, 3, 4, 5].map((pass) => `### Pass ${pass}\nNo material issues.`).join('\n\n')}\n\n<review-ledger>${JSON.stringify(ledger)}</review-ledger>`;
    const { directory, log } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: review } })}'`,
      'exit 1',
    );
    process.env.PATH = `${directory}:${originalPath}`;
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Review the auth change', description: '', priority: 1, status: 'ready', projectName: 'Harness', workspacePath: checkout, dueDate: null });
    const run = repository.createRun(task.id, 'review', 'codex', 'codex', 'Review the local change.');

    try {
      await executeAgentRun(repository, run, 'test-owner', 60_000);

      const failed = repository.getRun(run.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toMatch(/Review failed the review harness: Pass 1 skipped D\d+\./);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['codex', 'codex']);
    } finally {
      process.env.PATH = originalPath;
      database.close();
      rmSync(directory, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('completes instead of failing when a brevity-only retry remains over 120 words', async () => {
    process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY = '1';
    const longDraft = Array.from({ length: 168 }, (_, index) => `word${index}`).join(' ');
    editFinalResponse.mockResolvedValue('## Problem\nThe response was long.\n\n## Solution\nThe complete result is preserved.\n\n## Context\nBrevity did not fail the turn.');
    const { directory, log } = fakeAgentDirectory(
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: longDraft } })}'`,
      'exit 1',
    );
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Explain the result', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: directory, dueDate: null });
    const run = repository.createRun(task.id, 'analysis', 'codex', 'codex', 'Explain the result.');

    await executeAgentRun(repository, run, 'test-owner', 60_000);

    const completed = repository.getRun(run.id);
    expect(completed).toMatchObject({
      status: 'completed',
      output: expect.stringContaining('Brevity did not fail the turn.'),
    });
    expect(completed?.error).toBeFalsy();
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
