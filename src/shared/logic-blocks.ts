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
export interface PatchHunk { range: string; lines: string[] }

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
function blockContext(lines: string[], fallback: string): string {
  for (const line of lines) {
    const code = lineCode(line).trim();
    if (!code || !CONSTRUCT_START.test(code)) continue;
    const cleaned = code.replace(/@@/g, '@').replace(/[\r\n]+/g, ' ').slice(0, 120).trim();
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

/**
 * Split one patch hunk into the logic blocks inside it.
 *
 * Every block is emitted with a real, recomputed `@@` header covering its own
 * line range, so it is indistinguishable from a hunk to everything downstream:
 * ids stay `path::@@ …`, line numbers stay correct, and a hunk that is not
 * split keeps its original header byte-for-byte — which is what preserves the
 * review state already saved against it.
 */
export function splitHunkIntoLogicBlocks(hunk: PatchHunk): PatchHunk[] {
  const header = parseHunkHeader(hunk.range);
  if (!header) return [hunk];
  if (countSides(hunk.lines).changed <= MIN_CHANGED_LINES_TO_SPLIT) return [hunk];

  const codes = hunk.lines.map(lineCode);
  const indents = codes.map(indentOf);
  const finiteIndents = indents.filter((indent) => Number.isFinite(indent));
  if (finiteIndents.length === 0) return [hunk];
  const baseIndent = Math.min(...finiteIndents);

  const boundaries: number[] = [];
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
      boundaries.push(index);
      changedInBlock = 0;
      sawContent = false;
    }
    if (kind !== 'deletion') newDepth += bracketDelta(code);
    if (kind !== 'addition') oldDepth += bracketDelta(code);
    if (kind !== 'context') changedInBlock += 1;
    if (code.trim()) sawContent = true;
  });
  if (boundaries.length === 0) return [hunk];

  const segments: string[][] = [];
  let start = 0;
  for (const boundary of [...boundaries, hunk.lines.length]) {
    segments.push(hunk.lines.slice(start, boundary));
    start = boundary;
  }
  // A segment with nothing changed in it is trailing context, not a decision:
  // it is folded back into the block whose change it explains.
  const merged: string[][] = [];
  for (const segment of segments) {
    if (merged.length > 0 && countSides(segment).changed === 0) merged[merged.length - 1].push(...segment);
    else merged.push(segment);
  }
  if (merged.length < 2) return [hunk];

  let oldLine = header.oldStart;
  let newLine = header.newStart;
  return merged.map((lines, index) => {
    const { oldCount, newCount } = countSides(lines);
    const context = index === 0 ? header.context : blockContext(lines, header.context);
    const range = `@@ -${oldLine},${oldCount} +${newLine},${newCount} @@${context ? ` ${context}` : ''}`;
    oldLine += oldCount;
    newLine += newCount;
    return { range, lines };
  });
}
