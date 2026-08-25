import { describe, expect, it } from 'vitest';
import { hasTaskOrderChanged } from './use-task-stack-reorder-animation';

describe('hasTaskOrderChanged', () => {
  it('recognizes a reorder of the same server-owned task set', () => {
    expect(hasTaskOrderChanged(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
  });

  it('does not animate task insertion, removal, or an unchanged order', () => {
    expect(hasTaskOrderChanged(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(hasTaskOrderChanged(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(hasTaskOrderChanged(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});
