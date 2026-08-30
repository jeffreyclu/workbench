import ts from 'typescript';
import { LOGIC_HAZARD_REASONS, LOGIC_HAZARD_WEIGHT, type DiffLogicBoundary, type LogicHazardName } from '../shared/contracts.js';

/** Why the TypeScript compiler and not a pattern set.
 *
 * Priority is a claim about what a change *does at runtime*. A regex cannot
 * make that claim: it matches the word `error` in a comment, reads
 * `export interface` as a public API, and cannot tell a removed guard from a
 * reindented one. The router that shipped ranked on exactly those matches,
 * which is why declarations and imports floated to the top of a queue meant
 * for business logic.
 *
 * This module parses the *whole file* on both sides of the patch with the
 * TypeScript compiler API, so every judgement below is made about a real
 * syntax node in its real enclosing scope. Whole files rather than hunk
 * fragments is what makes the parse exact: no synthetic closers, no tolerant
 * ladder, no line-at-a-time fallback. The server is the only place that can do
 * this — it has the checkout — which is why the analysis lives here and not
 * next to the client router.
 *
 * Scope note: this is the compiler's parser and binder-free AST, not a
 * `ts.Program`. Nothing here needs cross-file type resolution, and a Program
 * over an unbounded monorepo is not affordable per revision. Facts that
 * genuinely require a checker (nullability, unawaited promises across modules)
 * are deliberately absent rather than guessed at. */

/** What a changed construct does at runtime. Ordered by how much it can cost
 * in production, which is the only ordering a reviewer's queue should use. */
export type LogicEffect =
  | 'persistence'
  | 'guard'
  | 'error_path'
  | 'branch'
  | 'state_write'
  | 'loop'
  | 'await'
  | 'external_call'
  | 'return_value'
  | 'signature'
  | 'test_case'
  | 'literal'
  | 'declaration';

/** Base attention each effect earns. Declarations and imports sit at zero on
 * purpose: the compiler already proves them, and Jeffrey reviewing them is
 * time not spent on the branch that drops a request. */
const EFFECT_WEIGHT: Record<LogicEffect, number> = {
  persistence: 10,
  guard: 9,
  error_path: 8,
  branch: 7,
  state_write: 6,
  loop: 5,
  await: 5,
  external_call: 4,
  return_value: 4,
  signature: 3,
  test_case: 1,
  literal: 0,
  declaration: 0,
};

/** A structural fact that makes a block more dangerous than its effect alone.
 * Each is read off the AST, never off text. The names and their weights are
 * declared in the shared contract because the Review queue routes on them too;
 * this module is the only thing that can *find* them. */
export type LogicHazard = LogicHazardName;

const HAZARD_WEIGHT: Record<LogicHazard, number> = LOGIC_HAZARD_WEIGHT;

export const HAZARD_REASONS: Record<LogicHazard, string> = LOGIC_HAZARD_REASONS;

export interface LogicPrimitive {
  /** 1-based, in the file as the patch leaves it. */
  startLine: number;
  endLine: number;
  effect: LogicEffect;
  /** The construct as a reviewer would name it, taken from the syntax. */
  label: string;
  hazards: LogicHazard[];
  /** What this costs to get wrong. Effect weight plus every hazard on it. */
  score: number;
}

function scoreOf(effect: LogicEffect, hazards: LogicHazard[]): number {
  return hazards.reduce((total, hazard) => total + HAZARD_WEIGHT[hazard], EFFECT_WEIGHT[effect]);
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.mts') || filePath.endsWith('.cts') || filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  if (filePath.endsWith('.mjs') || filePath.endsWith('.cjs') || filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.Unknown;
}

export function isAnalyzableFile(filePath: string): boolean {
  return scriptKind(filePath) !== ts.ScriptKind.Unknown;
}

export function parseFile(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
}

/** The block a callable actually executes. `ts.isFunctionLike` also matches
 * call and method *signatures*, which have no body, so the cast is guarded by
 * the shape check rather than by the type guard alone. */
