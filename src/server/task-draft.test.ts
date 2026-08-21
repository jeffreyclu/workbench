import { describe, expect, it } from 'vitest';
import { fastTaskDraft } from '../shared/task-draft.js';

describe('fastTaskDraft', () => {
  it('turns conversational requests into imperative classification-friendly titles', () => {
    expect(fastTaskDraft('I need you to add keyboard navigation to the task list').title).toBe('Add keyboard navigation to the task list');
    expect(fastTaskDraft('There is a bug where retries show as canceled').title).toBe('Fix retries show as canceled');
  });

  it('preserves the complete original prompt as agent context without inference', () => {
    const prompt = 'Implement task colors.\n\nKeep parent-child relationships visible.\nSee https://example.com/spec';
    expect(fastTaskDraft(prompt)).toEqual({
      title: 'Implement task colors', description: prompt, projectName: null, workspacePath: null,
    });
  });
});
