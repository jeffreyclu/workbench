import { emptySideFacts, readHunk, type SideFacts } from './change-map-ast.js';
import type { DiffHunkReviewState } from './contracts.js';
import type { ReviewDecision, ReviewRiskSignal } from './review-decisions.js';

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
export const CHANGE_RELATIONS = ['passes-parameter', 'drops-parameter', 'implements', 'references-type', 'imports', 'calls', 'uses'] as const;
export type ChangeRelation = typeof CHANGE_RELATIONS[number];

/** Whether the relationship an edge describes survives the patch. A `removed`
 * edge is a real fact — a caller that was taken out is exactly the kind of
 * thing a reviewer has to notice — but it is not a live dependency, so it
 * never outranks one and it is drawn as the dashed line it is. */
export type ChangeDirection = 'added' | 'removed';

/** Strongest wins when two decisions relate in several ways at once. A caller
 * updated for a widened signature also merely "uses" the symbol; saying so
 * would bury the fact that actually matters to the reviewer. */
const RELATION_STRENGTH: Record<ChangeRelation, number> = {
  'passes-parameter': 7, 'drops-parameter': 6, implements: 5, 'references-type': 4, imports: 3, calls: 2, uses: 1,
};

export const CHANGE_RELATION_LABELS: Record<ChangeRelation, string> = {
  'passes-parameter': 'Passes new parameter', 'drops-parameter': 'Loses removed parameter', implements: 'Implements',
  'references-type': 'References type', imports: 'Imports', calls: 'Calls', uses: 'Uses',
};

/** How the pair reads across the patch. `new` is coupling that did not exist,
 * `kept` is coupling the patch touched but left in place, `rewired` is a pair
 * that relates in a different way than it used to, and `severed` is coupling
 * the patch removed outright. This is the only honest complexity signal a diff
 * can give: it compares the two sides of the lines that actually changed, and
 * says nothing about relationships the patch never touched. */
export type ChangeContinuity = 'new' | 'kept' | 'rewired' | 'severed';

export function changeEdgeContinuity(edge: { relation: ChangeRelation; change: ChangeDirection; prior?: ChangeRelation | null }): ChangeContinuity {
  if (edge.change === 'removed') return 'severed';
  if (!edge.prior) return 'new';
  return edge.prior === edge.relation ? 'kept' : 'rewired';
}

const lowerFirst = (label: string): string => `${label.charAt(0).toLowerCase()}${label.slice(1)}`;

/** The label as drawn on an edge. A relation the patch deletes reads as the
 * past tense of itself, so the diagram never shows a dependency that is gone
 * in the same words as one that is there. A pair the patch rewired carries
 * both readings at once — the new relation, with the old one behind it. */
export function changeEdgeLabel(edge: { relation: ChangeRelation; change: ChangeDirection; prior?: ChangeRelation | null }): string {
  const label = CHANGE_RELATION_LABELS[edge.relation];
  if (edge.change === 'removed') return `No longer ${lowerFirst(label)}`;
  if (edge.prior && edge.prior !== edge.relation) return `${label} (was ${lowerFirst(CHANGE_RELATION_LABELS[edge.prior])})`;
  return label;
}

/** A module-level name the decision owns, and what the patch did to it. */
export interface ChangeMapSymbol {
  name: string;
  kind: 'type' | 'value';
  /** `added` and `removed` mean the declaration itself appeared or went away;
   * `changed` means it exists on both sides and its body or signature moved. */
  change: 'added' | 'removed' | 'changed';
}

/** A parameter list that moved on a signature that already existed — the edit
 * most likely to have forced the rest of the diff. */
export interface ChangeMapSignatureChange {
  symbol: string;
  added: string[];
  removed: string[];
}

