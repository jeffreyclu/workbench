import type { WorkspaceDiffFile } from './contracts.js';

/** What kind of change a decision is, which is a different question from how
 * exposed it is. `REVIEW_RISK_SIGNALS` answers "what could this touch"; the
 * type answers "what must a reviewer establish before approving it" — the
 * evidence a deletion needs is not the evidence new code needs.
 *
 * Ordered most-certain first. A decision takes the first type that matches, so
 * a lockfile is `generated` before anything reads its lines and `behavior_edit`
 * is the residual bucket rather than a positive finding. */
export const REVIEW_CHANGE_TYPES = [
  'generated', 'docs_comment', 'config_dep', 'test_only', 'move_rename',
  'deletion', 'replacement', 'refactor_pure', 'new_code', 'extension', 'behavior_edit',
] as const;
export type ReviewChangeType = typeof REVIEW_CHANGE_TYPES[number];

export interface ChangeTypeHunk {
  filePath: string;
  fileStatus: WorkspaceDiffFile['status'];
  lines: string[];
}

export interface ChangeTypeClassification {
  primary: ReviewChangeType;
  /** Types that also apply to part of the decision. This is what stops a
   * refactor that quietly drops a function from being read as a pure refactor,
   * and what lets the queue show that a change shipped with its own tests. */
  secondary: ReviewChangeType[];
}

// Kept deliberately literal rather than clever: a path predicate that guesses
// wrong sends the whole decision down the wrong obligation set, which is worse
// than falling through to the residual type.
const GENERATED_PATH = /(?:^|\/)(?:dist|build|out|coverage|vendor|node_modules)\/|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(?:generated|min)\.\w+$|(?:^|\/)__snapshots__\/|\.snap$/;
const DOCS_PATH = /\.(?:md|mdx|rst|txt)$|(?:^|\/)docs?\//i;
const CONFIG_PATH = /(?:^|\/)(?:package\.json|tsconfig[\w.]*\.json|Dockerfile|Makefile|\.env[\w.]*)$|(?:^|\/)\.github\/|\.(?:ya?ml|toml|ini)$|\.config\.[cm]?[jt]sx?$|(?:^|\/)\.[\w.]+rc(?:\.\w+)?$/;
/** The same set the assist system prompt names, so the classifier and the model
 * cannot disagree about what counts as test code. */
const TEST_PATH = /\.(?:test|spec)\.\w+$|(?:^|\/)(?:__tests__|__mocks__|tests|e2e|fixtures)\//;

const COMMENT_LINE = /^(?:\/\/|\/\*|\*|<!--|-->)/;
/** Deliberately narrower than "anything declared": only named functions,
 * classes, interfaces, enums, and exported bindings. A renamed local `const` is
 * a refactor, and counting it as a dropped declaration made every rename report
 * a phantom deletion. */
const DECLARATION = /(?:^|[^\w$])(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum)\s+([A-Za-z_$][\w$]*)|export\s+(?:const|let|var|type)\s+([A-Za-z_$][\w$]*)/g;

export function splitChangedLines(lines: string[]): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1).trim());
    else if (line.startsWith('-')) removed.push(line.slice(1).trim());
  }
  return { added, removed };
}

/** Exported so the coverage-evidence pack names symbols exactly the way the
 * classifier does: if the two disagreed, a decision could be classed new code
 * for a declaration the evidence pack then failed to look for. */
export function declaredNames(lines: string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(DECLARATION)) names.add(match[1] ?? match[2]);
  }
  return names;
}

function tokens(lines: string[]): string[] {
  return lines.flatMap((line) => line.match(/[A-Za-z_$][\w$]*|\d+|[^\s\w]/g) ?? []);
}

/** Sørensen–Dice over token multisets. Multisets rather than sets because a
 * refactor that deletes one of three identical calls must not read as identical
 * to the original. */
function similarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of right) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) { counts.set(token, remaining - 1); shared += 1; }
  }
  return (2 * shared) / (left.length + right.length);
}

/** Code that left one file and arrived in another, within the same decision.
 * Cross-decision moves are invisible here by construction — the classifier is
 * given one decision's hunks — and are reported as a deletion plus new code,
 * which is the safe direction to be wrong in. */
function isMoveAcrossFiles(hunks: ChangeTypeHunk[]): boolean {
  if (hunks.some((hunk) => hunk.fileStatus === 'renamed')) return true;
  const byFile = new Map<string, { added: string[]; removed: string[] }>();
  for (const hunk of hunks) {
    const existing = byFile.get(hunk.filePath) ?? { added: [], removed: [] };
    const split = splitChangedLines(hunk.lines);
    byFile.set(hunk.filePath, { added: [...existing.added, ...split.added], removed: [...existing.removed, ...split.removed] });
  }
  const files = [...byFile.entries()];
  for (const [sourcePath, source] of files) {
    for (const [targetPath, target] of files) {
      if (sourcePath === targetPath) continue;
      if (source.removed.length < 3 || target.added.length < 3) continue;
      if (similarity(tokens(source.removed), tokens(target.added)) >= 0.9) return true;
    }
  }
  return false;
}

