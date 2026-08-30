import type { DiffHunkReviewState, WorkspaceDiffFile } from '../../../shared/contracts.js';
import {
  resolveModulePath,
  type ChangeDirection,
  type ChangeMap,
  type ChangeMapSymbol,
  type ChangeRelation,
} from '../../../shared/change-map.js';
import type { ReviewRiskSignal } from '../../../shared/review-decisions.js';
import type { ReviewQueueEntry } from './review-queue.js';
import { tierRank, type ReviewTier } from './review-routing.js';

/**
 * The map Review draws, in Review's own vocabulary.
 *
 * The change map is a graph of *changes*: every node is something the patch
 * did, so the picture disappears the moment a change has no changed neighbour.
 * That is the right graph for Changes, which is a diff walker. It is the wrong
 * graph for judging one block, because the question a reviewer actually asks is
 * "where does this sit" — and the answer includes modules the patch never
 * touched.
 *
 * So a node here is a *place*: a module that exists whether or not it changed.
 * Changed places carry the blocks inside them; unchanged ones are drawn as
 * surroundings, and the change reads as an overlay on top of a system that was
 * already there.
 *
 * All of this is Review-owned. Nothing in `src/shared/` learns about places,
 * and no file Changes renders is edited, so Changes keeps producing identical
 * decisions, hunk ids, rows and cache hits.
 */

/** Enough neighbourhood to place the block, few enough to stay a drawing.
 * Anything past this is reported rather than dropped silently. */
const MAX_SURROUNDINGS = 8;

const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

/** `resolveModulePath` answers with an extensionless path because the
 * repository writes `.js` specifiers for TypeScript sources. Place ids are
 * extensionless for the same reason: `x.ts` and the `./x.js` that imports it
 * have to land on one place or the map draws a module twice. */
export function placeIdFor(filePath: string): string {
  return filePath.replace(MODULE_EXTENSION, '');
}

export interface ReviewPlace {
  /** Extensionless module path. Stable across the patch, because it names a
   * location in the system rather than an edit. */
  id: string;
  /** The file as the diff spells it for a changed place, and the resolved
   * module path for an unchanged one, which has no diff entry to quote. */
  path: string;
  label: string;
  /** Whether the patch touched this place at all. */
  changed: boolean;
  /** Blocks that live here, in queue order. Empty for a surrounding. */
  blockIds: string[];
  additions: number;
  deletions: number;
  symbols: ChangeMapSymbol[];
  riskSignals: ReviewRiskSignal[];
  /** The most expensive tier any block here was routed to, which is what the
   * priority overlay reads. Null for a surrounding. */
  tier: ReviewTier | null;
  /** A verdict only when every block here has one and they agree: a place
   * holding one accepted and one unanswered block is not reviewed, and
   * painting it as reviewed would retire a block nobody answered. */
  state: DiffHunkReviewState | null;
  /** Delegated answers already paid for on this place's blocks. Answers, not
   * tokens: no token telemetry reaches this surface, and inventing one would
   * be a made-up number on a spend overlay. */
  answers: number;
}

export interface ReviewPlaceLink {
  id: string;
  fromId: string;
  toId: string;
  relation: ChangeRelation;
  change: ChangeDirection;
  prior: ChangeRelation | null;
  symbols: string[];
  explanation: string;
}

export interface ReviewPlaceMap {
  places: ReviewPlace[];
  links: ReviewPlaceLink[];
  /** Where the open block lives, so the drawing can be centred on it without
   * the map deciding what is selected. */
  focusPlaceId: string | null;
  /** Surroundings found and not drawn because of `MAX_SURROUNDINGS`. */
  omitted: number;
}

export const EMPTY_REVIEW_PLACE_MAP: ReviewPlaceMap = { places: [], links: [], focusPlaceId: null, omitted: 0 };

interface MutablePlace extends Omit<ReviewPlace, 'state'> {
  states: Set<DiffHunkReviewState | null>;
}

/** Import specifiers as they appear anywhere in a patch — added, removed or
 * context. Context lines are the point: an unchanged import is exactly the
 * evidence that an unchanged module is part of this neighbourhood. */
