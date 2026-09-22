// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readConversationReadingPosition, readInsightsTab, readReviewStackReadingMode, writeConversationReadingPosition, writeInsightsTab, writeReviewStackReadingMode } from './preferences.js';

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

describe('insights tab preference', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to overview and remembers a valid selection', () => {
    expect(readInsightsTab()).toBe('overview');
    writeInsightsTab('system');
    expect(readInsightsTab()).toBe('system');
  });

  it('ignores an invalid stored tab', () => {
    window.localStorage.setItem('workbench:insights-tab', 'everything');
    expect(readInsightsTab()).toBe('overview');
  });
});

describe('conversation reading position preference', () => {
  beforeEach(() => window.localStorage.clear());

  it('restores the selected pane and message anchor after a fresh read', () => {
    writeConversationReadingPosition('conversation-1', { pane: 'changes', messageId: 'message-42' });

    expect(readConversationReadingPosition('conversation-1')).toEqual({ pane: 'changes', messageId: 'message-42' });
  });

  it('ignores malformed saved pane state', () => {
    window.localStorage.setItem('workbench:conversation-reading-positions', JSON.stringify({
      'conversation-1': { pane: 'activity', messageId: 'message-42' },
    }));

    expect(readConversationReadingPosition('conversation-1')).toBeNull();
  });
});
