import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeAgentRun } from './agent-runner.js';
import { openDatabase } from './database.js';
import { runPalmyraAgent } from './palmyra-agent.js';
import { WorkItemRepository } from './repository.js';

const streamChatWithPalmyra = vi.hoisted(() => vi.fn());
vi.mock('./providers/palmyra.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/palmyra.js')>()),
  streamChatWithPalmyra,
}));
vi.mock('./review-auto-score.js', () => ({
  scheduleReviewAutoScore: vi.fn(async () => {}),
  reviewAutoScoreSnapshot: () => null,
  resetReviewAutoScore: () => {},
}));

const workspaces: string[] = [];
afterEach(() => {
  streamChatWithPalmyra.mockReset();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe('Palmyra durable agent runs', () => {
  it('executes tools and completes a directly dispatched run', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'palmyra-run-'));
    workspaces.push(workspace);
    streamChatWithPalmyra
      .mockResolvedValueOnce({ content: null, toolCalls: [{ id: 'write-direct', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'direct.txt', content: 'direct run\n' }) } }], usage: { inputTokens: 10, outputTokens: 4 }, finishReason: 'tool_calls' })
      .mockResolvedValueOnce({ content: 'Implemented the direct run edit.', toolCalls: [], usage: { inputTokens: 12, outputTokens: 5 }, finishReason: 'stop' });
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Create a file', description: '', priority: 1, status: 'ready', projectName: 'Test', workspacePath: workspace, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'palmyra', 'palmyra', 'Create direct.txt.');

    await executeAgentRun(repository, run, 'palmyra-test-owner', 60_000);

    expect(repository.getRun(run.id)).toMatchObject({ status: 'completed', agent: 'palmyra', model: 'palmyra-x5', inputTokens: 22, outputTokens: 9, output: 'Implemented the direct run edit.' });
    expect(readFileSync(join(workspace, 'direct.txt'), 'utf8')).toBe('direct run\n');
    const diagnostics = database.prepare('SELECT kind FROM agent_run_diagnostics WHERE run_id = ? ORDER BY created_at').all(run.id) as Array<{ kind: string }>;
    expect(diagnostics.map((event) => event.kind)).toEqual(expect.arrayContaining(['prompt', 'usage', 'tool']));
    const insights = repository.getRunInsights();
    expect(insights.byAgent).toContainEqual(expect.objectContaining({ agent: 'palmyra', total: 1, completed: 1 }));
    expect(insights.agentFit).toContainEqual(expect.objectContaining({ agent: 'palmyra', kind: 'execute', completed: 1 }));
    database.close();
  });

  it('reads and writes outside its starting workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'palmyra-start-'));
    const siblingRepository = mkdtempSync(join(tmpdir(), 'palmyra-sibling-repo-'));
    workspaces.push(workspace, siblingRepository);
    const target = join(siblingRepository, 'cross-repo.txt');
    streamChatWithPalmyra
      .mockResolvedValueOnce({ content: null, toolCalls: [{ id: 'write-sibling', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: target, content: 'cross-repo access\n' }) } }], usage: { inputTokens: 10, outputTokens: 4 }, finishReason: 'tool_calls' })
      .mockResolvedValueOnce({ content: null, toolCalls: [{ id: 'read-sibling', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: target }) } }], usage: { inputTokens: 12, outputTokens: 4 }, finishReason: 'tool_calls' })
      .mockResolvedValueOnce({ content: 'Cross-repository access verified.', toolCalls: [], usage: { inputTokens: 14, outputTokens: 5 }, finishReason: 'stop' });

    const result = await runPalmyraAgent({ cwd: workspace, prompt: 'Write and read the sibling repository file.', workbenchTools: null });

    expect(result.output).toBe('Cross-repository access verified.');
    expect(readFileSync(target, 'utf8')).toBe('cross-repo access\n');
    expect(streamChatWithPalmyra.mock.calls[2][0].messages).toContainEqual(expect.objectContaining({ role: 'tool', content: expect.stringContaining('cross-repo access') }));
  });

  it('keeps working beyond the former 48-round ceiling and can use the Workbench MCP tool surface', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'palmyra-uncapped-'));
    workspaces.push(workspace);
    const toolCall = { id: 'workbench-call', type: 'function' as const, function: { name: 'list_work_items', arguments: '{}' } };
    for (let round = 0; round < 49; round += 1) {
      streamChatWithPalmyra.mockResolvedValueOnce({ content: null, toolCalls: [toolCall], usage: { inputTokens: 10, outputTokens: 1 }, finishReason: 'tool_calls' });
    }
    streamChatWithPalmyra.mockResolvedValueOnce({ content: 'All 49 tool rounds completed.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 6 }, finishReason: 'stop' });
    const bridge = {
      tools: [{ type: 'function' as const, function: { name: 'list_work_items', description: 'List work.', parameters: { type: 'object' } } }],
      call: vi.fn(async () => 'Tool succeeded:\n[]'),
      close: vi.fn(async () => {}),
    };

    const result = await runPalmyraAgent({ cwd: workspace, prompt: 'Inspect all work.', workbenchTools: bridge });

    expect(streamChatWithPalmyra).toHaveBeenCalledTimes(50);
    expect(bridge.call).toHaveBeenCalledTimes(49);
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(result.output).toBe('All 49 tool rounds completed.');
  });

  it('keeps live activity in progress but stores only the synthesized terminal answer', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'palmyra-final-answer-'));
    workspaces.push(workspace);
    const progress: string[] = [];
    streamChatWithPalmyra
      .mockImplementationOnce(async (_request, callbacks) => {
        callbacks.onContent('Decision: Inspect the relevant file.', 'Decision: Inspect the relevant file.');
        return { content: 'Decision: Inspect the relevant file.', toolCalls: [{ id: 'read-final', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'missing.txt' }) } }], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'tool_calls' };
      })
      .mockImplementationOnce(async (_request, callbacks) => {
        const content = 'Decision: The inspection is complete.\n\nThe requested behavior is now verified.';
        callbacks.onContent(content, content);
        return { content, toolCalls: [], usage: { inputTokens: 12, outputTokens: 8 }, finishReason: 'stop' };
      });

    const result = await runPalmyraAgent({ cwd: workspace, prompt: 'Inspect the file.', workbenchTools: null, onProgress: (value) => progress.push(value) });

    expect(progress.some((value) => value.includes('Decision: Inspect the relevant file.'))).toBe(true);
    expect(progress.at(-1)).toContain('Decision: The inspection is complete.');
    expect(result.output).toBe('The requested behavior is now verified.');
    expect(result.output).not.toContain('Palmyra used');
    expect(result.output).not.toContain('Decision:');
  });

  it('does not mislabel a progress-only terminal response as the final answer', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'palmyra-progress-only-'));
    workspaces.push(workspace);
    streamChatWithPalmyra.mockResolvedValueOnce({ content: 'Decision: The work is complete.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop' });

    await expect(runPalmyraAgent({ cwd: workspace, prompt: 'Complete the work.', workbenchTools: null }))
      .rejects.toThrow('Palmyra returned progress but no synthesized final response.');
  });

  it('continues a provider-length stop and sends image attachments in the same user turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'palmyra-image-'));
    workspaces.push(workspace);
    const imagePath = join(workspace, 'reference.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    streamChatWithPalmyra
      .mockResolvedValueOnce({ content: 'First half', toolCalls: [], usage: { inputTokens: 20, outputTokens: 8 }, finishReason: 'length' })
      .mockResolvedValueOnce({ content: 'second half', toolCalls: [], usage: { inputTokens: 22, outputTokens: 5 }, finishReason: 'stop' });

    const result = await runPalmyraAgent({
      cwd: workspace,
      prompt: 'Describe the image.',
      imageAttachments: [{ path: imagePath, mimeType: 'image/png', name: 'reference.png' }],
      workbenchTools: null,
    });

    const firstRequest = streamChatWithPalmyra.mock.calls[0][0];
    expect(firstRequest.maxTokens).toBe(8_192);
    expect(firstRequest.messages[1].content).toEqual([
      { type: 'text', text: 'Describe the image.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
    ]);
    expect(streamChatWithPalmyra.mock.calls[1][0].messages).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringMatching(/Continue exactly/) }));
    expect(result.output).toBe('First half\n\nsecond half');
    expect(JSON.stringify(result.messages)).not.toContain('base64');
  });
});
