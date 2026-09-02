import { describe, expect, it } from 'vitest';
import {
  durableMemoryPrompt,
  durableMemoryQuery,
  isExplicitMemoryRequest,
  selectDurableMemoryEvidence,
  shouldPrefetchDurableMemory,
  type DurableMemoryEvidence,
} from './memory-retrieval.js';

const evidence = (changes: Partial<DurableMemoryEvidence> = {}): DurableMemoryEvidence => ({
  source: 'doc',
  title: 'Working with Jeffrey',
  body: 'Jeffrey is a senior frontend engineer at Writer.',
  createdAt: '2026-09-01T12:00:00.000Z',
  score: 1,
  conversationId: null,
  workItemId: null,
  actor: 'jeffrey',
  ...changes,
});

describe('durable memory prefetch', () => {
  it('always retrieves for an explicit memory request, regardless of run kind', () => {
    expect(isExplicitMemoryRequest('Write the intro from your memories.')).toBe(true);
    expect(shouldPrefetchDurableMemory('execute', 'Write the intro from your memories.')).toBe(true);
  });

  it('retrieves for context-heavy work without charging self-contained implementation and review turns', () => {
    expect(shouldPrefetchDurableMemory('research', 'Research approaches.')).toBe(true);
    expect(shouldPrefetchDurableMemory('strategy', 'Propose a strategy.')).toBe(true);
    expect(shouldPrefetchDurableMemory('bugfix', 'Fix the dropdown.')).toBe(true);
    expect(shouldPrefetchDurableMemory('analysis', 'Why did this regress again?')).toBe(true);
    expect(shouldPrefetchDurableMemory('execute', 'Change the button label.')).toBe(false);
    expect(shouldPrefetchDurableMemory('review', 'Review this diff.')).toBe(false);
    expect(shouldPrefetchDurableMemory('execute', 'Fix this regression again.')).toBe(true);
    expect(shouldPrefetchDurableMemory('review', 'Review why this failed again.')).toBe(true);
    expect(shouldPrefetchDurableMemory('analysis', 'Explain this function.')).toBe(false);
  });

  it('expands personal memory queries so sparse requests can find profile facts', () => {
    const query = durableMemoryQuery('Write an intro about me from memory.');
    expect(query).toContain('Jeffrey Lu personal profile');
    expect(query).toContain('previous company');
  });

  it('deduplicates evidence and excludes generated output from the current room', () => {
    const results = selectDurableMemoryEvidence([
      evidence({ source: 'message', conversationId: 'current', actor: 'codex' }),
      evidence(),
      evidence({ source: 'run_output', title: 'Execute: Working with Jeffrey' }),
    ], 'current', 8);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('doc');
  });

  it('formats bounded evidence with explicit precedence and no repeat-recall loop', () => {
    const prompt = durableMemoryPrompt([evidence()]);
    expect(prompt).toContain('Retrieved durable context');
    expect(prompt).toContain('Jeffrey is a senior frontend engineer at Writer.');
    expect(prompt).toContain("Jeffrey's newest statement wins");
    expect(prompt).toContain('Do not call recall_context again for the same question');
  });

  it('applies the default character budget to the complete injected memory block', () => {
    const prompt = durableMemoryPrompt(Array.from({ length: 8 }, (_, index) => evidence({
      title: `Memory ${index}`,
      body: `${index} ${'x'.repeat(2_000)}`,
    })));

    expect(prompt.length).toBeLessThanOrEqual(4_000);
  });
});
