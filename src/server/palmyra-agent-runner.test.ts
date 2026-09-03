import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeAgentRun } from './agent-runner.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';

const chatWithPalmyra = vi.hoisted(() => vi.fn());
vi.mock('./providers/palmyra.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/palmyra.js')>()),
  chatWithPalmyra,
}));
vi.mock('./review-auto-score.js', () => ({
  scheduleReviewAutoScore: vi.fn(async () => {}),
  reviewAutoScoreSnapshot: () => null,
  resetReviewAutoScore: () => {},
}));

const workspaces: string[] = [];
afterEach(() => {
  chatWithPalmyra.mockReset();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe('Palmyra durable agent runs', () => {
  it('executes tools and completes a directly dispatched run', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'palmyra-run-'));
    workspaces.push(workspace);
    chatWithPalmyra
      .mockResolvedValueOnce({ content: null, toolCalls: [{ id: 'write-direct', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'direct.txt', content: 'direct run\n' }) } }], usage: { inputTokens: 10, outputTokens: 4 } })
      .mockResolvedValueOnce({ content: 'Implemented the direct run edit.', toolCalls: [], usage: { inputTokens: 12, outputTokens: 5 } });
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Create a file', description: '', priority: 1, status: 'ready', projectName: 'Test', workspacePath: workspace, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'palmyra', 'palmyra', 'Create direct.txt.');

    await executeAgentRun(repository, run, 'palmyra-test-owner', 60_000);

    expect(repository.getRun(run.id)).toMatchObject({ status: 'completed', agent: 'palmyra', model: 'palmyra-x5', inputTokens: 22, outputTokens: 9 });
    expect(readFileSync(join(workspace, 'direct.txt'), 'utf8')).toBe('direct run\n');
    const diagnostics = database.prepare('SELECT kind FROM agent_run_diagnostics WHERE run_id = ? ORDER BY created_at').all(run.id) as Array<{ kind: string }>;
    expect(diagnostics.map((event) => event.kind)).toEqual(expect.arrayContaining(['prompt', 'usage', 'tool']));
    const insights = repository.getRunInsights();
    expect(insights.byAgent).toContainEqual(expect.objectContaining({ agent: 'palmyra', total: 1, completed: 1 }));
    expect(insights.agentFit).toContainEqual(expect.objectContaining({ agent: 'palmyra', kind: 'execute', completed: 1 }));
    database.close();
  });
});
