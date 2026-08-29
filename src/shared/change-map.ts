import type { DiffHunkReviewState } from './contracts.js';
import type { ReviewDecision, ReviewDecisionHunk, ReviewRiskSignal } from './review-decisions.js';

/** Why this lives beside `review-decisions.ts`: the map is a second reading of
 * the same decisions, not a second parse of the diff. Nodes are the decisions
 * the reviewer already sees in the queue, so a node id is a decision id and
 * clicking one can select its hunks without any translation layer.
 *
 * The map is deliberately diff-scoped. An edge is only drawn when both of its
 * endpoints changed in the open diff — this answers "what else in this change
 * moved because of this?", which is the reviewer's question, rather than
 * "what in the repository touches this?", which is a whole-codebase index and
 * a different tool.
 *
 * Three rules keep the edges honest, each of them a bug this map used to have.
 * They are applied per hunk, not per decision, because a decision groups every
 * hunk that shares a subject and so routinely spans an implementation, its
 * test and a fixture at once: only JS/TS hunks are read at all, only
 * module-level declarations make a decision the source of an edge, and a test
 * hunk never declares anything. */
export const CHANGE_RELATIONS = ['passes-parameter', 'implements', 'references-type', 'imports', 'calls', 'uses'] as const;
export type ChangeRelation = typeof CHANGE_RELATIONS[number];

/** Strongest wins when two decisions relate in several ways at once. A caller
 * updated for a widened signature also merely "uses" the symbol; saying so
 * would bury the fact that actually matters to the reviewer. */
const RELATION_STRENGTH: Record<ChangeRelation, number> = {
  'passes-parameter': 6, implements: 5, 'references-type': 4, imports: 3, calls: 2, uses: 1,
};

export const CHANGE_RELATION_LABELS: Record<ChangeRelation, string> = {
  'passes-parameter': 'Passes new parameter', implements: 'Implements', 'references-type': 'References type',
  imports: 'Imports', calls: 'Calls', uses: 'Uses',
};

export interface ChangeMapNode {
  /** The review decision id, so selection is shared with the queue and the diff pane. */
  id: string;
  ordinal: number;
  label: string;
  subject: string | null;
  filePath: string;
  fileCount: number;
  behavior: string;
  additions: number;
  deletions: number;
  state: DiffHunkReviewState | null;
  riskSignals: ReviewRiskSignal[];
  /** Number of edges touching this node, in either direction. */
  degree: number;
}

export interface ChangeMapEdge {
  id: string;
  /** The decision that changed the thing. */
  fromId: string;
  /** The decision that had to move because of it. */
  toId: string;
  relation: ChangeRelation;
  symbols: string[];
  explanation: string;
}

export interface ChangeMap {
  nodes: ChangeMapNode[];
  edges: ChangeMapEdge[];
  /** Edges found but not returned because of `MAX_EDGES`. Reported rather than
   * dropped silently, so a trimmed map never reads as a complete one. */
  omittedEdges: number;
}

/** Enough to read a wide refactor, few enough to stay a diagram rather than a
 * hairball. Anything past this is reported as omitted. */
const MAX_EDGES = 400;

/** A symbol declared by this many separate decisions is a name collision, not
 * a relationship (`handler`, `render`, `index` in four files each). */
const MAX_DECLARING_DECISIONS = 3;

/** Names too common to carry a bare `uses` edge on their own. Stronger
 * relations keep them: `calls`, type positions and imports have real syntax
 * behind them, while `uses` is only "this identifier appeared". */
const AMBIGUOUS_NAMES = new Set([
  'config', 'context', 'count', 'data', 'error', 'event', 'file', 'handler', 'id', 'index', 'item', 'items',
  'key', 'label', 'line', 'list', 'map', 'message', 'name', 'node', 'options', 'path', 'props', 'ref',
  'request', 'response', 'result', 'set', 'state', 'text', 'title', 'type', 'value',
]);

