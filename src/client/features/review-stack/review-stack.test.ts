import { describe, expect, it } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildChangeMap } from '../../../shared/change-map.js';
import { buildReviewDecisions, splitPatchHunks } from '../../../shared/review-decisions.js';
import { blockContentHash, indexReviewBlocks, splitPatchBlocks, toBlockLevelFiles } from './review-blocks.js';
import { splitHunkIntoLogicBlocks } from './logic-blocks.js';
import { blockObligations } from './review-obligations.js';
import { isFormattingOnlyChange, isImportOnlyChange, routeReviewBlock } from './review-routing.js';
import { buildReviewQueue, nextUnsettledBlockId, reviewQueueProgress } from './review-queue.js';
import { assistEscalationReason } from './review-escalation.js';
import { buildReviewPlaceMap, type ReviewPlaceMap } from './review-places.js';
import { placeMapAsChangeMap, placeRiskBand } from './review-map-overlays.js';
import { highlightReviewPlace, highlightReviewRelationship, selectReviewBlock } from './review-selection.js';

function file(path: string, patch: string): WorkspaceDiffFile {
  return { path, status: 'modified', additions: 0, deletions: 0, previousPath: null, patch, isBinary: false, editorUrl: null };
}

/** One hunk holding three independent thoughts: a new helper, the branch that
 * calls it, and the error path added on the way. */
const MULTI_CONSTRUCT_PATCH = [
  '@@ -10,2 +10,19 @@ export const version = 1;',
  ' export const version = 1;',
  '+',
  '+function parseBody(request) {',
  '+  const raw = request.body;',
  '+  if (!raw) return { ok: false, error: "empty" };',
  '+  return { ok: true, value: JSON.parse(raw) };',
  '+}',
  '+',
  '+function reject(error) {',
  '+  logger.warn("rejected", error);',
  '+  return { status: 400, error };',
  '+}',
  '+',
  '+function respond(value) {',
  '+  return { status: 200, value };',
  '+}',
  ' export const done = true;',
].join('\n');

const SMALL_PATCH = [
  '@@ -4,3 +4,4 @@ const limit = 5;',
  ' const limit = 5;',
  '-const retries = 1;',
  '+const retries = 3;',
  ' export { limit };',
].join('\n');

describe('review block splitting', () => {
  it('cuts a multi-construct hunk into separate blocks', () => {
    const subject = file('src/handler.ts', MULTI_CONSTRUCT_PATCH);
    expect(splitPatchHunks(subject)).toHaveLength(1);
    expect(splitPatchBlocks(subject).length).toBeGreaterThan(1);
  });

  it('leaves a hunk that is already one thought alone', () => {
    const subject = file('src/config.ts', SMALL_PATCH);
    expect(splitPatchBlocks(subject)).toHaveLength(1);
    expect(toBlockLevelFiles([subject])[0].patch).toBe(SMALL_PATCH);
  });

  it('passes a patch it cannot re-emit through untouched', () => {
    const binary = { ...file('assets/logo.png', null as unknown as string), isBinary: true, patch: null };
    expect(toBlockLevelFiles([binary])[0]).toBe(binary);
  });

  it('re-emits blocks as real hunks the shared splitter can read back', () => {
    const [blockLevel] = toBlockLevelFiles([file('src/handler.ts', MULTI_CONSTRUCT_PATCH)]);
    const readBack = splitPatchHunks(blockLevel);
    expect(readBack.map((hunk) => hunk.range)).toEqual(splitPatchBlocks(file('src/handler.ts', MULTI_CONSTRUCT_PATCH)).map((hunk) => hunk.range));
    expect(readBack.every((hunk) => hunk.range.startsWith('@@'))).toBe(true);
  });

  it('changes a block identity when its lines change', () => {
    const before = indexReviewBlocks([file('src/config.ts', SMALL_PATCH)]);
    const after = indexReviewBlocks([file('src/config.ts', SMALL_PATCH.replace('retries = 3', 'retries = 9'))]);
    const [beforeIdentity] = [...before.values()];
    const [afterIdentity] = [...after.values()];
    expect(afterIdentity.range).toBe(beforeIdentity.range);
    expect(afterIdentity.contentHash).not.toBe(beforeIdentity.contentHash);
    expect(blockContentHash(['a'])).not.toBe(blockContentHash(['b']));
  });
});

