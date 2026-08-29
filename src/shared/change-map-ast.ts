import { parse } from '@babel/parser';

/** Why a parser and not regexes: the previous scanner read diff lines as text,
 * so it saw declarations inside strings and comments, missed every signature
 * that wrapped onto a second line, and could only guess at nesting from
 * leading whitespace. This module parses each hunk instead, so a name is
 * classified by the syntax it actually sits in.
 *
 * The parser is `@babel/parser` — already in the tree, browser-safe, and the
 * standard TypeScript + JSX front end. It is used for its grammar only: no
 * type checker, no module resolution, no whole-repository index. The map stays
 * diff-scoped, so a parse of the hunk is exactly the right amount of program.
 *
 * A hunk is a fragment, not a file, so parsing is tolerant by design: three
 * scaffolds are tried and a fragment that defeats all of them falls back to a
 * line-at-a-time parse. A line that will not parse contributes nothing, which
 * is the honest answer — the old scanner's answer was a guess. */

/** Structural view of a Babel node. The walk is generic — it recurses on any
 * child that looks like a node — so nothing here needs `@babel/types`. */
interface AstNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null;
  [key: string]: unknown;
}

/** A pathological minified line would cost more to parse than the map is
 * worth. Skipped hunks simply contribute no facts. */
const MAX_HUNK_CHARS = 200_000;

const PARSE_OPTIONS: Parameters<typeof parse>[1] = {
  sourceType: 'module',
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowUndeclaredExports: true,
  allowNewTargetOutsideFunction: true,
  plugins: ['typescript', 'jsx', 'decorators-legacy', 'explicitResourceManagement'],
};

const SKIP_KEYS = new Set(['loc', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'errors', 'tokens']);

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

/** How many synthetic closers a fragment may be given before it is declared
 * unparseable. A hunk is cut at arbitrary lines, so it routinely ends inside a
 * block; six covers the nesting real diffs produce. */
const MAX_SYNTHETIC_CLOSERS = 6;

/** Tolerant parse of a fragment. A hunk is a slice of a file, so it is rarely
 * a valid program on its own: it usually opens blocks it never closes, and
 * sometimes closes blocks it never opened. The ladder tries the fragment as
 * written first, then with closing braces appended, and only then wrapped in a
 * block that can absorb a leading stray `}`. The wrapped attempts come last
 * because a block cannot contain `export`, which most real hunks do.
 *
 * The prefix shifts line numbers by one, so each attempt reports the offset
 * that maps a parsed node back to the fragment's own coordinates. */
function parseFragment(text: string): { program: AstNode; lineOffset: number } | null {
  for (const prefix of ['', 'if (0) {\n']) {
    for (let closers = 0; closers <= MAX_SYNTHETIC_CLOSERS; closers += 1) {
      const source = `${prefix}${text}${closers > 0 ? `\n${'}'.repeat(closers)}` : ''}`;
      try {
        const file = parse(source, PARSE_OPTIONS) as unknown as { program: AstNode };
        return { program: file.program, lineOffset: prefix === '' ? 0 : 1 };
      } catch {
        // Not balanced yet; add another closer, then try the wrapped form.
      }
    }
  }
  return null;
}

interface ParsedSide {
  /** Every parsed root: one for a whole-fragment parse, one per line when the
   * fragment only parsed a line at a time. Each carries the line number its
   * coordinates map back to. */
  roots: Array<{ node: AstNode; lineOffset: number }>;
  /** 1-based line numbers, in the reconstructed side, that the diff changed. */
  changed: Set<number>;
}

/** Rebuild one side of a hunk. Context lines are kept so the fragment is real
 * code; only the `+` (or `-`) lines count as changed, which is what decides
 * whether a parsed name is a fact about this decision. */
function reconstruct(lines: string[], sign: '+' | '-'): { text: string; changed: Set<number> } {
  const opposite = sign === '+' ? '-' : '+';
  const kept: string[] = [];
  const changed = new Set<number>();
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue;
    if (line.startsWith(opposite)) continue;
    const isChanged = line.startsWith(sign);
    kept.push(line.length > 0 ? line.slice(1) : '');
    if (isChanged) changed.add(kept.length);
  }
  return { text: kept.join('\n'), changed };
}

function parseSide(lines: string[], sign: '+' | '-'): ParsedSide {
  const { text, changed } = reconstruct(lines, sign);
  if (text.trim().length === 0 || text.length > MAX_HUNK_CHARS) return { roots: [], changed };
  const whole = parseFragment(text);
  if (whole) return { roots: [{ node: whole.program, lineOffset: whole.lineOffset }], changed };
  // Nothing parsed as a unit. Read what can be read: each line on its own,
  // which still separates code from strings and comments.
  const roots: ParsedSide['roots'] = [];
  text.split('\n').forEach((line, index) => {
    const parsed = parseFragment(line);
    if (parsed) roots.push({ node: parsed.program, lineOffset: parsed.lineOffset - index });
  });
  return { roots, changed };
}

