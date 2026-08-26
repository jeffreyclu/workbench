import { describe, expect, it } from 'vitest';
import { formatDiffFollowUpReference } from './diff-confidence.js';

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