function importSpecifiers(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const found: string[] = [];
  for (const raw of patch.split('\n')) {
    const line = raw.slice(1).trim();
    const match = /^(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/.exec(line) ?? /^import\s+['"]([^'"]+)['"]/.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

function highestTier(left: ReviewTier | null, right: ReviewTier): ReviewTier {
  return left && tierRank(left) >= tierRank(right) ? left : right;
}

/**
 * The neighbourhood around one block, as places.
 *
 * Scope is the block plus what the change map says it reaches, then the
 * modules those files import. A module that changed but sits outside this
 * neighbourhood is deliberately left out rather than drawn as a surrounding:
 * it is neither, and drawing it would pull the rest of the diff into a picture
 * meant to answer a question about one block.
 */
export function buildReviewPlaceMap(
  map: ChangeMap,
  entries: ReviewQueueEntry[],
  files: Pick<WorkspaceDiffFile, 'path' | 'patch'>[],
  focusBlockId: string,
  assistAnswers: ReadonlyMap<string, readonly (string | null | undefined)[]> = new Map(),
): ReviewPlaceMap {
  const focus = entries.find((entry) => entry.decision.id === focusBlockId);
  if (!focus) return EMPTY_REVIEW_PLACE_MAP;

  const neighbourhood = new Set<string>([
    focusBlockId,
    ...focus.relationships.callers.map((node) => node.id),
    ...focus.relationships.effects.map((node) => node.id),
  ]);
  const inScope = entries.filter((entry) => neighbourhood.has(entry.decision.id));
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));

  const places = new Map<string, MutablePlace>();
  const ensure = (filePath: string, changed: boolean): MutablePlace => {
    const id = placeIdFor(filePath);
    const existing = places.get(id);
    if (existing) {
      // A place first seen as a surrounding and later found in the diff is a
      // changed place: the stronger fact wins.
      if (changed && !existing.changed) { existing.changed = true; existing.path = filePath; }
      return existing;
    }
    const place: MutablePlace = {
      id, path: filePath, label: filePath.split('/').pop() ?? filePath, changed,
      blockIds: [], additions: 0, deletions: 0, symbols: [], riskSignals: [],
      tier: null, states: new Set(), answers: 0,
    };
    places.set(id, place);
    return place;
  };

  for (const entry of inScope) {
    const answers = (assistAnswers.get(entry.decision.id) ?? []).filter(Boolean).length;
    for (const hunk of entry.decision.hunks) {
      const place = ensure(hunk.filePath, true);
      if (!place.blockIds.includes(entry.decision.id)) {
        place.blockIds.push(entry.decision.id);
        place.tier = highestTier(place.tier, entry.routing.tier);
        place.answers += answers;
        place.states.add(entry.decision.state);
        for (const signal of entry.decision.riskSignals) {
          if (!place.riskSignals.includes(signal)) place.riskSignals.push(signal);
        }
      }
      place.additions += hunk.additions;
      place.deletions += hunk.deletions;
    }
    // Symbols are declared by the decision as a whole, so they are attributed
    // to the file it is primarily about rather than smeared over every file it
    // happens to touch.
    const node = nodes.get(entry.decision.id);
    if (node) {
      const primary = ensure(node.filePath, true);
      for (const symbol of node.symbols) {
        if (!primary.symbols.some((existing) => existing.name === symbol.name)) primary.symbols.push(symbol);
      }
    }
  }

  const links = new Map<string, ReviewPlaceLink>();
  const link = (link: ReviewPlaceLink) => { if (!links.has(link.id)) links.set(link.id, link); };
  const placeOfDecision = (decisionId: string): string | null => {
    const node = nodes.get(decisionId);
    return node ? placeIdFor(node.filePath) : null;
  };

  for (const edge of map.edges) {
    if (!neighbourhood.has(edge.fromId) || !neighbourhood.has(edge.toId)) continue;
    const fromId = placeOfDecision(edge.fromId);
    const toId = placeOfDecision(edge.toId);
    // Two blocks in one file are one place; an arrow from a box to itself says
    // nothing the box does not already say.
    if (!fromId || !toId || fromId === toId) continue;
    link({
      id: `${fromId}->${toId}:${edge.relation}:${edge.change}`,
      fromId, toId, relation: edge.relation, change: edge.change, prior: edge.prior,
      symbols: edge.symbols, explanation: edge.explanation,
    });
  }

  // Surroundings, last, so a module that also changed has already claimed its
  // place and is never mislabelled as untouched.
  const changedPaths = new Set(files.map((file) => placeIdFor(file.path)));
  let omitted = 0;
  for (const place of [...places.values()].filter((candidate) => candidate.changed)) {
    const patch = files.find((file) => file.path === place.path)?.patch;
    for (const specifier of importSpecifiers(patch)) {
      const target = resolveModulePath(place.path, specifier);
      // A bare package specifier resolves to null: nothing in this repository
      // to place it against.
      if (!target || target === place.id) continue;
      if (places.has(target)) {
        link({
          id: `${place.id}->${target}:imports:added`,
          fromId: place.id, toId: target, relation: 'imports', change: 'added',
          prior: null, symbols: [], explanation: `${place.label} imports ${places.get(target)!.label}.`,
        });
        continue;
      }
      if (changedPaths.has(target)) continue;
      if (places.size >= MAX_SURROUNDINGS + inScope.length) { omitted += 1; continue; }
      const surrounding = ensure(target, false);
      link({
        id: `${place.id}->${target}:imports:added`,
        fromId: place.id, toId: target, relation: 'imports', change: 'added',
        prior: null, symbols: [], explanation: `${place.label} imports ${surrounding.label}, which this patch does not change.`,
      });
    }
  }

  const ordered = [...places.values()].sort((left, right) => {
    if (left.changed !== right.changed) return left.changed ? -1 : 1;
    return left.id.localeCompare(right.id);
  });

  return {
    places: ordered.map(({ states, ...place }): ReviewPlace => ({
      ...place,
      state: states.size === 1 ? [...states][0] : null,
    })),
    links: [...links.values()],
    focusPlaceId: placeOfDecision(focusBlockId),
    omitted,
  };
}
