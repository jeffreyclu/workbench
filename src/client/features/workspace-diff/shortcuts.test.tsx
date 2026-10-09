// @vitest-environment jsdom
import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewDecision } from '../diff-review/logic.js';
import { CHANGES_SHORTCUTS } from './shortcuts.js';
import { useWorkspaceDiffKeyboardNavigation } from './use-keyboard-navigation.js';

const decisions = [{ id: 'd1', filePaths: ['a.ts'], state: null }, { id: 'd2', filePaths: ['b.ts'], state: null }] as ReviewDecision[];

describe('Changes shortcut table', () => {
  it('lists only letter and bracket keys the hook really handles', () => {
    const onSelect = vi.fn();
    const onMarkReviewed = vi.fn();
    const onToggleReadingMode = vi.fn();
    renderHook(() => useWorkspaceDiffKeyboardNavigation({ decisions, filePaths: ['a.ts', 'b.ts'], activeId: 'd1', activeFilePath: 'a.ts', canMarkReviewed: true, onSelect, onMarkReviewed, onToggleReadingMode }));
    const bareKeys = CHANGES_SHORTCUTS.flatMap((shortcut) => shortcut.keys).filter((key) => /^[A-Za-z[\]]$/.test(key));
    expect(bareKeys.sort()).toEqual(['D', 'J', 'K', 'R', '[', ']']);
    for (const key of bareKeys) {
      const handled = fireEvent.keyDown(document.body, { key: key.toLowerCase() });
      expect(handled, `${key} should be handled`).toBe(false);
    }
    expect(onSelect).toHaveBeenCalledTimes(4);
    expect(onMarkReviewed).toHaveBeenCalledOnce();
    expect(onToggleReadingMode).toHaveBeenCalledOnce();
  });
});