/** Everything one side of a hunk says. Kept per side rather than merged into
 * one bag: a call on the `-` side is a call this patch deleted, and reading it
 * as a live one drew edges to code that will not exist after the change. */
export interface SideFacts {
  declared: Set<string>;
  declaredTypes: Set<string>;
  calls: Set<string>;
  typeReferences: Set<string>;
  inheritance: Set<string>;
  identifiers: Set<string>;
  imports: Array<{ module: string | null; symbols: string[] }>;
}

export interface HunkFacts {
  /** Read from the file as the patch leaves it: `+` lines and their context. */
  added: SideFacts;
  /** Read from the file as it stood: `-` lines and their context. */
  removed: SideFacts;
  /** Symbol name to the parameters this hunk added to an existing signature. */
  widenedSignatures: Map<string, string[]>;
  /** Symbol name to the parameters this hunk took off an existing signature. */
  narrowedSignatures: Map<string, string[]>;
}

export function emptySideFacts(): SideFacts {
  return {
    declared: new Set(), declaredTypes: new Set(), calls: new Set(),
    typeReferences: new Set(), inheritance: new Set(), identifiers: new Set(), imports: [],
  };
}

export function emptyHunkFacts(): HunkFacts {
  return { added: emptySideFacts(), removed: emptySideFacts(), widenedSignatures: new Map(), narrowedSignatures: new Map() };
}

function identifierName(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return String(node.name);
  // `A.B` in a type or heritage position: the changed thing is `A`.
  if (node.type === 'TSQualifiedName' || node.type === 'JSXMemberExpression') return identifierName(node.left ?? node.object);
  if (node.type === 'MemberExpression') return identifierName(node.property);
  return null;
}

/** Every name a binding pattern introduces. A destructured parameter yields
 * its field names rather than only the first, which is what makes a React
 * component's new prop link to the JSX that passes it. */
function patternNames(node: unknown, out: string[] = []): string[] {
  if (!isNode(node)) return out;
  if (node.type === 'Identifier') out.push(String(node.name));
  else if (node.type === 'ObjectPattern') for (const property of (node.properties as AstNode[] | undefined) ?? []) {
    if (property.type === 'RestElement') patternNames(property.argument, out);
    else {
      const key = identifierName(property.key);
      if (key && property.computed !== true) out.push(key);
      else patternNames(property.value, out);
    }
  }
  else if (node.type === 'ArrayPattern') for (const element of (node.elements as AstNode[] | undefined) ?? []) patternNames(element, out);
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
  else if (node.type === 'TSParameterProperty') patternNames(node.parameter, out);
  return out;
}

const TYPE_DECLARATIONS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'ClassDeclaration', 'ClassExpression']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'TSDeclareFunction', 'ObjectMethod', 'ClassMethod']);

