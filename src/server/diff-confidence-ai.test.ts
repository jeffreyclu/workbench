import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { openDatabase } from './database.js';
import { parseDiffConfidenceAssessment } from './diff-confidence-ai.js';

describe('parseDiffConfidenceAssessment', () => {
  it('keeps only validated integer scores for every requested block', () => {
    expect(parseDiffConfidenceAssessment('[{"key":"a","risk":82,"reasoning":"Visible guard covers the branch."},{"key":"b","risk":11,"reasoning":"No visible caller checks the result."},{"key":"extra","risk":99,"reasoning":"Ignored."}]', ['a', 'b'])).toEqual({ a: { risk: 82, reasoning: 'Visible guard covers the branch.' }, b: { risk: 11, reasoning: 'No visible caller checks the result.' } });
  });

  it('unwraps the Claude CLI JSON envelope before parsing the model result', () => {
    const output = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '```json\n[{"key":"a","risk":82,"reasoning":"Visible path is covered."},{"key":"b","risk":11,"reasoning":"No visible test covers this."}]\n```',
    });

    expect(parseDiffConfidenceAssessment(output, ['a', 'b'])).toEqual({ a: { risk: 82, reasoning: 'Visible path is covered.' }, b: { risk: 11, reasoning: 'No visible test covers this.' } });
  });

  it('rejects missing, fractional, and out-of-range scores', () => {
    expect(() => parseDiffConfidenceAssessment('[{"key":"a","risk":50,"reasoning":"Covered."}]', ['a', 'b'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('[{"key":"a","risk":50.5,"reasoning":"Covered."}]', ['a'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('[{"key":"a","risk":101,"reasoning":"Covered."}]', ['a'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('[{"key":"a","risk":50,"reasoning":""}]', ['a'])).toThrow();
  });
});

describe('assessDiffBlocks caching', () => {
  it('scores comment-only blocks locally without spawning Claude', async () => {
    vi.resetModules();
    const spawn = vi.fn();
    vi.doMock('node:child_process', () => ({ spawn }));
    const { assessDiffBlocks: assess } = await import('./diff-confidence-ai.js');
    const database = openDatabase(':memory:');

    await expect(assess(database, [{ key: 'comment', lines: ['+// Explain why this branch exists.', '-// Old explanation.'] }])).resolves.toEqual({
      comment: { risk: 0, reasoning: 'Comment-only change; it cannot alter runtime behavior.' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns visible conservative assessments when the scorer fails', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: () => void }; kill: () => void };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.stdin = Object.assign(new EventEmitter(), { write: () => {} });
        emitter.kill = () => {};
        queueMicrotask(() => emitter.emit('error', new Error('scorer unavailable')));
        return emitter;
      },
    }));
    const { assessDiffBlocks: assess } = await import('./diff-confidence-ai.js');
    const database = openDatabase(':memory:');

    await expect(assess(database, [{ key: 'changed', lines: ['+const enabled = true;'] }])).resolves.toEqual({
      changed: { risk: null, reasoning: 'AI assessment unavailable; review this changed block.' },
    });
  });

  it('reuses a cached block score across unrelated batches instead of re-invoking the model', async () => {
    vi.resetModules();
    let spawnCalls = 0;
    vi.doMock('node:child_process', () => ({
      spawn: (..._args: unknown[]) => {
        spawnCalls += 1;
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: (prompt: string) => void } };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.stdin = Object.assign(new EventEmitter(), { write: (prompt: string) => {
          queueMicrotask(() => {
            const input = JSON.parse(prompt) as { message: { content: string } };
            const text = input.message.content;
            const blocks = JSON.parse(text.slice(text.indexOf('Blocks:\n') + 'Blocks:\n'.length)) as Array<{ key: string }>;
            const assessments = blocks.map((block) => ({ key: block.key, risk: 70, reasoning: 'Looks fine.' }));
            emitter.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: JSON.stringify(assessments) })}\n`));
          });
        } });
        return emitter;
      },
    }));
    const { assessDiffBlocks } = await import('./diff-confidence-ai.js');
    const database = openDatabase(':memory:');

    await assessDiffBlocks(database, [{ key: 'shared', lines: ['+const x = 1;'] }, { key: 'unique-1', lines: ['+const y = 2;'] }]);
    // The completed assessment is discarded with its retained chat context
    // and replaced by exactly one clean, warm successor.
    expect(spawnCalls).toBe(5);

    // Same content under a different key in a different batch: still a cache hit, so only the new block is sent.
    const result = await assessDiffBlocks(database, [{ key: 'shared', lines: ['+const x = 1;'] }, { key: 'unique-2', lines: ['+const z = 3;'] }]);
    expect(spawnCalls).toBe(6);
    expect(result.shared).toEqual({ risk: 70, reasoning: 'Looks fine.' });
    expect(result['unique-2']).toEqual({ risk: 70, reasoning: 'Looks fine.' });
  });

  it('persists scores across process restarts by reading from the database on a fresh module instance', async () => {
    vi.resetModules();
    let spawnCalls = 0;
    const mockSpawn = () => ({
      spawn: (..._args: unknown[]) => {
        spawnCalls += 1;
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: (prompt: string) => void } };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.stdin = Object.assign(new EventEmitter(), { write: (prompt: string) => {
          queueMicrotask(() => {
            const input = JSON.parse(prompt) as { message: { content: string } };
            const text = input.message.content;
            const blocks = JSON.parse(text.slice(text.indexOf('Blocks:\n') + 'Blocks:\n'.length)) as Array<{ key: string }>;
            const assessments = blocks.map((block) => ({ key: block.key, risk: 42, reasoning: 'Persisted.' }));
            emitter.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: JSON.stringify(assessments) })}\n`));
          });
        } });
        return emitter;
      },
    });
    vi.doMock('node:child_process', mockSpawn);
    const { assessDiffBlocks: assessFirstProcess } = await import('./diff-confidence-ai.js');
    const database = openDatabase(':memory:');
    await assessFirstProcess(database, [{ key: 'a', lines: ['+const persisted = true;'] }]);
    expect(spawnCalls).toBe(5);

    // Reload the module (simulating a fresh process) but reuse the same database handle.
    vi.resetModules();
    vi.doMock('node:child_process', mockSpawn);
    const { assessDiffBlocks: assessSecondProcess } = await import('./diff-confidence-ai.js');
    const result = await assessSecondProcess(database, [{ key: 'a', lines: ['+const persisted = true;'] }]);
    expect(spawnCalls).toBe(5);
    expect(result.a).toEqual({ risk: 42, reasoning: 'Persisted.' });
  });
});