/** The contract that governs merges: shared derivation is hunk-level whether or
 * not the review stack exists, so Changes keeps the ids its rows are keyed on. */
describe('isolation from the Changes view', () => {
  it('keeps shared decisions at hunk granularity', () => {
    const decisions = buildReviewDecisions([file('src/handler.ts', MULTI_CONSTRUCT_PATCH)], []);
    expect(decisions.flatMap((decision) => decision.hunks)).toHaveLength(1);
    expect(decisions[0].hunks[0].id).toBe('src/handler.ts::@@ -10,2 +10,19 @@ export const version = 1;');
  });

  it('produces block-level decisions only from block-level files', () => {
    const original = file('src/handler.ts', MULTI_CONSTRUCT_PATCH);
    const blockDecisions = buildReviewDecisions(toBlockLevelFiles([original]), []);
    expect(blockDecisions.flatMap((decision) => decision.hunks).length).toBeGreaterThan(1);
  });
});

describe('routing', () => {
  const decisionFor = (subject: WorkspaceDiffFile) => buildReviewDecisions([subject], [])[0];

  it('settles an import-only change without a model turn', () => {
    const decision = decisionFor(file('src/app.ts', [
      '@@ -1,2 +1,3 @@',
      ' import { a } from "./a.js";',
      '+import { b } from "./b.js";',
      ' export const x = 1;',
    ].join('\n')));
    expect(isImportOnlyChange(decision)).toBe(true);
    expect(routeReviewBlock(decision, blockObligations(decision)).tier).toBe('T0');
  });

  it('settles a whitespace-only change', () => {
    const decision = decisionFor(file('src/app.ts', [
      '@@ -1,3 +1,3 @@',
      ' const value = 1;',
      '-  return   value;',
      '+return value;',
      ' }',
    ].join('\n')));
    expect(isFormattingOnlyChange(decision)).toBe(true);
    expect(routeReviewBlock(decision, blockObligations(decision)).autoSettled).toBe(true);
  });

  it('routes a change that is costly to get wrong to the top tier', () => {
    const decision = decisionFor(file('src/server/auth.ts', [
      '@@ -20,4 +20,6 @@ export function authorize(request) {',
      ' export function authorize(request) {',
      '-  if (!request.token) return false;',
      '+  if (!request.token) return request.internal === true;',
      '+  if (request.token === "*") return true;',
      '   return verify(request.token);',
      ' }',
    ].join('\n')));
    expect(decision.riskSignals).toContain('auth');
    expect(routeReviewBlock(decision, blockObligations(decision)).tier).toBe('T3');
  });

  it('never auto-settles generated output into invisibility', () => {
    const decision = decisionFor(file('package-lock.json', '@@ -1,2 +1,2 @@\n-  "version": "1.0.0",\n+  "version": "1.0.1",'));
    const routing = routeReviewBlock(decision, blockObligations(decision));
    expect(routing.tier).toBe('T0');
    expect(routing.reason).toMatch(/Generated/);
  });
});