/** Names a statement declares, with the type-only subset separated out. */
function declaredBy(statement: AstNode): { names: string[]; types: string[] } {
  const node = (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration')
    ? (isNode(statement.declaration) ? statement.declaration : null)
    : statement;
  if (!node) return { names: [], types: [] };
  if (node.type === 'VariableDeclaration') {
    const names = ((node.declarations as AstNode[] | undefined) ?? []).flatMap((declarator) => patternNames(declarator.id));
    return { names, types: [] };
  }
  const name = identifierName(node.id);
  if (!name) return { names: [], types: [] };
  if (TYPE_DECLARATIONS.has(node.type)) return { names: [name], types: [name] };
  if (FUNCTION_TYPES.has(node.type) || node.type === 'TSModuleDeclaration') return { names: [name], types: [] };
  return { names: [], types: [] };
}

function spans(node: AstNode, offset: number, changed: Set<number>): boolean {
  if (!node.loc) return false;
  for (let line = node.loc.start.line - offset; line <= node.loc.end.line - offset; line += 1) {
    if (changed.has(line)) return true;
  }
  return false;
}

function startedOnChangedLine(node: AstNode, offset: number, changed: Set<number>): boolean {
  return node.loc ? changed.has(node.loc.start.line - offset) : false;
}

/** Read one hunk into facts, keeping the two sides of the diff apart.
 * `declares` is false for a test file: a test names the code under test
 * without owning any of it, so it consumes only. */
export function readHunk(lines: string[], declares: boolean): HunkFacts {
  const facts = emptyHunkFacts();
  const after = parseSide(lines, '+');
  const before = parseSide(lines, '-');
  if (declares) {
    facts.widenedSignatures = addedParameters(after, before);
    facts.narrowedSignatures = addedParameters(before, after);
  }

  // Each side fills its own bag. The `-` side is read exactly as carefully as
  // the `+` side, because "this decision stopped calling that" is as real a
  // fact about the change as "this decision started calling that". It is a
  // different fact, and the map now says which one it has.
  for (const [side, bag] of [[after, facts.added], [before, facts.removed]] as const) {
    for (const { node: root, lineOffset } of side.roots) {
      if (declares) {
        // Module level only, which the fragment reports faithfully: diff lines
        // keep their original indentation, so a declaration that starts at
        // column 0 is a declaration the rest of the diff can see.
        for (const statement of (root.body as AstNode[] | undefined) ?? []) {
          if (statement.loc && statement.loc.start.column !== 0) continue;
          if (!spans(statement, lineOffset, side.changed)) continue;
          const { names, types } = declaredBy(statement);
          for (const name of names) bag.declared.add(name);
          for (const name of types) bag.declaredTypes.add(name);
        }
      }
      walk(root, (node) => {
        if (!startedOnChangedLine(node, lineOffset, side.changed)) return;
        if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
          bag.identifiers.add(String(node.name));
          return;
        }
        if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression') {
          const callee = identifierName(node.callee);
          if (callee) bag.calls.add(callee);
          const module = requiredModule(node);
          if (module) bag.imports.push({ module, symbols: [] });
          return;
        }
        // Rendering a component is invoking it, so JSX carries the same weight
        // as a call. This is the edge that makes the map useful in React: a
        // changed component links to every place the diff renders it.
        if (node.type === 'JSXOpeningElement') {
          const name = identifierName(node.name);
          if (name && /^[A-Z]/.test(name)) bag.calls.add(name);
          return;
        }
        if (node.type === 'TSTypeReference' || node.type === 'TSTypeQuery') {
          const name = identifierName(node.typeName ?? node.exprName);
          if (name) bag.typeReferences.add(name);
          return;
        }
        if (node.type === 'TSExpressionWithTypeArguments' || node.type === 'ClassImplements') {
          const name = identifierName(node.expression ?? node.id);
          if (name) bag.inheritance.add(name);
          return;
        }
        if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
          const name = identifierName(node.superClass);
          if (name) bag.inheritance.add(name);
          return;
        }
        if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
          const source = isNode(node.source) ? String(node.source.value) : null;
          if (node.type !== 'ImportDeclaration' && !source) return;
          const symbols = ((node.specifiers as AstNode[] | undefined) ?? []).flatMap((specifier) => [
            identifierName(specifier.imported ?? specifier.exported),
            identifierName(specifier.local),
          ]).filter((name): name is string => Boolean(name));
          bag.imports.push({ module: source, symbols: [...new Set(symbols)] });
        }
      });
    }
  }
  return facts;
}

function requiredModule(node: AstNode): string | null {
  const callee = isNode(node.callee) ? node.callee : null;
  const isRequire = callee?.type === 'Identifier' && callee.name === 'require';
  if (!isRequire && callee?.type !== 'Import') return null;
  const first = ((node.arguments as AstNode[] | undefined) ?? [])[0];
  return first && first.type === 'StringLiteral' ? String(first.value) : null;
}

/** Every function-like signature in one side of a hunk, by name. Parsed rather
 * than pattern-matched, so a parameter list spread over five lines is read in
 * full and a destructured props object reports each field it declares. */
function signatures(side: ParsedSide): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (name: string | null, params: unknown) => {
    if (!name) return;
    const names = ((params as AstNode[] | undefined) ?? []).flatMap((param) => patternNames(param));
    const existing = found.get(name);
    found.set(name, existing ? [...new Set([...existing, ...names])] : names);
  };
  for (const { node: root } of side.roots) {
    walk(root, (node) => {
      if (node.type === 'FunctionDeclaration' || node.type === 'TSDeclareFunction') add(identifierName(node.id), node.params);
      else if (node.type === 'ClassMethod' || node.type === 'ObjectMethod') add(identifierName(node.key), node.params);
      else if (node.type === 'VariableDeclarator' && isNode(node.init) && FUNCTION_TYPES.has(node.init.type)) add(identifierName(node.id), node.init.params);
      else if (node.type === 'ClassProperty' || node.type === 'PropertyDefinition') {
        if (isNode(node.value) && FUNCTION_TYPES.has(node.value.type)) add(identifierName(node.key), node.value.params);
      }
    });
  }
  return found;
}

/** Parameters `now` has on a signature that `previously` did not. Run one way
 * round it reports what the patch added to a signature; run the other way, what
 * the patch took off. A name present on only one side is a function this patch
 * created or deleted outright rather than a signature that changed, and nobody
 * in the diff was calling it before, so it is skipped either way. */
function addedParameters(now: ParsedSide, previously: ParsedSide): Map<string, string[]> {
  const current = signatures(now);
  const prior = signatures(previously);
  const changed = new Map<string, string[]>();
  for (const [name, params] of current) {
    const before = prior.get(name);
    if (!before) continue;
    const added = params.filter((param) => !before.includes(param));
    if (added.length > 0) changed.set(name, added);
  }
  return changed;
}
