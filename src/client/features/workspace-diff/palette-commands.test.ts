import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts';
import type { ReviewDecision } from '../diff-review/logic.js';
import { decisionIdForFile, reviewPaletteCommands } from './palette-commands';

const file = (path: string): WorkspaceDiffFile => ({ path, status: 'modified', additions: 3, deletions: 1, previousPath: null, patch: null } as WorkspaceDiffFile);
const decision = (id: string, filePaths: string[], state: ReviewDecision['state'] = null) => ({ id, filePaths, state }) as ReviewDecision;

const decisions = [decision('d1', ['a.ts'], 'reviewed'), decision('d2', ['a.ts']), decision('d3', ['b.ts'])];

function build(overrides: Partial<Parameters<typeof reviewPaletteCommands>[0]> = {}) {
  const handlers = { onSelect: vi.fn(), onMarkReviewed: vi.fn(), onToggleReadingMode: vi.fn() };
  const commands = reviewPaletteCommands({ files: [file('a.ts'), file('b.ts'), file('c.ts')], decisions, activeId: 'd2', activeFilePath: 'a.ts', canMarkReviewed: true, ...handlers, ...overrides });
  return { commands, handlers, byId: (id: string) => commands.find((command) => command.id === id) };
}

describe('decisionIdForFile', () => {
  it('prefers a decision that still needs a verdict', () => {
    expect(decisionIdForFile(decisions, 'a.ts')).toBe('d2');
    expect(decisionIdForFile([decision('d1', ['a.ts'], 'reviewed')], 'a.ts')).toBe('d1');
    expect(decisionIdForFile(decisions, 'missing.ts')).toBeNull();
  });
});

describe('reviewPaletteCommands', () => {
  it('lists each changed file that has a decision and jumps to it', () => {
    const { commands, handlers, byId } = build();
    expect(commands.filter((command) => command.group === 'Files').map((command) => command.label)).toEqual(['a.ts', 'b.ts']);
    expect(byId('file:b.ts')).toMatchObject({ detail: '+3 −1' });
    byId('file:b.ts')!.run();
    expect(handlers.onSelect).toHaveBeenCalledWith('d3');
  });

  it('exposes the review actions behind the existing shortcuts', () => {
    const { handlers, byId } = build();
    byId('review:next-file')!.run();
    expect(handlers.onSelect).toHaveBeenCalledWith('d3');
    byId('review:mark-reviewed')!.run();
    expect(handlers.onMarkReviewed).toHaveBeenCalledOnce();
    byId('review:reading-mode')!.run();
    expect(handlers.onToggleReadingMode).toHaveBeenCalledOnce();
  });

  it('omits marking reviewed when nothing can be marked', () => {
    expect(build({ canMarkReviewed: false }).byId('review:mark-reviewed')).toBeUndefined();
  });
});
