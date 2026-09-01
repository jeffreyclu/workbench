/** A hunk is a unit of *text* proximity, not of reasoning. Git emits one hunk
 * per contiguous edit, so an agent that writes forty lines of new code in one
 * place produces a single hunk containing several independent decisions — a new
 * function, the branch that calls it, the error path it added on the way. Asked
 * as one question, that hunk gets one verdict, one risk score and one queue
 * position, which is the same fatigue the queue was built to remove.
 *
 * This module cuts a hunk at the boundaries a reader would use: a construct
 * that starts at the hunk's own base indentation while every bracket opened
 * inside the block is closed. Both sides of the patch are tracked separately,
 * because a deletion's braces belong to the old file and an addition's to the
 * new one; requiring both to be balanced is what stops a cut landing inside a
 * body that only looks closed from one side. */
import type { DiffLogicBoundary } from '../../../shared/contracts.js';

export interface PatchHunk { range: string; lines: string[] }

/** What the TypeScript compiler read inside one block. Effects and hazards are
 * plain strings here for the same reason they are on the wire: the module that
 * names them imports the compiler and cannot ship to a browser bundle. */
export interface BlockAnalysis {
  /** The effect of the costliest primitive in the block. */
  effect: string;
  /** What the block costs to get wrong. What the Review queue ranks on. */
  score: number;
  /** Every hazard found anywhere in the block, deduplicated and sorted. */
  hazards: string[];
}

/** A block, plus the compiler's reading of it. `analysis` is null whenever no
 * boundary lands inside: an unparseable file, a language the parser does not
 * speak, or a block that only deletes. That is the ordinary case and it ranks
 * exactly as the queue did before the parser existed. */
export interface LogicBlock extends PatchHunk {
  analysis: BlockAnalysis | null;
}

/** Below this a hunk is already one thought — cutting it would cost queue
 * positions without separating anything. */
const MIN_CHANGED_LINES_TO_SPLIT = 12;
/** A block that runs past this without meeting a construct boundary is cut at
 * the next line back at base indent. Without the cap a long flat sequence —
 * a switch body, a table of literals — stays a single decision. */
const MAX_CHANGED_LINES_PER_BLOCK = 24;
/** Fewer changed lines than this is never worth its own decision, so a
 * boundary is only honoured once the current block has earned one. */
const MIN_CHANGED_LINES_PER_BLOCK = 3;

/** Kept deliberately generous on what opens a thought and silent on what
 * continues one: `else`, `catch` and a bare `}` are absent, so a cut never
 * lands between an `if` and the branch that completes it. */
const CONSTRUCT_START = new RegExp([
  String.raw`^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum|namespace)\b`,
  String.raw`^(?:export\s+)?(?:declare\s+)?(?:const|let|var|type)\s+[A-Za-z_$[{]`,
  String.raw`^(?:if|for|while|switch|try|do)\s*[({]`,
  String.raw`^(?:return|throw|yield)\b`,
  String.raw`^(?:case\s|default\s*:)`,
  String.raw`^(?:describe|it|test|before(?:Each|All)|after(?:Each|All))(?:\.\w+)?\s*\(`,
  String.raw`^(?:public|private|protected|static|readonly|abstract|get|set)\s+[A-Za-z_$]`,
  String.raw`^[A-Za-z_$][\w$]*\s*(?:<[^<>]*>)?\s*\([^;]*\)\s*(?::[^;=]+)?\s*\{\s*$`,
  String.raw`^(?:\/\/|\/\*)`,
  String.raw`^@[A-Za-z-]`,
  String.raw`^[.#&][A-Za-z_-][^;{}]*\{\s*$`,
].join('|'));

type LineKind = 'context' | 'addition' | 'deletion';

function lineKind(line: string): LineKind {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'addition';
  if (line.startsWith('-') && !line.startsWith('---')) return 'deletion';
  return 'context';
}

function lineCode(line: string): string {
  return line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') ? line.slice(1) : line;
}

/** Blank lines report `Infinity` so they never lower the base indent: an empty
 * line inside a nested body would otherwise make every nested statement look
 * like a top-level construct. */
function indentOf(code: string): number {
  if (!code.trim()) return Number.POSITIVE_INFINITY;
  return code.length - code.trimStart().length;
}

/** Approximate on purpose. Strings and line comments are removed so a brace in
 * a message or a URL cannot unbalance the block; anything subtler than that
 * (regex literals, template expressions) only ever suppresses a cut, which
 * degrades to today's coarser hunk rather than to a wrong one. */
function bracketDelta(code: string): number {
  const bare = code
    .replace(/\\./g, '')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
    .replace(/\/\/.*$/, '');
  let delta = 0;
  for (const character of bare) {
    if (character === '{' || character === '(' || character === '[') delta += 1;
    else if (character === '}' || character === ')' || character === ']') delta -= 1;
  }
  return delta;
}

