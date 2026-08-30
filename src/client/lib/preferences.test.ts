// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readReviewStackReadingMode, writeReviewStackReadingMode } from './preferences.js';

describe('review stack reading mode preference', () => {
  beforeEach(() => window.localStorage.clear());

  it('is absent until the reviewer chooses one, so the surface keeps its own default', () => {
    expect(readReviewStackReadingMode()).toBeNull();
  });

  it('round-trips the chosen mode', () => {
    writeReviewStackReadingMode('diff');
    expect(readReviewStackReadingMode()).toBe('diff');
    writeReviewStackReadingMode('final');
    expect(readReviewStackReadingMode()).toBe('final');
  });

  it('ignores a stored value that is not a reading mode', () => {
    window.localStorage.setItem('workbench:review-stack-reading-mode', 'sideways');
    expect(readReviewStackReadingMode()).toBeNull();
  });

  it('is stored globally rather than under a conversation scope', () => {
    writeReviewStackReadingMode('diff');
    expect(window.localStorage.getItem('workbench:review-stack-reading-mode')).toBe('diff');
    expect(window.localStorage.getItem('workbench:review-stack-selections')).toBeNull();
  });
});