describe('the queue', () => {
  const files = [
    file('src/server/auth.ts', [
      '@@ -20,4 +20,6 @@ export function authorize(request) {',
      ' export function authorize(request) {',
      '-  if (!request.token) return false;',
      '+  if (!request.token) return request.internal === true;',
      '+  if (request.token === "*") return true;',
      '   return verify(request.token);',
      ' }',
    ].join('\n')),
    file('src/render.ts', [
      '@@ -8,3 +8,3 @@ export function render(items) {',
      ' export function render(items) {',
      '-  return items.map(row).join("");',
      '+  return items.filter(Boolean).map(row).join("\\n");',
      ' }',
    ].join('\n')),
    file('src/app.ts', [
      '@@ -1,2 +1,3 @@',
      ' import { a } from "./a.js";',
      '+import { c } from "./c.js";',
      ' export const x = 1;',
    ].join('\n')),
  ];

  function queueFor(reviews: Parameters<typeof buildReviewDecisions>[1] = []) {
    const blockFiles = toBlockLevelFiles(files);
    const decisions = buildReviewDecisions(blockFiles, reviews);
    return buildReviewQueue(decisions, buildChangeMap(decisions), indexReviewBlocks(files));
  }

  it('puts what deserves attention above what was settled by proof', () => {
    const queue = queueFor();
    expect(queue[0].routing.tier).toBe('T3');
    expect(queue[queue.length - 1].routing.autoSettled).toBe(true);
  });

  it('carries a block identity per hunk so a verdict can be recorded', () => {
    const queue = queueFor();
    expect(queue[0].identities).toHaveLength(queue[0].decision.hunks.length);
    expect(queue[0].identities[0].storageKey).toContain('::');
  });

  it('reports what is actually left for a reviewer', () => {
    const progress = reviewQueueProgress(queueFor());
    expect(progress.settled).toBeGreaterThan(0);
    expect(progress.remaining).toBe(progress.total - progress.settled - progress.judged);
  });

  it('advances to the next block still owed an answer, skipping settled ones', () => {
    const queue = queueFor();
    const settled = queue.filter((entry) => entry.routing.autoSettled).map((entry) => entry.decision.id);
    const unsettled = queue.filter((entry) => !entry.routing.autoSettled);
    expect(unsettled.length).toBeGreaterThan(1);
    const next = nextUnsettledBlockId(queue, unsettled[0].decision.id);
    expect(settled).not.toContain(next);
    expect(next).toBe(unsettled[1].decision.id);
  });
});

describe('escalation from a delegated answer', () => {
  const files = [file('src/sync.ts', SMALL_PATCH)];

  function queueFor(assistAnswers?: Map<string, readonly (string | null)[]>) {
    const blockFiles = toBlockLevelFiles(files);
    const decisions = buildReviewDecisions(blockFiles, []);
    return buildReviewQueue(decisions, buildChangeMap(decisions), indexReviewBlocks(files), assistAnswers);
  }

  it('reads low confidence and the evidence the model lacked out of an answer', () => {
    expect(assistEscalationReason('It changes a retry count.\n\nCONFIDENCE: low\nMISSING: the caller that sets the timeout'))
      .toBe('Delegated answer was not confident: the caller that sets the timeout');
    expect(assistEscalationReason('It changes a retry count.\n\nCONFIDENCE: high')).toBeNull();
    // Every Changes answer, and every answer cached before tiering existed,
    // arrives without a marker. Reading that as doubt would send the whole
    // queue to study.
    expect(assistEscalationReason('It changes a retry count.')).toBeNull();
    expect(assistEscalationReason(null)).toBeNull();
  });

  it('sends a block the model could not settle straight to study, without moving the tier it is asked at', () => {
    const before = queueFor()[0];
    expect(before.routing.tier).not.toBe('T3');
    expect(before.routing.autoSettled).toBe(false);

    const escalated = queueFor(new Map([[before.decision.id, ['CONFIDENCE: low\nMISSING: the retry budget it feeds']]]))[0];

    expect(escalated.routing.tier).toBe('T3');
    expect(escalated.routing.reason).toContain('the retry budget it feeds');
    // Still asked at the tier that produced the answer: looking it up at T3
    // would miss the answer that caused the escalation and drop the block back
    // on the next render.
    expect(escalated.assistTier).toBe(before.routing.tier);
  });

  it('leaves a confident answer ranked where routing put it', () => {
    const before = queueFor()[0];
    const unchanged = queueFor(new Map([[before.decision.id, ['CONFIDENCE: high']]]))[0];

    expect(unchanged.routing.tier).toBe(before.routing.tier);
    expect(unchanged.routing.reason).toBe(before.routing.reason);
  });
});

/** A producer, a consumer that imports it, and an import of a module the patch
 * never touches — the smallest diff that has surroundings at all. */
const PRODUCER_PATCH = [
  '@@ -1,2 +1,7 @@',
  " import { helper } from './unchanged.js';",
  ' ',
  '+export function parseBody(raw) {',
  '+  if (!raw) return null;',
  '+  return helper(raw);',
  '+}',
  '+',
].join('\n');