/** The scanner reads JS/TS syntax, so only JS/TS sources are mapped. Styles,
 * markdown, JSON and snapshots matched identifiers with no declaration behind
 * them and linked changes that have nothing to do with each other. */
const CODE_FILE = /\.(?:m|c)?[jt]sx?$/;

/** A test moves because an implementation moved, never the reverse. Tests stay
 * in the map as downstream nodes, but they never source an edge: `describe`,
 * `it` and a test's local fixtures name the code under test without declaring
 * any of it, which is what made one edited test read as the cause of every
 * implementation it covers. */
const TEST_FILE = /\.(?:test|spec)\.(?:m|c)?[jt]sx?$|(?:^|\/)__tests__\//;

const IMPORT_KEYWORDS = new Set(['import', 'export', 'from', 'as', 'type', 'typeof', 'const', 'let', 'var', 'require', 'default', 'await', 'new']);
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'super']);

/** Module-level declarations only, anchored at column 0. A `const rows = []`
 * inside a function body is invisible to every other decision in the diff, so
 * counting it as a declaration made unrelated changes that happen to use the
 * same common name look connected. Diff lines keep their original indentation,
 * so leading whitespace is a reliable "this is nested" test. */
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const TYPE_DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:interface|type|enum|class)\s+([A-Za-z_$][\w$]*)/;
const CALL_REFERENCE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
/** Type positions only, and only capitalised names: `: string` and `<number>`
 * are not decisions in this diff, and lowercase matches were mostly variables. */
const TYPE_REFERENCE = /(?::\s*|<|\bas\s+|\bsatisfies\s+|\bextends\s+|\bimplements\s+)([A-Z][\w$]*)/g;
const INHERITANCE_REFERENCE = /\b(?:implements|extends)\s+([A-Za-z_$][\w$]*)/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const MODULE_SPECIFIER = /(?:^|\s)(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/;

function isCodeDecision(decision: ReviewDecision): boolean {
  return decision.filePaths.some((path) => CODE_FILE.test(path));
}

interface DecisionFacts {
  decision: ReviewDecision;
  /** The decision's non-test JS/TS files: the only ones it may own a symbol in,
   * and the only ones another decision's import can resolve to. */
  sourceFiles: string[];
  declared: Set<string>;
  declaredTypes: Set<string>;
  /** Symbol name to the parameters this decision added to its signature. */
  widenedSignatures: Map<string, string[]>;
  calls: Set<string>;
  typeReferences: Set<string>;
  inheritance: Set<string>;
  identifiers: Set<string>;
  imports: Array<{ module: string | null; symbols: string[] }>;
}

function signedLines(hunks: ReviewDecisionHunk[], sign: '+' | '-'): string[] {
  const marker = sign.repeat(3);
  return hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.startsWith(sign) && !line.startsWith(marker))
    .map((line) => line.slice(1));
}

function collect(pattern: RegExp, text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const name = match.slice(1).find((group) => typeof group === 'string');
    if (name) names.push(name);
  }
  return names;
}