function functionBody(node: ts.Node): ts.Block | undefined {
  if (!ts.isFunctionLike(node)) return undefined;
  const body = (node as ts.FunctionLikeDeclaration).body;
  return body && ts.isBlock(body) ? body : undefined;
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function nodeLines(source: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  return { startLine: lineOf(source, node.getStart(source)), endLine: lineOf(source, node.getEnd()) };
}

/** The header of a compound statement: the part that decides, as opposed to
 * the body it governs. A changed `if` condition and a changed statement inside
 * the branch are two different review questions, so they get two ranges. */
function headerEnd(source: ts.SourceFile, node: ts.Node): number {
  if (ts.isIfStatement(node)) return lineOf(source, node.expression.getEnd());
  if (ts.isSwitchStatement(node)) return lineOf(source, node.expression.getEnd());
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return lineOf(source, node.expression.getEnd());
  if (ts.isForStatement(node)) return lineOf(source, (node.incrementor ?? node.condition ?? node.initializer ?? node.statement).getEnd());
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return lineOf(source, node.expression.getEnd());
  const body = functionBody(node);
  if (body) return lineOf(source, body.getStart(source));
  return lineOf(source, node.getStart(source));
}

/** Statements nested directly inside a compound statement. Returning them is
 * what lets the walk descend to the smallest changed statement instead of
 * emitting a whole function as one block. */
function childStatements(node: ts.Node): ts.Node[] {
  if (ts.isBlock(node) || ts.isModuleBlock(node)) return [...node.statements];
  if (ts.isIfStatement(node)) return [node.thenStatement, ...(node.elseStatement ? [node.elseStatement] : [])];
  if (ts.isIterationStatement(node, false)) return [node.statement];
  if (ts.isTryStatement(node)) {
    return [node.tryBlock, ...(node.catchClause ? [node.catchClause.block] : []), ...(node.finallyBlock ? [node.finallyBlock] : [])];
  }
  if (ts.isSwitchStatement(node)) return node.caseBlock.clauses.flatMap((clause) => [...clause.statements]);
  if (ts.isLabeledStatement(node)) return [node.statement];
  const body = functionBody(node);
  if (body) return [...body.statements];
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return [...node.members];
  if (ts.isVariableStatement(node)) {
    // A `const handler = async () => {…}` is a function whose body is worth
    // descending into; a `const limit = 5` has nothing inside it.
    return node.declarationList.declarations
      .map((declaration) => declaration.initializer)
      .filter((initializer): initializer is ts.Expression => Boolean(initializer && ts.isFunctionLike(initializer)));
  }
  return [];
}

function hasDescendant(node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (predicate(candidate)) { found = true; return; }
    candidate.forEachChild(visit);
  };
  node.forEachChild(visit);
  return predicate(node) || found;
}

const PERSISTENCE_CALLS = new Set([
  'query', 'execute', 'prepare', 'run', 'transaction', 'insert', 'update', 'delete', 'upsert',
  'save', 'commit', 'migrate', 'exec', 'all', 'get', 'put', 'write', 'writeFile', 'unlink',
]);

/** The called name, read off the AST rather than matched in text. A member
 * call reports its property (`db.query` → `query`), which is what identifies
 * the operation. */
function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return null;
}

function firstCall(node: ts.Node): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(candidate)) { found = candidate; return; }
    candidate.forEachChild(visit);
  };
  visit(node);
  return found;
}

