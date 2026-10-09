export type PaletteMode = 'commands' | 'switcher';
export type PaletteGroup = 'Review' | 'Files' | 'Go to' | 'Tasks' | 'Conversations' | 'Actions';

export interface PaletteCommand {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Secondary text, e.g. a file's directory or a task's project. */
  detail?: string;
  /** Extra words the query may match without being shown. */
  keywords?: string;
  shortcut?: string;
  run: () => void;
}

/** Order in which groups are listed when the query is empty. */
const GROUP_ORDER: PaletteGroup[] = ['Review', 'Files', 'Go to', 'Tasks', 'Conversations', 'Actions'];

/** ⌘P is the "go to" switcher: places and files, never actions. */
const SWITCHER_GROUPS: ReadonlySet<PaletteGroup> = new Set(['Files', 'Go to', 'Tasks', 'Conversations']);

export function commandsForMode(commands: PaletteCommand[], mode: PaletteMode) {
  return mode === 'switcher' ? commands.filter((command) => SWITCHER_GROUPS.has(command.group)) : commands;
}

/**
 * Subsequence match: every query character must appear in order. Consecutive
 * runs, word starts and matches near the start of the text score higher, so
 * "fdp" finds file-diff-pane.tsx before an incidental scatter. Returns null
 * when the text does not match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const index = haystack.indexOf(char, from);
    if (index === -1) return null;
    const atWordStart = index === 0 || /[\s/._-]/.test(haystack[index - 1]!);
    score += 1 + (index === previous + 1 ? 4 : 0) + (atWordStart ? 3 : 0) - Math.min(index, 20) * 0.05;
    previous = index;
    from = index + 1;
  }
  // A literal substring is the strongest signal of intent.
  if (haystack.includes(query.toLowerCase().trim())) score += 10;
  return score;
}

function commandScore(query: string, command: PaletteCommand) {
  const label = fuzzyScore(query, command.label);
  // A match on the label outranks one on the supporting text.
  if (label !== null) return label + 5;
  return fuzzyScore(query, `${command.detail ?? ''} ${command.keywords ?? ''}`);
}

/** Filters and ranks commands. With no query, keeps group order then source order. */
export function rankCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query.trim()) {
    return commands
      .map((command, index) => ({ command, index }))
      .sort((a, b) => GROUP_ORDER.indexOf(a.command.group) - GROUP_ORDER.indexOf(b.command.group) || a.index - b.index)
      .map(({ command }) => command);
  }
  return commands
    .map((command, index) => ({ command, index, score: commandScore(query, command) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ command }) => command);
}

/** Splits a repository path into the name to show and the directory to dim. */
export function splitPath(path: string) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { name: path, directory: '' } : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

/** Wraps an index into [0, length), so arrow keys cycle through the list. */
export function wrapIndex(index: number, length: number) {
  return length === 0 ? -1 : ((index % length) + length) % length;
}
