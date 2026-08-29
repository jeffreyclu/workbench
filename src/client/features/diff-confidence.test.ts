import { describe, expect, it } from 'vitest';
import { diffConfidenceRequestSchema } from '../../shared/contracts.js';
import { boundConfidenceRequestBlocks, formatDiffFollowUpReference } from './diff-confidence.js';

describe('formatDiffFollowUpReference', () => {
  it('keeps the exact parsed patch and assessment details in the agent-readable follow-up context', () => {
    expect(formatDiffFollowUpReference({
      filePath: 'src/example.ts',
      lines: [
        { key: 'old', kind: 'deletion', oldLine: 4, newLine: null, text: '-before' },
        { key: 'new', kind: 'addition', oldLine: null, newLine: 4, text: '+after' },
      ],
      assessment: { risk: 42, reasoning: 'The visible call has no error path.' },
    })).toBe('Please follow up on this risk assessment.\n\n**src/example.ts:4** · AI risk: 42/100\n\n> The visible call has no error path.\n\n```diff\n-before\n+after\n```');
  });
});

describe('boundConfidenceRequestBlocks', () => {
  it('leaves a block the server already accepts untouched', () => {
    const bounded = boundConfidenceRequestBlocks([{ key: 'src/example.ts::@@ -1,2 +1,2 @@', lines: ['+after', '-before'] }]);
    expect(bounded.requests).toEqual([{ key: 'src/example.ts::@@ -1,2 +1,2 @@', lines: ['+after', '-before'] }]);
    expect(bounded.sourceKeyByRequestKey['src/example.ts::@@ -1,2 +1,2 @@']).toBe('src/example.ts::@@ -1,2 +1,2 @@');
  });

  it('condenses a new file that exceeds the request contract instead of letting the request be rejected', () => {
    const lines = Array.from({ length: 500 }, (_value, index) => `+line ${index}`);
    const bounded = boundConfidenceRequestBlocks([{ key: 'src/new-file.ts::@@ -0,0 +1,500 @@', lines }]);
    expect(bounded.requests[0].lines).toHaveLength(200);
    expect(bounded.requests[0].lines[0]).toBe('+line 0');
    expect(bounded.requests[0].lines[139]).toBe('… 301 more lines omitted …');
    expect(bounded.requests[0].lines.at(-1)).toBe('+line 499');
    expect(() => diffConfidenceRequestSchema.parse({ blocks: bounded.requests })).not.toThrow();
  });

  it('substitutes a short key for a grouped cross-file decision whose id exceeds the key limit', () => {
    const key = `decision:handler:${Array.from({ length: 60 }, (_value, index) => `src/very/long/path/segment/file-${index}.ts::@@ -1,4 +1,4 @@`).join('|')}`;
    const bounded = boundConfidenceRequestBlocks([{ key, lines: ['+changed'] }]);
    expect(bounded.requests[0].key).toBe('block:0');
    expect(bounded.sourceKeyByRequestKey['block:0']).toBe(key);
    expect(() => diffConfidenceRequestSchema.parse({ blocks: bounded.requests })).not.toThrow();
  });

  it('keeps an over-long line and an empty block inside the contract', () => {
    const bounded = boundConfidenceRequestBlocks([
      { key: 'a', lines: [`+${'x'.repeat(5_000)}`] },
      { key: 'b', lines: [] },
    ]);
    expect(bounded.requests[0].lines[0]).toHaveLength(4_000);
    expect(bounded.requests[0].lines[0].endsWith('…')).toBe(true);
    expect(bounded.requests[1].lines).toEqual(['(no changed lines)']);
    expect(() => diffConfidenceRequestSchema.parse({ blocks: bounded.requests })).not.toThrow();
  });
});