const TEST_CALLS = new Set(['it', 'test', 'describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);

/** A guard is a conditional whose only job is to leave: the shape that
 * protects everything after it. Losing one is the highest-value thing this
 * module can report, so it is recognised structurally — a single-statement
 * consequent that returns, throws, breaks or continues, with no else. */
function isGuard(node: ts.Node): node is ts.IfStatement {
  if (!ts.isIfStatement(node) || node.elseStatement) return false;
  const consequent = ts.isBlock(node.thenStatement)
    ? (node.thenStatement.statements.length === 1 ? node.thenStatement.statements[0] : null)
    : node.thenStatement;
  if (!consequent) return false;
  return ts.isReturnStatement(consequent) || ts.isThrowStatement(consequent)
    || ts.isBreakStatement(consequent) || ts.isContinueStatement(consequent);
}

function classify(node: ts.Node): LogicEffect {
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) return 'declaration';
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return 'declaration';
  if (ts.isModuleDeclaration(node)) return 'declaration';
  if (ts.isEnumDeclaration(node)) return 'literal';

  if (isGuard(node)) return 'guard';
  if (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isCaseClause(node)) return 'branch';
  if (ts.isIterationStatement(node, false)) return 'loop';
  if (ts.isTryStatement(node) || ts.isCatchClause(node) || ts.isThrowStatement(node)) return 'error_path';

  const call = firstCall(node);
  if (call) {
    const name = calleeName(call);
    if (name && TEST_CALLS.has(name)) return 'test_case';
    if (name && PERSISTENCE_CALLS.has(name)) return 'persistence';
  }
  if (hasDescendant(node, ts.isAwaitExpression)) return 'await';

  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) return 'signature';
  if (ts.isClassDeclaration(node)) return 'signature';
  if (ts.isReturnStatement(node)) return 'return_value';

  if (ts.isExpressionStatement(node)) {
    const expression = node.expression;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) return 'state_write';
    if (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) return 'state_write';
    if (call) return 'external_call';
  }
  if (ts.isVariableStatement(node)) {
    return call ? 'external_call' : 'literal';
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isMethodSignature(node)) return 'declaration';
  return 'state_write';
}

/** The construct named the way a reviewer would say it aloud. Taken from the
 * syntax, so it says `if (!request.token)` rather than the enclosing function
 * every sibling block would also claim. */
function labelOf(source: ts.SourceFile, node: ts.Node): string {
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (ts.isIfStatement(node)) return collapse(`if (${node.expression.getText(source)})`);
  if (ts.isSwitchStatement(node)) return collapse(`switch (${node.expression.getText(source)})`);
  if (ts.isForOfStatement(node)) return collapse(`for (… of ${node.expression.getText(source)})`);
  if (ts.isWhileStatement(node)) return collapse(`while (${node.expression.getText(source)})`);
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return collapse(`${node.name?.getText(source) ?? 'function'}(…)`);
  }
  if (ts.isCatchClause(node)) return 'catch';
  const [first] = collapse(node.getText(source)).split('{');
  return collapse(first || node.getText(source));
}

function inLoop(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isIterationStatement(parent, false)) return true;
  }
  return false;
}

const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