describe('assessDiffBlocks worker recovery', () => {
  it('requeues a block whose worker dies mid-turn instead of reporting it unscored', async () => {
    vi.resetModules();
    let writes = 0;
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: (prompt: string) => void }; kill: () => void };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.kill = () => {};
        emitter.stdin = Object.assign(new EventEmitter(), { write: (prompt: string) => {
          writes += 1;
          // The first worker to receive a block dies holding it, exactly as a
          // recycled or rate-limited Claude CLI process does in production.
          if (writes === 1) { queueMicrotask(() => emitter.emit('exit')); return; }
          queueMicrotask(() => {
            const input = JSON.parse(prompt) as { message: { content: string } };
            const text = input.message.content;
            const blocks = JSON.parse(text.slice(text.indexOf('Blocks:\n') + 'Blocks:\n'.length)) as Array<{ key: string }>;
            const assessments = blocks.map((block) => ({ key: block.key, risk: 64, reasoning: 'Scored after recovery.' }));
            emitter.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: JSON.stringify(assessments) })}\n`));
          });
        } });
        return emitter;
      },
    }));
    const { assessDiffBlocks } = await import('./diff-confidence-ai.js');
    const database = openDatabase(':memory:');

    await expect(assessDiffBlocks(database, [{ key: 'changed', lines: ['+const enabled = true;'] }])).resolves.toEqual({
      changed: { risk: 64, reasoning: 'Scored after recovery.' },
    });
    expect(writes).toBe(2);
  });

  it('retries a malformed model result instead of stranding the block as unscored', async () => {
    vi.resetModules();
    let writes = 0;
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: (prompt: string) => void }; kill: () => void };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.kill = () => {};
        emitter.stdin = Object.assign(new EventEmitter(), { write: (prompt: string) => {
          writes += 1;
          // Haiku's first turn answers with prose rather than the JSON array,
          // which used to mark every block in the batch permanently unscored.
          if (writes === 1) {
            queueMicrotask(() => emitter.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: 'I cannot score this.' })}\n`)));
            return;
          }
          queueMicrotask(() => {
            const input = JSON.parse(prompt) as { message: { content: string } };
            const text = input.message.content;
            const blocks = JSON.parse(text.slice(text.indexOf('Blocks:\n') + 'Blocks:\n'.length)) as Array<{ key: string }>;
            const assessments = blocks.map((block) => ({ key: block.key, risk: 55, reasoning: 'Scored on retry.' }));
            emitter.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: JSON.stringify(assessments) })}\n`));
          });
        } });
        return emitter;
      },
    }));
    const { assessDiffBlocks } = await import('./diff-confidence-ai.js');
    const database = openDatabase(':memory:');

    await expect(assessDiffBlocks(database, [{ key: 'changed', lines: ['+const enabled = true;'] }])).resolves.toEqual({
      changed: { risk: 55, reasoning: 'Scored on retry.' },
    });
    expect(writes).toBe(2);
  });

  it('gives up after the bounded retry so a permanently dead scorer still answers the request', async () => {
    vi.resetModules();
    let writes = 0;
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: () => void }; kill: () => void };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.kill = () => {};
        emitter.stdin = Object.assign(new EventEmitter(), { write: () => { writes += 1; queueMicrotask(() => emitter.emit('exit')); } });
        return emitter;
      },
    }));
    const { assessDiffBlocks } = await import('./diff-confidence-ai.js');
    const database = openDatabase(':memory:');

    await expect(assessDiffBlocks(database, [{ key: 'changed', lines: ['+const enabled = true;'] }])).resolves.toEqual({
      changed: { risk: null, reasoning: 'AI assessment unavailable; review this changed block.' },
    });
    expect(writes).toBe(2);
  });
});