function splitParameters(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if ('([{<'.includes(character)) depth += 1;
    else if (')]}>'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parameterName(raw: string): string | null {
  const trimmed = raw.replace(/^\.\.\./, '').trim();
  return /^([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1]
    // A destructured parameter is named by its first field, which is what the
    // call site passes and therefore what the reviewer recognises.
    ?? /^\{\s*([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1]
    ?? null;
}

/** The first function-like signature on a line, with its parameter names. Read
 * with a depth counter rather than a regex so `(next: () => void)` survives.
 * A signature that wraps onto the next line is skipped: half a parameter list
 * would invent parameters that were never added. */
function signatureOf(line: string): { name: string; parameters: string[] } | null {
  const match = /\b([A-Za-z_$][\w$]*)\s*\(/.exec(line);
  if (!match) return null;
  const name = match[1];
  if (CONTROL_KEYWORDS.has(name)) return null;
  const open = match.index + match[0].length;
  let depth = 1;
  for (let index = open; index < line.length; index += 1) {
    const character = line[index];
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) {
      depth -= 1;
      if (depth === 0) {
        return character === ')'
          ? { name, parameters: splitParameters(line.slice(open, index)).map(parameterName).filter((parameter): parameter is string => Boolean(parameter)) }
          : null;
      }
    }
  }
  return null;
}

/** Parameters this decision added to an existing signature. Strict on purpose:
 * a removed line and an added line for the same name inside the same hunk is
 * an edit to one signature, while an added signature with no removed
 * counterpart is a brand-new function nobody was calling before. */
function widenedSignatures(hunks: ReviewDecisionHunk[]): Map<string, string[]> {
  const widened = new Map<string, string[]>();
  for (const hunk of hunks) {
    const before = new Map<string, string[]>();
    for (const line of hunk.lines) {
      if (!line.startsWith('-') || line.startsWith('---')) continue;
      const signature = signatureOf(line.slice(1));
      if (signature) before.set(signature.name, signature.parameters);
    }
    for (const line of hunk.lines) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const signature = signatureOf(line.slice(1));
      const previous = signature ? before.get(signature.name) : undefined;
      if (!signature || !previous) continue;
      const added = signature.parameters.filter((parameter) => !previous.includes(parameter));
      if (added.length > 0) widened.set(signature.name, [...new Set([...(widened.get(signature.name) ?? []), ...added])]);
    }
  }
  return widened;
}

function importsOf(lines: string[]): DecisionFacts['imports'] {
  const imports: DecisionFacts['imports'] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = MODULE_SPECIFIER.exec(trimmed);
    if (!match) continue;
    const module = match.slice(1).find((group) => typeof group === 'string') ?? null;
    const symbols = collect(IDENTIFIER, trimmed.replace(/['"][^'"]*['"]/g, ' ')).filter((name) => !IMPORT_KEYWORDS.has(name));
    imports.push({ module, symbols });
  }
  return imports;
}

function stripExtension(path: string): string {
  return path.replace(/\.(?:m|c)?[jt]sx?$/, '');
}

/** Resolve a relative specifier against the importing file. The repository
 * writes `.js` specifiers for TypeScript sources, so extensions are dropped on
 * both sides and the comparison is made on the extensionless path. Bare
 * package specifiers resolve to null: no dependency file is in the diff. */
export function resolveModulePath(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const segments = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return stripExtension(segments.join('/'));
}

function moduleDeclarations(lines: string[], pattern: RegExp): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    if (/^\s/.test(line)) continue;
    const name = pattern.exec(line)?.[1];
    if (name) names.add(name);
  }
  return names;
}

/** Split per hunk rather than per decision. `codeHunks` is everything the
 * decision may react to; `sourceHunks` is the narrower set it may declare from.
 * The difference is the whole fix: a decision that edits `loader.ts` and
 * `loader.test.ts` shares one subject and so is one decision, and reading its
 * declarations from the test half made it the cause of every implementation the
 * test merely names. A test still consumes — it moves because code moved. */
function factsFor(decision: ReviewDecision): DecisionFacts {
  const codeHunks = decision.hunks.filter((hunk) => CODE_FILE.test(hunk.filePath));
  const sourceHunks = codeHunks.filter((hunk) => !TEST_FILE.test(hunk.filePath));
  const added = signedLines(codeHunks, '+');
  const changedLines = [...added, ...signedLines(codeHunks, '-')];
  const declaredLines = [...signedLines(sourceHunks, '+'), ...signedLines(sourceHunks, '-')];
  const changed = changedLines.join('\n');
  const declared = moduleDeclarations(declaredLines, DECLARATION);
  // The subject is the enclosing function or type of a body-only edit, which is
  // exactly the thing other hunks in the diff react to. It is a guess read from
  // the hunk header, so a decision with no source hunk cannot use it: a test's
  // subject — the name it passes to `describe` — is the code under test, not
  // something the test owns.
  if (decision.subject && sourceHunks.length > 0) declared.add(decision.subject);
  return {
    decision,
    sourceFiles: [...new Set(sourceHunks.map((hunk) => hunk.filePath))],
    declared,
    declaredTypes: moduleDeclarations(declaredLines, TYPE_DECLARATION),
    widenedSignatures: widenedSignatures(sourceHunks),
    calls: new Set(collect(CALL_REFERENCE, changed).filter((name) => !CONTROL_KEYWORDS.has(name))),
    typeReferences: new Set(collect(TYPE_REFERENCE, changed)),
    inheritance: new Set(collect(INHERITANCE_REFERENCE, changed)),
    identifiers: new Set(collect(IDENTIFIER, changed)),
    imports: importsOf(added),
  };
}

function parameterPhrase(parameters: string[]): string {
  const named = parameters.map((parameter) => `\`${parameter}\``);
  if (named.length === 1) return `the ${named[0]} parameter`;
  return `the ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]} parameters`;
}

function explain(relation: ChangeRelation, from: ReviewDecision, to: ReviewDecision, fromPath: string, symbols: string[], parameters: string[]): string {
  const symbol = `\`${symbols[0]}\``;
  const also = symbols.length > 1 ? ` Also ${symbols.slice(1).map((name) => `\`${name}\``).join(', ')}.` : '';
  if (relation === 'passes-parameter') return `Decision ${from.ordinal} adds ${parameterPhrase(parameters)} to ${symbol}; decision ${to.ordinal} calls it.`;
  if (relation === 'implements') return `Decision ${to.ordinal} extends or implements ${symbol}, changed in decision ${from.ordinal}.${also}`;
  if (relation === 'references-type') return `Decision ${to.ordinal} uses the ${symbol} type, changed in decision ${from.ordinal}.${also}`;
  if (relation === 'imports') return `Decision ${to.ordinal} imports ${symbol} from ${fromPath}, changed in decision ${from.ordinal}.${also}`;
  if (relation === 'calls') return `Decision ${to.ordinal} calls ${symbol}, changed in decision ${from.ordinal}.${also}`;
  return `Decision ${to.ordinal} references ${symbol}, changed in decision ${from.ordinal}.${also}`;
}

interface EdgeCandidate {
  relation: ChangeRelation;
  symbols: string[];
  parameters: string[];
}

export function buildChangeMap(allDecisions: ReviewDecision[]): ChangeMap {
  const decisions = allDecisions.filter(isCodeDecision);
  const facts = decisions.map(factsFor);
  // Sources of edges. A test is a sink: it can react to a changed symbol, but
  // nothing downstream ever reacts to the test, so a decision with no non-test
  // JS/TS hunk declares nothing and can only ever be an edge's target.
  const sources = facts.filter((fact) => fact.sourceFiles.length > 0);
  const declaredBy = new Map<string, DecisionFacts[]>();
  for (const fact of sources) {
    for (const symbol of fact.declared) {
      declaredBy.set(symbol, [...(declaredBy.get(symbol) ?? []), fact]);
    }
  }
  const ownersByPath = new Map<string, DecisionFacts[]>();
  for (const fact of sources) {
    for (const filePath of fact.sourceFiles) {
      const key = stripExtension(filePath);
      ownersByPath.set(key, [...(ownersByPath.get(key) ?? []), fact]);
    }
  }

  const pairs = new Map<string, EdgeCandidate & { from: DecisionFacts; to: DecisionFacts }>();
  const record = (from: DecisionFacts, to: DecisionFacts, candidate: EdgeCandidate) => {
    if (from.decision.id === to.decision.id) return;
    const key = `${from.decision.id} ${to.decision.id}`;
    const existing = pairs.get(key);
    if (!existing) {
      pairs.set(key, { ...candidate, from, to });
      return;
    }
    if (RELATION_STRENGTH[candidate.relation] > RELATION_STRENGTH[existing.relation]) {
      pairs.set(key, { ...candidate, from, to });
    } else if (candidate.relation === existing.relation) {
      existing.symbols = [...new Set([...existing.symbols, ...candidate.symbols])].slice(0, 3);
    }
  };

  const producersOf = (symbol: string): DecisionFacts[] => {
    const producers = declaredBy.get(symbol) ?? [];
    return producers.length > MAX_DECLARING_DECISIONS ? [] : producers;
  };

  for (const consumer of facts) {
    // Weakest relation first: `record` keeps the strongest one per pair, so the
    // order here is about reading the loop, not about the result.
    for (const symbol of consumer.identifiers) {
      if (symbol.length < 3 || AMBIGUOUS_NAMES.has(symbol)) continue;
      for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'uses', symbols: [symbol], parameters: [] });
    }
    for (const symbol of consumer.calls) {
      for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'calls', symbols: [symbol], parameters: [] });
    }
    for (const imported of consumer.imports) {
      const module = imported.module ? resolveModulePath(consumer.decision.filePaths[0] ?? '', imported.module) : null;
      const byPath = module ? ownersByPath.get(module) ?? ownersByPath.get(`${module}/index`) ?? [] : [];
      for (const producer of byPath) {
        const symbol = imported.symbols.find((name) => producer.declared.has(name)) ?? imported.symbols[0] ?? module!.split('/').pop()!;
        record(producer, consumer, { relation: 'imports', symbols: [symbol], parameters: [] });
      }
      for (const symbol of imported.symbols) {
        for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'imports', symbols: [symbol], parameters: [] });
      }
    }
    for (const symbol of consumer.typeReferences) {
      for (const producer of producersOf(symbol)) {
        if (producer.declaredTypes.has(symbol)) record(producer, consumer, { relation: 'references-type', symbols: [symbol], parameters: [] });
      }
    }
    for (const symbol of consumer.inheritance) {
      for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'implements', symbols: [symbol], parameters: [] });
    }
    for (const symbol of consumer.calls) {
      for (const producer of producersOf(symbol)) {
        const parameters = producer.widenedSignatures.get(symbol);
        if (parameters) record(producer, consumer, { relation: 'passes-parameter', symbols: [symbol], parameters });
      }
    }
  }

  const ranked = [...pairs.values()].sort((left, right) =>
    RELATION_STRENGTH[right.relation] - RELATION_STRENGTH[left.relation]
    || left.from.decision.ordinal - right.from.decision.ordinal
    || left.to.decision.ordinal - right.to.decision.ordinal);
  const kept = ranked.slice(0, MAX_EDGES);
  const edges: ChangeMapEdge[] = kept.map((pair) => ({
    id: `${pair.from.decision.id}->${pair.to.decision.id}`,
    fromId: pair.from.decision.id,
    toId: pair.to.decision.id,
    relation: pair.relation,
    symbols: pair.symbols,
    explanation: explain(pair.relation, pair.from.decision, pair.to.decision, pair.from.sourceFiles[0] ?? pair.from.decision.filePaths[0] ?? '', pair.symbols, pair.parameters),
  }));

  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.fromId, (degrees.get(edge.fromId) ?? 0) + 1);
    degrees.set(edge.toId, (degrees.get(edge.toId) ?? 0) + 1);
  }

  const nodes: ChangeMapNode[] = decisions.map((decision, index) => {
    // A decision that edits an implementation and its test is located at the
    // implementation: labelling it with whichever file the patch happened to
    // list first made mixed decisions read as test-file changes.
    const primaryPath = facts[index].sourceFiles[0] ?? decision.filePaths[0] ?? '';
    return {
      id: decision.id,
      ordinal: decision.ordinal,
      label: decision.subject ?? primaryPath.split('/').pop() ?? 'Change',
      subject: decision.subject,
      filePath: primaryPath,
      fileCount: decision.filePaths.length,
      behavior: decision.behavior,
      additions: decision.additions,
      deletions: decision.deletions,
      state: decision.state,
      riskSignals: decision.riskSignals,
      degree: degrees.get(decision.id) ?? 0,
    };
  });

  return { nodes, edges, omittedEdges: ranked.length - kept.length };
}