function comparisonSignatures(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (candidate: ts.Node): void => {
    if (ts.isBinaryExpression(candidate) && COMPARISONS.has(candidate.operatorToken.kind)) {
      found.push(`${candidate.left.getText()}${candidate.operatorToken.getText()}${candidate.right.getText()}`);
    }
    candidate.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** Hazards visible from the node alone. Cross-side hazards (a guard that no
 * longer exists) are added by the caller, which is the only place that holds
 * both sides. */
function localHazards(node: ts.Node): LogicHazard[] {
  const hazards: LogicHazard[] = [];
  if (ts.isCatchClause(node) && node.block.statements.length === 0) hazards.push('error_swallowed');
  if (ts.isTryStatement(node) && node.catchClause?.block.statements.length === 0) hazards.push('error_swallowed');
  if (hasDescendant(node, ts.isAwaitExpression) && inLoop(node)) hazards.push('await_in_loop');
  if (ts.isIterationStatement(node, false) && hasDescendant(node, ts.isAwaitExpression)) hazards.push('await_in_loop');
  return hazards;
}

export interface AnalyzedFile {
  filePath: string;
  primitives: LogicPrimitive[];
  /** Highest score among the primitives, which is what the queue ranks on: a
   * file is as urgent as its worst change, not as its average. */
  score: number;
  /** True when nothing in the change runs — types, imports, comments only. */
  declarativeOnly: boolean;
}

/**
 * Cut the changed regions of one file into the primitives a reviewer actually
 * answers, and price each one.
 *
 * `changedLines` are 1-based lines of the file as the patch leaves it. The
 * walk descends to the smallest statement covering a changed line, so a forty
 * line edit becomes the guard, the branch, the write and the awaited call it
 * really is, rather than one block with one verdict.
 */
export function analyzeChangedFile(
  filePath: string,
  afterText: string,
  changedLines: ReadonlySet<number>,
  beforeText: string | null = null,
): AnalyzedFile {
  const source = parseFile(filePath, afterText);
  const primitives: LogicPrimitive[] = [];

  const touches = (node: ts.Node): boolean => {
    const { startLine, endLine } = nodeLines(source, node);
    for (const line of changedLines) if (line >= startLine && line <= endLine) return true;
    return false;
  };
  const headerTouched = (node: ts.Node): boolean => {
    const start = lineOf(source, node.getStart(source));
    const end = headerEnd(source, node);
    for (const line of changedLines) if (line >= start && line <= end) return true;
    return false;
  };

  const emit = (node: ts.Node, endLine?: number): void => {
    const lines = nodeLines(source, node);
    const effect = classify(node);
    const hazards = localHazards(node);
    primitives.push({
      startLine: lines.startLine,
      endLine: endLine ?? lines.endLine,
      effect,
      label: labelOf(source, node),
      hazards,
      score: scoreOf(effect, hazards),
    });
  };

  const visit = (node: ts.Node): void => {
    if (!touches(node)) return;
    const children = childStatements(node).filter(touches);
    // A compound statement whose own header changed is its own decision, even
    // when its body changed too: the condition and the work it governs fail
    // differently and are worth separate answers.
    if (children.length > 0) {
      if (headerTouched(node) && !ts.isBlock(node)) emit(node, headerEnd(source, node));
      for (const child of children) visit(child);
      return;
    }
    if (!ts.isBlock(node) && !ts.isModuleBlock(node)) emit(node);
  };

  for (const statement of source.statements) visit(statement);

  // Cross-side hazards. The before file is parsed for the same reason the
  // after file is: a guard that disappeared is invisible from one side.
  if (beforeText !== null) {
    const before = parseFile(filePath, beforeText);
    const guardsBefore = new Set<string>();
    const comparisonsBefore = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (isGuard(node)) guardsBefore.add(node.expression.getText(before).replace(/\s+/g, ''));
      for (const signature of comparisonSignatures(node)) comparisonsBefore.add(signature.replace(/\s+/g, ''));
      node.forEachChild(collect);
    };
    before.forEachChild(collect);

    const guardsAfter = new Set<string>();
    const comparisonsAfter = new Set<string>();
    const collectAfter = (node: ts.Node): void => {
      if (isGuard(node)) guardsAfter.add(node.expression.getText(source).replace(/\s+/g, ''));
      for (const signature of comparisonSignatures(node)) comparisonsAfter.add(signature.replace(/\s+/g, ''));
      node.forEachChild(collectAfter);
    };
    source.forEachChild(collectAfter);

    const lostGuards = [...guardsBefore].filter((guard) => !guardsAfter.has(guard));
    const movedBoundaries = [...comparisonsBefore].filter((comparison) => !comparisonsAfter.has(comparison));
    if (lostGuards.length > 0 || movedBoundaries.length > 0) {
      // Attach to the highest-scoring changed primitive rather than to the
      // file: the reviewer opens a block, not a file.
      const target = primitives.reduce<LogicPrimitive | null>(
        (best, candidate) => (best === null || candidate.score > best.score ? candidate : best), null);
      if (target) {
        if (lostGuards.length > 0 && !target.hazards.includes('guard_removed')) target.hazards.push('guard_removed');
        if (movedBoundaries.length > 0 && !target.hazards.includes('boundary_moved')) target.hazards.push('boundary_moved');
        target.score = scoreOf(target.effect, target.hazards);
      }
    }
  }

  const score = primitives.reduce((highest, primitive) => Math.max(highest, primitive.score), 0);
  const declarativeOnly = primitives.length > 0
    && primitives.every((primitive) => primitive.effect === 'declaration' || primitive.effect === 'literal');
  return { filePath, primitives, score, declarativeOnly };
}

/* The patch -> boundary bridge.
 *
 * Block extraction used to ask a regex where a thought starts. This is the
 * seam that replaces it: the analysis above, driven straight off a unified
 * patch, so the Review surface cuts at the boundaries the *parser* found.
 *
 * The after side is rebuilt at its true line numbers - additions and context
 * placed at the line the patch leaves them on, the gaps between hunks padded
 * with blank lines - so a primitive's `startLine` is a real line of the file
 * and the client can match it against a hunk without a second coordinate
 * system. Padding costs nothing to parse and is what keeps the mapping exact.
 *
 * Rebuilding rather than reading the file from disk is deliberate. A patch is
 * the one thing every diff source has: the working tree, a recorded commit,
 * and any source added to the repo selector later. Reading the checkout would
 * make this correct for exactly one of them, and silently wrong for a historic
 * commit whose file has since moved on. */

/** A patch this large is a generated file or a vendored drop; parsing it on
 * every poll of the diff endpoint costs more than the cut is worth. */
const MAX_ANALYZABLE_PATCH_BYTES = 400_000;

interface AfterSide { text: string; changedLines: Set<number> }

/** Rebuild the after side of one file's patch, faithful to line numbers.
 *
 * A deletion has no line in the after file, so it is attributed to the line
 * that now sits in its place: that is the statement a reviewer reads to
 * understand what the removal did. */
function rebuildAfterSide(patch: string): AfterSide | null {
  const after: string[] = [];
  const changedLines = new Set<number>();
  let newLine = 0;
  let inHunk = false;

  const place = (line: number, code: string): void => {
    while (after.length < line - 1) after.push('');
    if (after.length === line - 1) after.push(code);
    else after[line - 1] = code;
  };

  for (const raw of patch.split('\n')) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) { newLine = Number(header[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    // "\ No newline at end of file" annotates the previous line; it occupies none.
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) { place(newLine, raw.slice(1)); changedLines.add(newLine); newLine += 1; }
    else if (raw.startsWith('-')) changedLines.add(newLine);
    else if (raw.startsWith(' ') || raw === '') { place(newLine, raw.slice(1)); newLine += 1; }
    else inHunk = false; // A `diff --git`, `index` or mode line ends the hunk body.
  }

  if (changedLines.size === 0 || after.length === 0) return null;
  return { text: after.join('\n'), changedLines };
}

/** Bounded so a long session cannot grow it without limit. Keyed on the patch
 * because that is exactly what the analysis depends on: identical patch,
 * identical boundaries, and any edit produces a different key. */
const boundaryCache = new Map<string, DiffLogicBoundary[]>();
const BOUNDARY_CACHE_LIMIT = 256;

/**
 * The logic block boundaries inside one file's patch: the start line of every
 * primitive the compiler found in the changed regions, with the label, effect
 * and price the queue ranks on.
 *
 * Returns an empty array for anything the parser cannot speak for - a binary
 * file, a language it does not parse, a patch too large to be worth it - and
 * the caller falls back to the indentation heuristic rather than losing the
 * cut entirely.
 */
export function patchLogicBoundaries(filePath: string, patch: string): DiffLogicBoundary[] {
  if (!isAnalyzableFile(filePath) || patch.length > MAX_ANALYZABLE_PATCH_BYTES) return [];

  const cacheKey = `${filePath} ${patch}`;
  const cached = boundaryCache.get(cacheKey);
  if (cached) return cached;

  let boundaries: DiffLogicBoundary[] = [];
  try {
    const side = rebuildAfterSide(patch);
    if (side) {
      const analyzed = analyzeChangedFile(filePath, side.text, side.changedLines);
      const byLine = new Map<number, DiffLogicBoundary>();
      for (const primitive of analyzed.primitives) {
        const existing = byLine.get(primitive.startLine);
        // Two primitives can open on one line (`if (x) return`). The costlier
        // one names the block, because that is the answer being asked for.
        if (existing && existing.score >= primitive.score) continue;
        byLine.set(primitive.startLine, {
          line: primitive.startLine,
          label: primitive.label,
          effect: primitive.effect,
          score: primitive.score,
          hazards: primitive.hazards,
        });
      }
      boundaries = [...byLine.values()].sort((a, b) => a.line - b.line);
    }
  } catch {
    // A parse that throws is a boundary source that does not exist, not a
    // broken diff. The heuristic still has an answer.
    boundaries = [];
  }

  if (boundaryCache.size >= BOUNDARY_CACHE_LIMIT) {
    const oldest = boundaryCache.keys().next().value;
    if (oldest !== undefined) boundaryCache.delete(oldest);
  }
  boundaryCache.set(cacheKey, boundaries);
  return boundaries;
}