interface HunkHeader { oldStart: number; newStart: number; context: string }

function parseHunkHeader(range: string): HunkHeader | null {
  const match = range.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
  return match ? { oldStart: Number(match[1]), newStart: Number(match[2]), context: match[3] ?? '' } : null;
}

/** The context slot of a synthetic header. It is read back by the subject and
 * behaviour derivation, so a block that opens on its own declaration names
 * itself instead of inheriting the enclosing function every sibling block also
 * claims. `@` is stripped because the slot terminates on it. */
function sanitizeContext(text: string): string {
  return text.replace(/@@/g, '@').replace(/[\r\n]+/g, ' ').slice(0, 120).trim();
}

function blockContext(lines: string[], fallback: string): string {
  for (const line of lines) {
    const code = lineCode(line).trim();
    if (!code || !CONSTRUCT_START.test(code)) continue;
    const cleaned = sanitizeContext(code);
    if (cleaned) return cleaned;
  }
  return fallback;
}

function countSides(lines: string[]): { oldCount: number; newCount: number; changed: number } {
  let oldCount = 0;
  let newCount = 0;
  let changed = 0;
  for (const line of lines) {
    const kind = lineKind(line);
    if (kind !== 'addition') oldCount += 1;
    if (kind !== 'deletion') newCount += 1;
    if (kind !== 'context') changed += 1;
  }
  return { oldCount, newCount, changed };
}

/** Where the indentation heuristic thinks a thought starts.
 *
 * This is the fallback, not the default: it is what answers for a file the
 * parser does not speak - a diff of Markdown, CSS, a lockfile, or anything
 * whose patch was too large to parse - and for a hunk the compiler found no
 * boundary inside. */
function heuristicCuts(hunk: PatchHunk): number[] {
  const codes = hunk.lines.map(lineCode);
  const indents = codes.map(indentOf);
  const finiteIndents = indents.filter((indent) => Number.isFinite(indent));
  if (finiteIndents.length === 0) return [];
  const baseIndent = Math.min(...finiteIndents);

  const cuts: number[] = [];
  let newDepth = 0;
  let oldDepth = 0;
  let changedInBlock = 0;
  let sawContent = false;
  hunk.lines.forEach((line, index) => {
    const kind = lineKind(line);
    const code = codes[index];
    const atBaseIndent = indents[index] <= baseIndent;
    const balanced = newDepth === 0 && oldDepth === 0;
    const opensConstruct = atBaseIndent && CONSTRUCT_START.test(code.trim());
    const overrun = atBaseIndent && changedInBlock >= MAX_CHANGED_LINES_PER_BLOCK;
    if (sawContent && balanced && changedInBlock >= MIN_CHANGED_LINES_PER_BLOCK && (opensConstruct || overrun)) {
      cuts.push(index);
      changedInBlock = 0;
      sawContent = false;
    }
    if (kind !== 'deletion') newDepth += bracketDelta(code);
    if (kind !== 'addition') oldDepth += bracketDelta(code);
    if (kind !== 'context') changedInBlock += 1;
    if (code.trim()) sawContent = true;
  });
  return cuts;
}

/** Where the TypeScript compiler says a thought starts.
 *
 * The boundaries arrive as line numbers in the file as the patch leaves it, so
 * this walks the hunk counting new-side lines and cuts where one lands on a
 * primitive's first line. Bracket balance is not checked and does not need to
 * be: a primitive start *is* a statement start, which is the property the
 * heuristic was approximating with brace counting in the first place.
 *
 * A deletion occupies no line in the after file, so it can never open a block -
 * the line it is attributed to is the one that now sits there, and that line
 * carries the boundary itself. */
function compilerCuts(hunk: PatchHunk, header: HunkHeader, boundaries: readonly DiffLogicBoundary[]): {
  cuts: number[];
  labels: Map<number, string>;
} {
  const starts = new Map<number, string>();
  for (const boundary of boundaries) starts.set(boundary.line, boundary.label);

  const cuts: number[] = [];
  const labels = new Map<number, string>();
  let newLine = header.newStart;
  let changedInBlock = 0;
  let sawContent = false;
  hunk.lines.forEach((line, index) => {
    const kind = lineKind(line);
    const label = kind === 'deletion' ? undefined : starts.get(newLine);
    if (index > 0 && sawContent && changedInBlock >= MIN_CHANGED_LINES_PER_BLOCK && label !== undefined) {
      cuts.push(index);
      labels.set(index, label);
      changedInBlock = 0;
      sawContent = false;
    }
    if (kind !== 'deletion') newLine += 1;
    if (kind !== 'context') changedInBlock += 1;
    if (lineCode(line).trim()) sawContent = true;
  });
  return { cuts, labels };
}

/** Turn cut points into blocks with real, recomputed `@@` headers.
 *
 * Both oracles end here, so a block is emitted identically however it was
 * found: same ids, same line arithmetic, same fold of trailing context. That
 * is what lets the boundary source change underneath the Review surface
 * without moving the addresses its recorded verdicts are keyed on. */
