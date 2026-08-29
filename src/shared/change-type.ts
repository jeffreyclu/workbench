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

/** How one rule in the classifier turned out.
 *
 * `fired` is the rule that decided the type; `passed` was evaluated and did not
 * hold; `not_reached` was never asked, because an earlier rule already decided.
 * Keeping all three distinct is the whole point — a reviewer who cannot tell
 * "we checked and it wasn't a move" from "we never checked" cannot audit the
 * verdict. */
export type ChangeTypeRuleOutcome = 'fired' | 'passed' | 'not_reached';

export interface ChangeTypeRule {
  /** Stable id, matching the order the classifier evaluates rules in. */
  id: string;
  /** The question the rule asks, in the reviewer's language. */
  question: string;
  /** What this diff actually measured against that question. */
  observed: string;
  /** The type this rule assigns when it holds. */
  verdict: ReviewChangeType;
  outcome: ChangeTypeRuleOutcome;
}

/** Every measurement the rules read from, computed once so the trace and the
 * verdict can never disagree about what the diff contained. */
export interface ChangeTypeFacts {
  files: Array<{ path: string; status: WorkspaceDiffFile['status']; bucket: 'generated' | 'test' | 'docs' | 'config' | 'production' }>;
  addedLines: number;
  removedLines: number;
  /** Counted over production files only, which is what the second pass sees. */
  productionAddedLines: number;
  productionRemovedLines: number;
  declarationsAdded: string[];
  declarationsRemoved: string[];
  /** Removed and never re-added: the quietly-dropped function. */
  droppedDeclarations: string[];
  /** Added and not previously present. */
  introducedDeclarations: string[];
  /** Removed and added back under the same name: a rewrite in place. */
  reintroducedDeclarations: string[];
  /** Sørensen–Dice over removed vs added production tokens; null when nothing
   * was removed, so there is no rewrite to measure. */
  rewriteSimilarity: number | null;
  commentOnly: boolean;
}

export interface ChangeTypeExplanation extends ChangeTypeClassification {
  facts: ChangeTypeFacts;
  /** The path-bucket pass, in evaluation order. */
  fileRules: ChangeTypeRule[];
  /** The production-code pass. Empty when the file pass already decided. */
  productionRules: ChangeTypeRule[];
  /** Why each secondary type is attached. Secondaries are additive, not
   * short-circuiting, so they carry a reason instead of an outcome. */
  secondaryReasons: Array<{ type: ReviewChangeType; reason: string }>;
}

/** Accumulates rules in evaluation order and short-circuits like the original
 * `if` chain did, so the trace is the control flow rather than a description
 * of it. */
class RuleTrace {
  readonly rules: ChangeTypeRule[] = [];
  verdict: ReviewChangeType | null = null;
  check(id: string, question: string, observed: string, verdict: ReviewChangeType, holds: boolean): void {
    if (this.verdict !== null) { this.rules.push({ id, question, observed, verdict, outcome: 'not_reached' }); return; }
    if (holds) this.verdict = verdict;
    this.rules.push({ id, question, observed, verdict, outcome: holds ? 'fired' : 'passed' });
  }
}

const list = (names: string[]) => (names.length === 0 ? 'none' : names.join(', '));
const pct = (value: number) => `${Math.round(value * 100)}%`;