const CONSUMER_PATCH = [
  '@@ -1,2 +1,7 @@',
  " import { parseBody } from './a.js';",
  ' ',
  '+export function handle(request) {',
  '+  const body = parseBody(request.body);',
  '+  return { ok: body !== null, body };',
  '+}',
  '+',
].join('\n');

function placeFixture() {
  const files = [file('src/a.ts', PRODUCER_PATCH), file('src/b.ts', CONSUMER_PATCH)];
  const blockFiles = toBlockLevelFiles(files);
  const blocks = indexReviewBlocks(files);
  const decisions = buildReviewDecisions(blockFiles, []);
  const map = buildChangeMap(decisions);
  const queue = buildReviewQueue(decisions, map, blocks);
  return { files, map, queue, decisions };
}

describe('review place map', () => {
  it('places the open block and draws the modules it imports but does not change', () => {
    const { files, map, queue } = placeFixture();
    const focus = queue.find((entry) => entry.decision.filePaths.includes('src/a.ts'));
    expect(focus).toBeDefined();

    const placeMap = buildReviewPlaceMap(map, queue, files, focus!.decision.id);

    expect(placeMap.focusPlaceId).toBe('src/a');
    const own = placeMap.places.find((place) => place.id === 'src/a');
    expect(own?.changed).toBe(true);
    expect(own?.blockIds).toContain(focus!.decision.id);

    // The module was never in the diff, so nothing in the change graph could
    // have produced it: it exists because the patch's own import line says so.
    const surrounding = placeMap.places.find((place) => place.id === 'src/unchanged');
    expect(surrounding?.changed).toBe(false);
    expect(surrounding?.blockIds).toEqual([]);
    expect(placeMap.links.some((link) => link.fromId === 'src/a' && link.toId === 'src/unchanged')).toBe(true);
  });

  it('is empty for a block that is not in the queue', () => {
    const { files, map, queue } = placeFixture();
    expect(buildReviewPlaceMap(map, queue, files, 'src/nowhere.ts::@@ -1 +1 @@').places).toEqual([]);
  });

  it('never draws a place twice for the same module', () => {
    const { files, map, queue } = placeFixture();
    const focus = queue[0];
    const placeMap = buildReviewPlaceMap(map, queue, files, focus.decision.id);
    expect(new Set(placeMap.places.map((place) => place.id)).size).toBe(placeMap.places.length);
  });
});

describe('review map overlays', () => {
  const placeMap: ReviewPlaceMap = {
    focusPlaceId: 'src/a',
    omitted: 0,
    links: [],
    places: [
      {
        id: 'src/a', path: 'src/a.ts', label: 'a.ts', changed: true, blockIds: ['src/a.ts::1'],
        additions: 4, deletions: 0, symbols: [{ name: 'parseBody', kind: 'value', change: 'added' }],
        riskSignals: ['auth'], tier: 'T3', state: 'reviewed', answers: 2,
      },
      {
        id: 'src/unchanged', path: 'src/unchanged.ts', label: 'unchanged.ts', changed: false, blockIds: [],
        additions: 0, deletions: 0, symbols: [], riskSignals: [], tier: null, state: null, answers: 0,
      },
    ],
  };

  it('reads risk, priority, verdict and spend off the same drawing', () => {
    const on = placeMapAsChangeMap(placeMap, { risk: true, priority: true, state: true, spend: true });
    expect(on.riskBands.get('src/a')).toBe('high');
    expect(on.map.nodes[0].label).toBe('T3 · a.ts');
    expect(on.map.nodes[0].state).toBe('reviewed');
    expect(on.map.nodes[0].symbols[0].name).toBe('2 answers');
  });

  it('drops every reading when the overlays are off, and keeps the places', () => {
    const off = placeMapAsChangeMap(placeMap, { risk: false, priority: false, state: false, spend: false });
    expect(off.riskBands.size).toBe(0);
    expect(off.map.nodes[0].label).toBe('a.ts');
    expect(off.map.nodes[0].state).toBeNull();
    expect(off.map.nodes[0].symbols.map((symbol) => symbol.name)).toEqual(['parseBody']);
    expect(off.map.nodes.map((node) => node.id)).toEqual(['src/a', 'src/unchanged']);
  });

  it('bands a place with only weaker signals below one that touches auth or data', () => {
    expect(placeRiskBand(['auth'])).toBe('high');
    expect(placeRiskBand(['persistence'])).toBe('high');
    expect(placeRiskBand(['cross_file'])).toBe('medium');
    expect(placeRiskBand([])).toBeNull();
  });
});

