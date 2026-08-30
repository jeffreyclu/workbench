import { describe, expect, it } from 'vitest';
import { analyzeChangedFile, patchLogicBoundaries } from './review-logic-primitives.js';

const lines = (...numbers: number[]) => new Set(numbers);

describe('granularity', () => {
  /** One contiguous edit holding four independent decisions: a guard, a
   * branch, a persistence call and an awaited call in a loop. The regex
   * splitter produced one block for this. */
  const source = [
    'export async function handle(request, db) {',            // 1
    '  if (!request.token) return reject(request);',          // 2
    '  if (request.role === "admin") {',                      // 3
    '    request.scope = "all";',                             // 4
    '  }',                                                    // 5
    '  await db.query("update sessions set seen = 1");',      // 6
    '  for (const item of request.items) {',                  // 7
    '    await db.query("insert into audit values (?)");',    // 8
    '  }',                                                    // 9
    '  return request;',                                      // 10
    '}',                                                      // 11
  ].join('\n');

  it('cuts one hunk into the separate decisions inside it', () => {
    const analyzed = analyzeChangedFile('src/handler.ts', source, lines(2, 3, 4, 6, 7, 8, 10));
    expect(analyzed.primitives.length).toBeGreaterThanOrEqual(4);
    expect(analyzed.primitives.map((primitive) => primitive.effect)).toEqual(
      expect.arrayContaining(['guard', 'branch', 'persistence', 'loop']),
    );
  });

  it('names each primitive by its own syntax, not the enclosing function', () => {
    const analyzed = analyzeChangedFile('src/handler.ts', source, lines(2, 3));
    expect(analyzed.primitives.map((primitive) => primitive.label)).toContain('if (!request.token)');
  });

  it('reads sequential I/O off the loop rather than off the text', () => {
    const analyzed = analyzeChangedFile('src/handler.ts', source, lines(7, 8));
    const loop = analyzed.primitives.find((primitive) => primitive.effect === 'loop');
    expect(loop?.hazards).toContain('await_in_loop');
  });
});

describe('what the human is actually owed', () => {
  it('scores a declaration-only change at zero', () => {
    const declarations = [
      'import { readFile } from "node:fs";',
      'export interface ReviewRequest { token: string; scope: string }',
      'export type ReviewScope = "all" | "own";',
    ].join('\n');
    const analyzed = analyzeChangedFile('src/contracts.ts', declarations, lines(1, 2, 3));
    expect(analyzed.declarativeOnly).toBe(true);
    expect(analyzed.score).toBe(0);
  });

  it('ranks a persistence call above an exported interface', () => {
    const logic = analyzeChangedFile('src/repo.ts', 'await db.query("delete from sessions");', lines(1));
    const declaration = analyzeChangedFile('src/contracts.ts', 'export interface Session { id: string }', lines(1));
    expect(logic.score).toBeGreaterThan(declaration.score);
  });

  it('sees a caught failure that is never reported', () => {
    const swallowed = ['try {', '  send(payload);', '} catch (error) {', '}'].join('\n');
    const analyzed = analyzeChangedFile('src/send.ts', swallowed, lines(1, 2, 3, 4));
    expect(analyzed.primitives.flatMap((primitive) => primitive.hazards)).toContain('error_swallowed');
  });

  it('reports a guard that the patch removed, which one side cannot see', () => {
    const before = ['function authorize(request) {', '  if (!request.token) return false;', '  return verify(request.token);', '}'].join('\n');
    const after = ['function authorize(request) {', '  return verify(request.token);', '}'].join('\n');
    const analyzed = analyzeChangedFile('src/auth.ts', after, lines(2), before);
    expect(analyzed.primitives.flatMap((primitive) => primitive.hazards)).toContain('guard_removed');
  });

  it('does not read a brace in a string as structure', () => {
    const analyzed = analyzeChangedFile('src/log.ts', 'const message = "if (x) { return }";', lines(1));
    expect(analyzed.primitives.every((primitive) => primitive.effect === 'literal')).toBe(true);
  });
});

describe('patch boundaries', () => {
  /** All fourteen added lines sit inside a function body, so every one of them
   * is deeper than the hunk's base indentation. That is the shape the
   * indentation heuristic cannot cut: it looks for a construct opening at base
   * indent and never finds one. */
  const body = [
    '@@ -10,4 +10,18 @@ export function handle(request: Request) {',
    ' export function handle(request: Request) {',
    '   const user = request.user;',
    '+  if (!user) {',
    '+    throw new Error("no user");',
    '+  }',
    '+  const rows = [];',
    '+  for (const id of request.ids) {',
    '+    rows.push(await load(id));',
    '+  }',
    '+  await db.write(rows);',
    '+  logger.info("wrote", rows.length);',
    '+  cache.delete(user.id);',
    '+  metrics.count("handled");',
    '+  const summary = rows.length;',
    '+  return summary;',
    '   return null;',
    ' }',
  ];
  const patch = ['diff --git a/src/handle.ts b/src/handle.ts', 'index 111..222 100644', '--- a/src/handle.ts', '+++ b/src/handle.ts', ...body].join('\n');

  it('reports primitive starts at their real line in the file the patch leaves', () => {
    const boundaries = patchLogicBoundaries('src/handle.ts', patch);
    // The guard is the third added line; the hunk starts the after side at 10
    // and two context lines precede it, so it lands on line 12.
    expect(boundaries.find((boundary) => boundary.line === 12)).toMatchObject({ effect: 'guard', label: 'if (!user)' });
    expect(boundaries.find((boundary) => boundary.line === 16)).toMatchObject({ effect: 'loop' });
    expect(boundaries.find((boundary) => boundary.line === 19)).toMatchObject({ effect: 'persistence' });
  });

  it('prices the boundary, so the queue has something better than a pattern match to rank on', () => {
    const boundaries = patchLogicBoundaries('src/handle.ts', patch);
    const write = boundaries.find((boundary) => boundary.line === 19);
    const declaration = boundaries.find((boundary) => boundary.line === 23);
    expect(write && declaration && write.score > declaration.score).toBe(true);
  });

  it('attributes a deletion to the line that now sits in its place', () => {
    const deletion = [
      'diff --git a/src/guard.ts b/src/guard.ts',
      '@@ -4,4 +4,3 @@',
      ' function save(user) {',
      '-  if (!user.id) throw new Error("no id");',
      '   return db.put(user);',
      ' }',
    ].join('\n');
    const boundaries = patchLogicBoundaries('src/guard.ts', deletion);
    // Line 5 is `return db.put(user)` after the removal - the statement a
    // reviewer reads to see what the removed guard was protecting.
    expect(boundaries.some((boundary) => boundary.line === 5)).toBe(true);
  });

  it('declines to answer for a file the parser does not speak', () => {
    const markdown = ['diff --git a/README.md b/README.md', '@@ -1,1 +1,2 @@', ' # Title', '+Added a line.'].join('\n');
    expect(patchLogicBoundaries('README.md', markdown)).toEqual([]);
  });

  it('returns no boundaries rather than throwing on a patch it cannot rebuild', () => {
    expect(patchLogicBoundaries('src/handle.ts', 'not a patch at all')).toEqual([]);
  });
});