function explainProduction(hunks: ChangeTypeHunk[]): { rules: ChangeTypeRule[]; type: ReviewChangeType } {
  const all = hunks.flatMap((hunk) => hunk.lines);
  const { added, removed } = splitChangedLines(all);
  const addedNames = declaredNames(added);
  const removedNames = declaredNames(removed);
  const readdedNames = [...removedNames].filter((name) => addedNames.has(name));
  const rewriteSimilarity = removed.length > 0 ? similarity(tokens(removed), tokens(added)) : 0;
  const ratio = `${added.length} added vs ${removed.length} removed`;

  const trace = new RuleTrace();
  trace.check('move_rename', 'Did this code move between files, or is a file renamed?',
    hunks.some((hunk) => hunk.fileStatus === 'renamed')
      ? 'a file in this decision is marked renamed'
      : `no rename; no removed block matches an added block in another file at ≥90% token similarity`,
    'move_rename', isMoveAcrossFiles(hunks));
  trace.check('deleted_files', 'Were every one of these files deleted outright?',
    `${hunks.filter((hunk) => hunk.fileStatus === 'removed').length} of ${hunks.length} hunks are in deleted files`,
    'deletion', hunks.every((hunk) => hunk.fileStatus === 'removed'));
  trace.check('removal_only', 'Does this only remove lines?', ratio,
    'deletion', added.length === 0 && removed.length > 0);
  trace.check('readded_names', 'Is a declaration removed and added back under the same name?',
    `re-added: ${list(readdedNames)}`, 'replacement', readdedNames.length > 0);
  trace.check('rewrite_similarity', `Do the removed and added lines share ≥${pct(REFACTOR_SIMILARITY)} of their tokens?`,
    removed.length === 0 ? 'nothing removed, so there is no rewrite to measure' : `Sørensen–Dice similarity ${pct(rewriteSimilarity)}`,
    'refactor_pure', removed.length > 0 && rewriteSimilarity >= REFACTOR_SIMILARITY);
  trace.check('added_files', 'Is any of this in a newly added file?',
    `${hunks.filter((hunk) => hunk.fileStatus === 'added').length} of ${hunks.length} hunks are in added files`,
    'new_code', hunks.some((hunk) => hunk.fileStatus === 'added'));
  trace.check('new_declarations', `Does it declare something new, remove no declarations, and add >${EXTENSION_ADDITION_RATIO}× what it removes?`,
    `declares ${list([...addedNames])}; removes ${list([...removedNames])}; ${ratio}`,
    'new_code', addedNames.size > 0 && removedNames.size === 0 && added.length > removed.length * EXTENSION_ADDITION_RATIO);
  trace.check('mostly_additive', `Does it remove no declarations and add >${EXTENSION_ADDITION_RATIO}× what it removes?`,
    `removes ${list([...removedNames])}; ${ratio}`,
    'extension', removedNames.size === 0 && added.length > removed.length * EXTENSION_ADDITION_RATIO);
  trace.check('residual', 'Nothing above held, so this edits existing behaviour.', ratio,
    'behavior_edit', true);
  return { rules: trace.rules, type: trace.verdict ?? 'behavior_edit' };
}

function classifyProduction(hunks: ChangeTypeHunk[]): ReviewChangeType {
  return explainProduction(hunks).type;
}

/** The classifier and its own explanation, from one pass. `classifyChangeType`
 * is a projection of this, so the trace a reviewer reads is by construction the
 * trace that produced the verdict. */
