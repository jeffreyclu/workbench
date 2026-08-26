import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseDiffConfidenceAssessment } from './diff-confidence-ai.js';

describe('parseDiffConfidenceAssessment', () => {
  it('keeps only validated integer scores for every requested block', () => {
    expect(parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":82,"reasoning":"Visible guard covers the branch."},"b":{"confidence":11,"reasoning":"No visible caller checks the result."},"extra":{"confidence":99,"reasoning":"Ignored."}}}', ['a', 'b'])).toEqual({ a: { confidence: 82, reasoning: 'Visible guard covers the branch.' }, b: { confidence: 11, reasoning: 'No visible caller checks the result.' } });
  });

  it('unwraps the Claude CLI JSON envelope before parsing the model result', () => {
    const output = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '```json\n{"assessments":{"a":{"confidence":82,"reasoning":"Visible path is covered."},"b":{"confidence":11,"reasoning":"No visible test covers this."}}}\n```',
    });

    expect(parseDiffConfidenceAssessment(output, ['a', 'b'])).toEqual({ a: { confidence: 82, reasoning: 'Visible path is covered.' }, b: { confidence: 11, reasoning: 'No visible test covers this.' } });
  });

  it('rejects missing, fractional, and out-of-range scores', () => {
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":50,"reasoning":"Covered."}}}', ['a', 'b'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":50.5,"reasoning":"Covered."}}}', ['a'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":101,"reasoning":"Covered."}}}', ['a'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":50,"reasoning":""}}}', ['a'])).toThrow();
  });
});

describe('assessDiffBlocks caching', () => {
  it('reuses a cached block score across unrelated batches instead of re-invoking the model', async () => {
    vi.resetModules();
    let spawnCalls = 0;
    vi.doMock('node:child_process', () => ({
      spawn: (..._args: unknown[]) => {
        spawnCalls += 1;
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end: (prompt: string) => void } };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.stdin = { end: (prompt: string) => {
          queueMicrotask(() => {
            const blocks = JSON.parse(prompt.slice(prompt.indexOf('Blocks:\n') + 'Blocks:\n'.length)) as Array<{ key: string }>;
            const assessments = Object.fromEntries(blocks.map((block) => [block.key, { confidence: 70, reasoning: 'Looks fine.' }]));
            emitter.stdout.emit('data', Buffer.from(JSON.stringify({ assessments })));
            emitter.emit('close', 0);
          });
        } };
        return emitter;
      },
    }));
    const { assessDiffBlocks } = await import('./diff-confidence-ai.js');

    await assessDiffBlocks([{ key: 'shared', lines: ['+const x = 1;'] }, { key: 'unique-1', lines: ['+const y = 2;'] }]);
    expect(spawnCalls).toBe(1);

    // Same content under a different key in a different batch: still a cache hit, so only the new block is sent.
    const result = await assessDiffBlocks([{ key: 'shared', lines: ['+const x = 1;'] }, { key: 'unique-2', lines: ['+const z = 3;'] }]);
    expect(spawnCalls).toBe(2);
    expect(result.shared).toEqual({ confidence: 70, reasoning: 'Looks fine.' });
    expect(result['unique-2']).toEqual({ confidence: 70, reasoning: 'Looks fine.' });
  });
});
