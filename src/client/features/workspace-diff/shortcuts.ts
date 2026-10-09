/** One row of the Changes section of the global keyboard-help overlay. `joiner`
 * is how alternative keys read: "J / K" are two keys for one pair of actions,
 * "↑ ↓" are two keys pressed in turn. */
export interface ChangesShortcut {
  keys: string[];
  joiner: '/' | ' ';
  description: string;
}

/**
 * The bindings Changes really listens for. `use-keyboard-navigation.ts` owns
 * the single-letter and bracket keys, `diff-search-bar.tsx` owns find, and the
 * file navigator owns its list keys. The overlay renders this table instead of
 * keeping its own copy, and `shortcuts.test.tsx` fails if a letter listed here
 * stops doing anything.
 */
export const CHANGES_SHORTCUTS: ChangesShortcut[] = [
  { keys: ['J', 'K'], joiner: '/', description: 'Next or previous pending decision' },
  { keys: ['[', ']'], joiner: '/', description: 'Previous or next changed file' },
  { keys: ['R'], joiner: '/', description: 'Mark the current decision reviewed' },
  { keys: ['D'], joiner: '/', description: 'Change the diff reading mode' },
  { keys: ['⌘ F', 'Ctrl F'], joiner: '/', description: 'Find text across the diff' },
  { keys: ['Enter', 'Shift Enter'], joiner: '/', description: 'Next or previous find match, while the find box is focused' },
  { keys: ['↑', '↓'], joiner: ' ', description: 'Move between files in the Files list' },
  { keys: ['Home', 'End'], joiner: '/', description: 'Jump to the first or last file in the Files list' },
  { keys: ['Escape'], joiner: '/', description: 'Close the find box, the Files list or the notes drawer' },
];