export interface ChangeMapNode {
  /** The review decision id, so selection is shared with the queue and the diff pane. */
  id: string;
  ordinal: number;
  label: string;
  subject: string | null;
  filePath: string;
  fileCount: number;
  /** Every file the decision touches. Carried in full so a node can be read
   * without opening the diff, rather than reduced to a count. */
  filePaths: string[];
  /** The code the node is actually about: the names it declares, drops or
   * rewrites, so the box shows symbols and not only a generated sentence. */
  symbols: ChangeMapSymbol[];
  signatureChanges: ChangeMapSignatureChange[];
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
  /** Whether this relationship exists after the patch or was deleted by it. */
  change: ChangeDirection;
  /** The relation this pair had before the patch, when the patch removed one
   * and added another between the same two decisions. `null` means nothing
   * was there to begin with, which is what makes the edge new coupling rather
   * than a rewiring of coupling that already existed. */
  prior: ChangeRelation | null;
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

function isCodeDecision(decision: ReviewDecision): boolean {
  return decision.filePaths.some((path) => CODE_FILE.test(path));
}

interface DecisionFacts {
  decision: ReviewDecision;
  /** The decision's non-test JS/TS files: the only ones it may own a symbol in,
   * and the only ones another decision's import can resolve to. */
  sourceFiles: string[];
  /** Names this decision owns, from either side of the diff: a symbol it
   * deleted is still a symbol it owns, and the rest of the diff moved because
   * that symbol went away. */
  declared: Set<string>;
  declaredTypes: Set<string>;
  /** Symbol name to the parameters this decision added to its signature. */
  widenedSignatures: Map<string, string[]>;
  /** Symbol name to the parameters this decision took off its signature. */
  narrowedSignatures: Map<string, string[]>;
  /** What the decision references after the patch, and what it referenced
   * before. Kept apart so a deleted call never draws a live edge. */
  added: SideFacts;
  removed: SideFacts;
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

/** Split per hunk rather than per decision. `codeHunks` is everything the
 * decision may react to; `sourceHunks` is the narrower set it may declare from.
 * The difference is the whole fix: a decision that edits `loader.ts` and
 * `loader.test.ts` shares one subject and so is one decision, and reading its
 * declarations from the test half made it the cause of every implementation the
 * test merely names. A test still consumes — it moves because code moved. */
function factsFor(decision: ReviewDecision): DecisionFacts {
  const codeHunks = decision.hunks.filter((hunk) => CODE_FILE.test(hunk.filePath));
  const sourceHunks = codeHunks.filter((hunk) => !TEST_FILE.test(hunk.filePath));
  const added = emptySideFacts();
  const removed = emptySideFacts();
  const widenedSignatures = new Map<string, string[]>();
  const narrowedSignatures = new Map<string, string[]>();
  for (const hunk of codeHunks) {
    const facts = readHunk(hunk.lines, !TEST_FILE.test(hunk.filePath));
    mergeSide(added, facts.added);
    mergeSide(removed, facts.removed);
    mergeParameters(widenedSignatures, facts.widenedSignatures);
    mergeParameters(narrowedSignatures, facts.narrowedSignatures);
  }
  // The subject is the enclosing function or type of a body-only edit, which is
  // exactly the thing other hunks in the diff react to. The parser only sees
  // the fragment, so a hunk cut from the middle of a function has no
  // declaration to find. It is a guess read from the hunk header, so a decision
  // with no source hunk cannot use it: a test's subject — the name it passes to
  // `describe` — is the code under test, not something the test owns.
  if (decision.subject && sourceHunks.length > 0) added.declared.add(decision.subject);
  return {
    decision,
    sourceFiles: [...new Set(sourceHunks.map((hunk) => hunk.filePath))],
    declared: new Set([...added.declared, ...removed.declared]),
    declaredTypes: new Set([...added.declaredTypes, ...removed.declaredTypes]),
    widenedSignatures,
    narrowedSignatures,
    added,
    removed,
  };
}

function mergeSide(target: SideFacts, source: SideFacts): void {
  for (const name of source.declared) target.declared.add(name);
  for (const name of source.declaredTypes) target.declaredTypes.add(name);
  for (const name of source.calls) target.calls.add(name);
  for (const name of source.typeReferences) target.typeReferences.add(name);
  for (const name of source.inheritance) target.inheritance.add(name);
  for (const name of source.identifiers) target.identifiers.add(name);
  target.imports.push(...source.imports);
}

function mergeParameters(target: Map<string, string[]>, source: Map<string, string[]>): void {
  for (const [name, parameters] of source) {
    target.set(name, [...new Set([...(target.get(name) ?? []), ...parameters])]);
  }
}

/** The node's own contents: every name it declares, with what the patch did to
 * it. Sorted so the declarations that appeared or went away lead, because a
 * symbol that changed shape is the reason the edges around it exist. */
function symbolsOf(fact: DecisionFacts): ChangeMapSymbol[] {
  const order = { added: 0, removed: 1, changed: 2 };
  return [...fact.declared].map((name) => {
    const inAfter = fact.added.declared.has(name);
    const inBefore = fact.removed.declared.has(name);
    return {
      name,
      kind: fact.declaredTypes.has(name) ? 'type' as const : 'value' as const,
      change: inAfter && inBefore ? 'changed' as const : inAfter ? 'added' as const : 'removed' as const,
    };
  }).sort((left, right) => order[left.change] - order[right.change] || left.name.localeCompare(right.name));
}

function signatureChangesOf(fact: DecisionFacts): ChangeMapSignatureChange[] {
  const names = new Set([...fact.widenedSignatures.keys(), ...fact.narrowedSignatures.keys()]);
  return [...names].sort().map((symbol) => ({
    symbol,
    added: fact.widenedSignatures.get(symbol) ?? [],
    removed: fact.narrowedSignatures.get(symbol) ?? [],
  }));
}

function parameterPhrase(parameters: string[]): string {
  const named = parameters.map((parameter) => `\`${parameter}\``);
  if (named.length === 1) return `the ${named[0]} parameter`;
  return `the ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]} parameters`;
}

function explain(relation: ChangeRelation, change: ChangeDirection, from: ReviewDecision, to: ReviewDecision, fromPath: string, symbols: string[], parameters: string[]): string {
  const symbol = `\`${symbols[0]}\``;
  const also = symbols.length > 1 ? ` Also ${symbols.slice(1).map((name) => `\`${name}\``).join(', ')}.` : '';
  // Past tense throughout when the patch deleted the reference: the sentence
  // has to say the call is gone, not describe it as though it were still there.
  const gone = change === 'removed';
  if (relation === 'passes-parameter') return `Decision ${from.ordinal} adds ${parameterPhrase(parameters)} to ${symbol}; decision ${to.ordinal} ${gone ? 'no longer calls it' : 'calls it'}.`;
  if (relation === 'drops-parameter') return `Decision ${from.ordinal} removes ${parameterPhrase(parameters)} from ${symbol}; decision ${to.ordinal} ${gone ? 'no longer calls it' : 'calls it'}.`;
  if (relation === 'implements') return `Decision ${to.ordinal} ${gone ? 'no longer extends or implements' : 'extends or implements'} ${symbol}, changed in decision ${from.ordinal}.${also}`;
  if (relation === 'references-type') return `Decision ${to.ordinal} ${gone ? 'no longer uses' : 'uses'} the ${symbol} type, changed in decision ${from.ordinal}.${also}`;
  if (relation === 'imports') return `Decision ${to.ordinal} ${gone ? 'no longer imports' : 'imports'} ${symbol} from ${fromPath}, changed in decision ${from.ordinal}.${also}`;
  if (relation === 'calls') return `Decision ${to.ordinal} ${gone ? 'no longer calls' : 'calls'} ${symbol}, changed in decision ${from.ordinal}.${also}`;
  return `Decision ${to.ordinal} ${gone ? 'no longer references' : 'references'} ${symbol}, changed in decision ${from.ordinal}.${also}`;
}

interface EdgeCandidate {
  relation: ChangeRelation;
  change: ChangeDirection;
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

  const pairs = new Map<string, EdgeCandidate & { from: DecisionFacts; to: DecisionFacts; prior: ChangeRelation | null }>();
  const record = (from: DecisionFacts, to: DecisionFacts, candidate: EdgeCandidate) => {
    if (from.decision.id === to.decision.id) return;
    const key = `${from.decision.id} ${to.decision.id}`;
    const existing = pairs.get(key);
    if (!existing) {
      pairs.set(key, { ...candidate, from, to, prior: null });
      return;
    }
    // A relationship that survives the patch beats one the patch deleted, no
    // matter how strong the deleted one was: the reviewer follows an edge to
    // read the code as it will be, and a pair that is both is a live pair.
    // The deleted relation is not discarded though — it is kept as `prior`, so
    // the live edge carries the shape the pair used to have underneath the one
    // it has now. Without it, a pair the patch rewired was indistinguishable
    // from coupling the patch invented.
    if (existing.change !== candidate.change) {
      const gone = candidate.change === 'removed' ? candidate.relation : existing.relation;
      const live = candidate.change === 'added' ? { ...candidate, from, to } : existing;
      const prior = existing.prior && RELATION_STRENGTH[existing.prior] >= RELATION_STRENGTH[gone] ? existing.prior : gone;
      pairs.set(key, { ...live, prior });
      return;
    }
    if (RELATION_STRENGTH[candidate.relation] > RELATION_STRENGTH[existing.relation]) {
      pairs.set(key, { ...candidate, from, to, prior: existing.prior });
    } else if (candidate.relation === existing.relation) {
      existing.symbols = [...new Set([...existing.symbols, ...candidate.symbols])].slice(0, 3);
    }
  };

  const producersOf = (symbol: string): DecisionFacts[] => {
    const producers = declaredBy.get(symbol) ?? [];
    return producers.length > MAX_DECLARING_DECISIONS ? [] : producers;
  };

  for (const consumer of facts) {
    // Once per side of the diff. `change` says which side the reference came
    // from, so an edge states whether the consumer still does this after the
    // patch or only used to — the two used to be indistinguishable.
    for (const [change, references] of [['added', consumer.added], ['removed', consumer.removed]] as const) {
      // Weakest relation first: `record` keeps the strongest one per pair, so
      // the order here is about reading the loop, not about the result.
      for (const symbol of references.identifiers) {
        if (symbol.length < 3 || AMBIGUOUS_NAMES.has(symbol)) continue;
        for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'uses', change, symbols: [symbol], parameters: [] });
      }
      for (const symbol of references.calls) {
        for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'calls', change, symbols: [symbol], parameters: [] });
      }
      for (const imported of references.imports) {
        const module = imported.module ? resolveModulePath(consumer.decision.filePaths[0] ?? '', imported.module) : null;
        const byPath = module ? ownersByPath.get(module) ?? ownersByPath.get(`${module}/index`) ?? [] : [];
        for (const producer of byPath) {
          const symbol = imported.symbols.find((name) => producer.declared.has(name)) ?? imported.symbols[0] ?? module!.split('/').pop()!;
          record(producer, consumer, { relation: 'imports', change, symbols: [symbol], parameters: [] });
        }
        for (const symbol of imported.symbols) {
          for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'imports', change, symbols: [symbol], parameters: [] });
        }
      }
      for (const symbol of references.typeReferences) {
        for (const producer of producersOf(symbol)) {
          if (producer.declaredTypes.has(symbol)) record(producer, consumer, { relation: 'references-type', change, symbols: [symbol], parameters: [] });
        }
      }
      for (const symbol of references.inheritance) {
        for (const producer of producersOf(symbol)) record(producer, consumer, { relation: 'implements', change, symbols: [symbol], parameters: [] });
      }
      // Only on the added side. These two relations describe what the patch did
      // to a call site, so claiming a deleted line "passes the new parameter"
      // states the opposite of the truth — and `prior` now prints that claim.
      // The deleted line still records the plain `calls` it really was.
      if (change === 'added') {
        for (const symbol of references.calls) {
          for (const producer of producersOf(symbol)) {
            const widened = producer.widenedSignatures.get(symbol);
            if (widened) record(producer, consumer, { relation: 'passes-parameter', change, symbols: [symbol], parameters: widened });
            const narrowed = producer.narrowedSignatures.get(symbol);
            if (narrowed) record(producer, consumer, { relation: 'drops-parameter', change, symbols: [symbol], parameters: narrowed });
          }
        }
      }
    }
  }

  // Live edges first, so a trimmed map drops the relationships the patch
  // deleted before it drops a single one that still exists.
  const ranked = [...pairs.values()].sort((left, right) =>
    (left.change === right.change ? 0 : left.change === 'added' ? -1 : 1)
    || RELATION_STRENGTH[right.relation] - RELATION_STRENGTH[left.relation]
    || left.from.decision.ordinal - right.from.decision.ordinal
    || left.to.decision.ordinal - right.to.decision.ordinal);
  const kept = ranked.slice(0, MAX_EDGES);
  const edges: ChangeMapEdge[] = kept.map((pair) => ({
    id: `${pair.from.decision.id}->${pair.to.decision.id}`,
    fromId: pair.from.decision.id,
    toId: pair.to.decision.id,
    relation: pair.relation,
    change: pair.change,
    prior: pair.prior,
    symbols: pair.symbols,
    explanation: explain(pair.relation, pair.change, pair.from.decision, pair.to.decision, pair.from.sourceFiles[0] ?? pair.from.decision.filePaths[0] ?? '', pair.symbols, pair.parameters),
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
      filePaths: decision.filePaths,
      symbols: symbolsOf(facts[index]),
      signatureChanges: signatureChangesOf(facts[index]),
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
