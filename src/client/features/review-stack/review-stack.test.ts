import { describe, expect, it } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildChangeMap } from '../../../shared/change-map.js';
import { buildReviewDecisions, splitPatchHunks } from '../../../shared/review-decisions.js';
import { blockContentHash, indexReviewBlocks, splitPatchBlocks, toBlockLevelFiles } from './review-blocks.js';
import { blockObligations } from './review-obligations.js';
import { isFormattingOnlyChange, isImportOnlyChange, routeReviewBlock } from './review-routing.js';
import { buildReviewQueue, nextUnsettledBlockId, reviewQueueProgress } from './review-queue.js';
import { assistEscalationReason } from './review-escalation.js';

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