export function explainChangeType(hunks: ChangeTypeHunk[]): ChangeTypeExplanation {
  const isGenerated = (hunk: ChangeTypeHunk) => GENERATED_PATH.test(hunk.filePath);
  const isTest = (hunk: ChangeTypeHunk) => TEST_PATH.test(hunk.filePath);
  const isDocs = (hunk: ChangeTypeHunk) => DOCS_PATH.test(hunk.filePath);
  const isConfig = (hunk: ChangeTypeHunk) => CONFIG_PATH.test(hunk.filePath);
  const bucket = (hunk: ChangeTypeHunk): ChangeTypeFacts['files'][number]['bucket'] =>
    isGenerated(hunk) ? 'generated' : isTest(hunk) ? 'test' : isDocs(hunk) ? 'docs' : isConfig(hunk) ? 'config' : 'production';

  const changed = splitChangedLines(hunks.flatMap((hunk) => hunk.lines));
  const production = hunks.filter((hunk) => bucket(hunk) === 'production');
  const productionChanged = splitChangedLines(production.flatMap((hunk) => hunk.lines));
  const addedNames = declaredNames(productionChanged.added);
  const removedNames = declaredNames(productionChanged.removed);

  const seen = new Map<string, ChangeTypeFacts['files'][number]>();
  for (const hunk of hunks) if (!seen.has(hunk.filePath)) seen.set(hunk.filePath, { path: hunk.filePath, status: hunk.fileStatus, bucket: bucket(hunk) });

  const changedCode = [...changed.added, ...changed.removed].filter((line) => line.length > 0);
  const commentOnly = changedCode.length > 0 && changedCode.every((line) => COMMENT_LINE.test(line));

  const facts: ChangeTypeFacts = {
    files: [...seen.values()],
    addedLines: changed.added.length,
    removedLines: changed.removed.length,
    productionAddedLines: productionChanged.added.length,
    productionRemovedLines: productionChanged.removed.length,
    declarationsAdded: [...addedNames],
    declarationsRemoved: [...removedNames],
    droppedDeclarations: [...removedNames].filter((name) => !addedNames.has(name)),
    introducedDeclarations: [...addedNames].filter((name) => !removedNames.has(name)),
    reintroducedDeclarations: [...removedNames].filter((name) => addedNames.has(name)),
    rewriteSimilarity: productionChanged.removed.length > 0
      ? similarity(tokens(productionChanged.removed), tokens(productionChanged.added))
      : null,
    commentOnly,
  };

  if (hunks.length === 0) {
    return { primary: 'behavior_edit', secondary: [], facts, fileRules: [], productionRules: [], secondaryReasons: [] };
  }

  const count = (predicate: (hunk: ChangeTypeHunk) => boolean) => `${hunks.filter(predicate).length} of ${hunks.length} hunks`;
  const trace = new RuleTrace();
  trace.check('all_generated', 'Is every hunk in generated or vendored output?', count(isGenerated), 'generated', hunks.every(isGenerated));
  trace.check('all_docs', 'Is every hunk in documentation?', count(isDocs), 'docs_comment', hunks.every(isDocs));
  trace.check('comment_only', 'Is every changed line a comment?',
    changedCode.length === 0 ? 'no non-blank changed lines' : `${changedCode.filter((line) => COMMENT_LINE.test(line)).length} of ${changedCode.length} changed lines are comments`,
    'docs_comment', commentOnly);
  trace.check('all_config', 'Is every hunk in config or dependency manifests?', count(isConfig), 'config_dep', hunks.every(isConfig));
  trace.check('all_tests', 'Is every hunk in test code?', count(isTest), 'test_only', hunks.every(isTest));
  trace.check('no_production', 'Is there no production code left at all, so the largest non-production bucket wins?',
    `${production.length} of ${hunks.length} hunks are production code`,
    production.length === 0 ? (hunks.some(isTest) ? 'test_only' : hunks.some(isConfig) ? 'config_dep' : hunks.some(isDocs) ? 'docs_comment' : 'generated') : 'test_only',
    production.length === 0);

  const productionRules = trace.verdict === null ? explainProduction(production) : null;
  const primary = trace.verdict ?? productionRules?.type ?? 'behavior_edit';

  const secondaryReasons: Array<{ type: ReviewChangeType; reason: string }> = [];
  if (primary !== 'test_only' && hunks.some(isTest)) secondaryReasons.push({ type: 'test_only', reason: `${count(isTest)} are test code, so this change ships with its own tests.` });
  if (primary !== 'config_dep' && hunks.some(isConfig)) secondaryReasons.push({ type: 'config_dep', reason: `${count(isConfig)} touch config or dependency manifests.` });
  if (primary !== 'docs_comment' && !commentOnly && hunks.some(isDocs)) secondaryReasons.push({ type: 'docs_comment', reason: `${count(isDocs)} touch documentation.` });
  if (production.length > 0) {
    if (primary !== 'deletion' && primary !== 'move_rename' && facts.droppedDeclarations.length > 0) {
      secondaryReasons.push({ type: 'deletion', reason: `Removed and never re-added: ${list(facts.droppedDeclarations)}. A ${changeTypeLabel(primary).toLowerCase()} that drops a declaration is still a deletion.` });
    }
    if (primary !== 'new_code' && primary !== 'move_rename' && facts.introducedDeclarations.length > 0) {
      secondaryReasons.push({ type: 'new_code', reason: `Newly declared: ${list(facts.introducedDeclarations)}.` });
    }
  }

  return {
    primary,
    secondary: secondaryReasons.map((entry) => entry.type),
    facts,
    fileRules: trace.rules,
    productionRules: productionRules?.rules ?? [],
    secondaryReasons,
  };
}

export function classifyChangeType(hunks: ChangeTypeHunk[]): ChangeTypeClassification {
  const { primary, secondary } = explainChangeType(hunks);
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