const REFACTOR_SIMILARITY = 0.8;
/** A hunk that adds far more than it removes is extending existing logic
 * rather than rewriting it — the surrounding line or two usually moves with the
 * insertion, so an exact zero-deletion test would almost never fire. */
const EXTENSION_ADDITION_RATIO = 4;

function classifyProduction(hunks: ChangeTypeHunk[]): ReviewChangeType {
  const all = hunks.flatMap((hunk) => hunk.lines);
  const { added, removed } = splitChangedLines(all);
  const addedNames = declaredNames(added);
  const removedNames = declaredNames(removed);
  const readdedNames = [...removedNames].filter((name) => addedNames.has(name));

  if (isMoveAcrossFiles(hunks)) return 'move_rename';
  if (hunks.every((hunk) => hunk.fileStatus === 'removed')) return 'deletion';
  if (added.length === 0 && removed.length > 0) return 'deletion';
  if (readdedNames.length > 0) return 'replacement';
  if (removed.length > 0 && similarity(tokens(removed), tokens(added)) >= REFACTOR_SIMILARITY) return 'refactor_pure';
  if (hunks.some((hunk) => hunk.fileStatus === 'added')) return 'new_code';
  if (addedNames.size > 0 && removedNames.size === 0 && added.length > removed.length * EXTENSION_ADDITION_RATIO) return 'new_code';
  if (removedNames.size === 0 && added.length > removed.length * EXTENSION_ADDITION_RATIO) return 'extension';
  return 'behavior_edit';
}

export function classifyChangeType(hunks: ChangeTypeHunk[]): ChangeTypeClassification {
  if (hunks.length === 0) return { primary: 'behavior_edit', secondary: [] };

  const isGenerated = (hunk: ChangeTypeHunk) => GENERATED_PATH.test(hunk.filePath);
  const isTest = (hunk: ChangeTypeHunk) => TEST_PATH.test(hunk.filePath);
  const isDocs = (hunk: ChangeTypeHunk) => DOCS_PATH.test(hunk.filePath);
  const isConfig = (hunk: ChangeTypeHunk) => CONFIG_PATH.test(hunk.filePath);

  const changed = splitChangedLines(hunks.flatMap((hunk) => hunk.lines));
  const changedCode = [...changed.added, ...changed.removed].filter((line) => line.length > 0);
  const commentOnly = changedCode.length > 0 && changedCode.every((line) => COMMENT_LINE.test(line));

  const production = hunks.filter((hunk) => !isGenerated(hunk) && !isTest(hunk) && !isDocs(hunk) && !isConfig(hunk));

  const primary: ReviewChangeType = hunks.every(isGenerated) ? 'generated'
    : hunks.every(isDocs) || commentOnly ? 'docs_comment'
      : hunks.every(isConfig) ? 'config_dep'
        : hunks.every(isTest) ? 'test_only'
          : production.length === 0
            ? (hunks.some(isTest) ? 'test_only' : hunks.some(isConfig) ? 'config_dep' : hunks.some(isDocs) ? 'docs_comment' : 'generated')
            : classifyProduction(production);

  const secondary: ReviewChangeType[] = [];
  if (primary !== 'test_only' && hunks.some(isTest)) secondary.push('test_only');
  if (primary !== 'config_dep' && hunks.some(isConfig)) secondary.push('config_dep');
  if (primary !== 'docs_comment' && !commentOnly && hunks.some(isDocs)) secondary.push('docs_comment');

  if (production.length > 0) {
    const { added, removed } = splitChangedLines(production.flatMap((hunk) => hunk.lines));
    const addedNames = declaredNames(added);
    const removedNames = declaredNames(removed);
    // A declaration that is removed and never re-added is a deletion no matter
    // what the decision is called overall. This is the "refactor that quietly
    // drops a function" case, and it is exactly the one worth surfacing.
    const dropped = [...removedNames].filter((name) => !addedNames.has(name));
    const introduced = [...addedNames].filter((name) => !removedNames.has(name));
    if (primary !== 'deletion' && primary !== 'move_rename' && dropped.length > 0) secondary.push('deletion');
    if (primary !== 'new_code' && primary !== 'move_rename' && introduced.length > 0) secondary.push('new_code');
  }
  return { primary, secondary };
}

const CHANGE_TYPE_LABELS: Record<ReviewChangeType, string> = {
  generated: 'Generated',
  docs_comment: 'Docs',
  config_dep: 'Config',
  test_only: 'Tests',
  move_rename: 'Move',
  deletion: 'Deletion',
  replacement: 'Replacement',
  refactor_pure: 'Refactor',
  new_code: 'New code',
  extension: 'Extension',
  behavior_edit: 'Behavior change',
};

export function changeTypeLabel(type: ReviewChangeType): string {
  return CHANGE_TYPE_LABELS[type] ?? 'Behavior change';
}

export function isReviewChangeType(value: string): value is ReviewChangeType {
  return (REVIEW_CHANGE_TYPES as readonly string[]).includes(value);
}

/** One definition of "test code" for the whole review pipeline. The classifier
 * uses it to reach `test_only`; the coverage-evidence pack uses it to decide
 * which sibling hunks may be offered as proof that new logic is exercised. */
export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(filePath);
}