describe('review selection', () => {
  it('lets the map highlight without ever moving the block', () => {
    const selection = selectReviewBlock('src/a.ts::1');
    const place = highlightReviewPlace(selection, 'src/unchanged');
    expect(place).toEqual({ blockId: 'src/a.ts::1', nodeId: 'src/unchanged', relationshipId: null });

    const edge = highlightReviewRelationship(place, 'src/a->src/unchanged:imports:added');
    expect(edge.blockId).toBe('src/a.ts::1');
    expect(edge.relationshipId).toBe('src/a->src/unchanged:imports:added');

    // Clicking the highlighted place again clears the highlight rather than
    // re-selecting, so the drawing returns to following the queue.
    expect(highlightReviewPlace(edge, 'src/unchanged').nodeId).toBeNull();
  });

  it('drops map-local highlights when the queue moves to another block', () => {
    const moved = selectReviewBlock('src/b.ts::1');
    expect(moved).toEqual({ blockId: 'src/b.ts::1', nodeId: null, relationshipId: null });
  });
});

describe('compiler-driven block boundaries', () => {
  const lines = [
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
  const hunk = { range: '@@ -10,4 +10,18 @@ export function handle(request: Request) {', lines };
  // The shape `patchLogicBoundaries` produces for this patch, kept as data so
  // the splitter is tested without dragging the TypeScript compiler into a
  // browser-bundle module.
  const boundaries = [
    { line: 12, label: 'if (!user)', effect: 'guard', score: 9, hazards: [] },
    { line: 15, label: 'const rows = [];', effect: 'literal', score: 0, hazards: [] },
    { line: 16, label: 'for (... of request.ids)', effect: 'loop', score: 12, hazards: [] },
    { line: 19, label: 'await db.write(rows);', effect: 'persistence', score: 10, hazards: [] },
    { line: 22, label: 'metrics.count("handled");', effect: 'external_call', score: 4, hazards: [] },
  ];

  it('cuts a hunk the indentation heuristic leaves whole', () => {
    expect(splitHunkIntoLogicBlocks(hunk)).toHaveLength(1);
    expect(splitHunkIntoLogicBlocks(hunk, boundaries).length).toBeGreaterThan(1);
  });

  it('names each block from the syntax rather than the first line matching a pattern', () => {
    const contexts = splitHunkIntoLogicBlocks(hunk, boundaries).slice(1).map((block) => block.range.split('@@')[2].trim());
    expect(contexts).toContain('await db.write(rows);');
  });

  it('loses no line and keeps the header arithmetic exact', () => {
    const blocks = splitHunkIntoLogicBlocks(hunk, boundaries);
    expect(blocks.flatMap((block) => block.lines)).toEqual(lines);
    let oldLine = 10;
    let newLine = 10;
    for (const block of blocks) {
      const header = block.range.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      expect(header).not.toBeNull();
      expect(Number(header![1])).toBe(oldLine);
      expect(Number(header![3])).toBe(newLine);
      oldLine += Number(header![2]);
      newLine += Number(header![4]);
    }
    expect(newLine - 10).toBe(lines.filter((line) => !line.startsWith('-')).length);
  });

  it('falls back to the heuristic when the parser had nothing to say about the file', () => {
    expect(splitHunkIntoLogicBlocks(hunk, [])).toEqual(splitHunkIntoLogicBlocks(hunk));
  });

  it('leaves a hunk too small to be worth splitting alone, however it was analyzed', () => {
    const small = { range: '@@ -1,1 +1,3 @@', lines: [' const a = 1;', '+const b = 2;', '+const c = 3;'] };
    expect(splitHunkIntoLogicBlocks(small, [{ line: 2, label: 'const b = 2;', effect: 'literal', score: 0, hazards: [] }])).toEqual([small]);
  });
});
