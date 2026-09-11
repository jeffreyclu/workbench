import { describe, expect, it } from 'vitest';
import {
  durableMemoryPrompt,
  durableMemoryQuery,
  durableMemoryRetrievalPlan,
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
    expect(shouldPrefetchDurableMemory('execute', 'Help me write my self review.')).toBe(true);
    expect(shouldPrefetchDurableMemory('strategy', 'Build my Staff promotion case.')).toBe(true);
    expect(shouldPrefetchDurableMemory('analysis', 'Summarize my accomplishments over time.')).toBe(true);
    expect(shouldPrefetchDurableMemory('execute', 'Write an intro for me.')).toBe(true);
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
    expect(durableMemoryQuery('Help me write my Staff promotion case.')).toContain('accomplishments impact projects leadership');
    expect(durableMemoryRetrievalPlan('Help me write my Staff promotion case.')).toEqual({ candidateLimit: 100, evidenceLimit: 100, promptBudget: 32_000 });
    expect(durableMemoryRetrievalPlan('Fix this recurring bug.')).toEqual({ candidateLimit: 100, evidenceLimit: 100, promptBudget: 12_000 });
  });

  it('deduplicates repeated task context and does not pollute ordinary queries with a generic hint', () => {
    expect(durableMemoryQuery('Design the prototype.', {
      conversationTitle: 'Connector error UX',
      taskTitle: 'Connector error UX',
      projectName: 'Connectors',
    })).toBe('Design the prototype.\nConnector error UX\nConnectors');
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

  it('selects as many relevant memories as fit the prompt instead of taking a fixed count', () => {
    const results = selectDurableMemoryEvidence(Array.from({ length: 20 }, (_, index) => evidence({
      title: `Memory ${index}`,
      body: 'Short relevant fact.',
      score: 1 - index * 0.01,
    })), null, { promptBudget: 4_000, maxItems: 100 });

    expect(results.length).toBeGreaterThan(8);
  });

  it('drops the weak relevance tail before it can consume prompt space', () => {
    const results = selectDurableMemoryEvidence([
      evidence({ title: 'Direct answer', score: 1 }),
      evidence({ title: 'Still useful', score: 0.72 }),
      evidence({ title: 'Weak noise', score: 0.2 }),
    ], null, { promptBudget: 12_000, maxItems: 100 });

    expect(results.map(({ title }) => title)).toEqual(['Direct answer', 'Still useful']);
  });
});