function assemble(
  hunk: PatchHunk,
  header: HunkHeader,
  cuts: number[],
  contextFor: (startIndex: number, lines: string[]) => string,
): PatchHunk[] {
  if (cuts.length === 0) return [hunk];

  const segments: { lines: string[]; startIndex: number }[] = [];
  let start = 0;
  for (const cut of [...cuts, hunk.lines.length]) {
    segments.push({ lines: hunk.lines.slice(start, cut), startIndex: start });
    start = cut;
  }
  // A segment with nothing changed in it is trailing context, not a decision:
  // it is folded back into the block whose change it explains.
  const merged: { lines: string[]; startIndex: number }[] = [];
  for (const segment of segments) {
    if (merged.length > 0 && countSides(segment.lines).changed === 0) merged[merged.length - 1].lines.push(...segment.lines);
    else merged.push(segment);
  }
  if (merged.length < 2) return [hunk];

  let oldLine = header.oldStart;
  let newLine = header.newStart;
  return merged.map((segment, index) => {
    const { oldCount, newCount } = countSides(segment.lines);
    const context = index === 0 ? header.context : contextFor(segment.startIndex, segment.lines);
    const range = `@@ -${oldLine},${oldCount} +${newLine},${newCount} @@${context ? ` ${context}` : ''}`;
    oldLine += oldCount;
    newLine += newCount;
    return { range, lines: segment.lines };
  });
}

/**
 * Split one patch hunk into the logic blocks inside it.
 *
 * `boundaries` are what the TypeScript compiler found in this file's changed
 * regions, computed on the server because the parser cannot ship to a browser
 * bundle. When they are present they decide the cuts and name the blocks; the
 * indentation heuristic answers only for the files and hunks they cannot cover,
 * so a parseable file is never cut by a pattern match again.
 *
 * Every block is emitted with a real, recomputed `@@` header covering its own
 * line range, so it is indistinguishable from a hunk to everything downstream:
 * ids stay `path::@@ ...`, line numbers stay correct, and a hunk that is not
 * split keeps its original header byte-for-byte - which is what preserves the
 * review state already saved against it.
 */
function cutHunk(hunk: PatchHunk, boundaries?: readonly DiffLogicBoundary[]): PatchHunk[] {
  const header = parseHunkHeader(hunk.range);
  if (!header) return [hunk];
  if (countSides(hunk.lines).changed <= MIN_CHANGED_LINES_TO_SPLIT) return [hunk];

  if (boundaries && boundaries.length > 0) {
    const { cuts, labels } = compilerCuts(hunk, header, boundaries);
    const blocks = assemble(hunk, header, cuts, (startIndex, lines) => {
      const label = sanitizeContext(labels.get(startIndex) ?? '');
      return label || blockContext(lines, header.context);
    });
    if (blocks.length > 1) return blocks;
  }

  return assemble(hunk, header, heuristicCuts(hunk), (_startIndex, lines) => blockContext(lines, header.context));
}

/** Give each emitted block the compiler's reading of the lines inside it.
 *
 * Attribution is by line span, not by which boundary opened the cut, for two
 * reasons: a block holds more than the primitive that starts it, and a hunk the
 * heuristic cut still deserves whatever the parser found inside those lines.
 *
 * Score is the max and not the sum — a block is as dangerous as the worst
 * thing in it, and summing would float one long block above two genuinely
 * separate risks. Hazards are unioned, because each is a different question. */
function attachAnalysis(blocks: PatchHunk[], boundaries: readonly DiffLogicBoundary[] | undefined): LogicBlock[] {
  if (!boundaries || boundaries.length === 0) return blocks.map((block) => ({ ...block, analysis: null }));
  return blocks.map((block) => {
    const header = parseHunkHeader(block.range);
    if (!header) return { ...block, analysis: null };
    const end = header.newStart + countSides(block.lines).newCount;
    const inside = boundaries.filter((boundary) => boundary.line >= header.newStart && boundary.line < end);
    if (inside.length === 0) return { ...block, analysis: null };
    const worst = inside.reduce((left, right) => (right.score > left.score ? right : left));
    const hazards = [...new Set(inside.flatMap((boundary) => boundary.hazards))].sort();
    return { ...block, analysis: { effect: worst.effect, score: worst.score, hazards } };
  });
}

/** Split one patch hunk into its logic blocks, each carrying what the compiler
 * read inside it. Cutting and reading are separate passes so that a block found
 * by the heuristic is analysed exactly like one found by the parser. */
export function splitHunkIntoLogicBlocks(hunk: PatchHunk, boundaries?: readonly DiffLogicBoundary[]): LogicBlock[] {
  return attachAnalysis(cutHunk(hunk, boundaries), boundaries);
}
