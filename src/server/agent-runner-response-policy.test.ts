import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

import { executeAgentRun } from './agent-runner.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
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

describe('task-run final response supervision', () => {
  afterEach(() => {
    delete process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY;
    vi.clearAllMocks();
  });

  it('edits the task result before the run is completed', async () => {
    process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY = '1';
    editFinalResponse.mockResolvedValue('Problem: The cache was stale. Solution: I traced the invalidation path. Context: No files changed.');
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
      output: 'Problem: The cache was stale. Solution: I traced the invalidation path. Context: No files changed.',
    });
    expect(editFinalResponse).toHaveBeenCalledWith(expect.stringContaining('\n\n'), 'Inspect stale cache\nFind the cause.', { verbose: false });
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
