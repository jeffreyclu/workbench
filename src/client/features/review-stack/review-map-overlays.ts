import type { ChangeMap, ChangeMapNode } from '../../../shared/change-map.js';
import type { ReviewRiskSignal } from '../../../shared/review-decisions.js';
import type { ReviewPlaceMap } from './review-places.js';

/**
 * What the drawing says on top of the places.
 *
 * The map is one picture with switchable readings rather than four maps. A
 * reviewer asking "what is risky here" and one asking "what have I answered"
 * are looking at the same system, and redrawing the graph per question would
 * move the boxes under them.
 *
 * Every overlay is off-by-default cheap: it reads values the queue already
 * computed, so toggling one costs a render and no analysis.
 */
export interface ReviewMapOverlays {
  /** Risk signals the block carries, as the canvas's corner dot. */
  risk: boolean;
  /** The tier routing priced this place's blocks at. */
  priority: boolean;
  /** Recorded verdicts, as the canvas's reviewed styling. */
  state: boolean;
  /** Delegated answers already bought here. Answers, not tokens — no token
   * telemetry reaches this surface. */
  spend: boolean;
}

export const REVIEW_MAP_OVERLAY_LABELS: Record<keyof ReviewMapOverlays, string> = {
  risk: 'Risk', priority: 'Priority', state: 'Reviewed', spend: 'Spend',
};

/** Risk and priority answer "where do I look"; the other two are audit
 * readings a reviewer asks for deliberately. */
export const DEFAULT_REVIEW_MAP_OVERLAYS: ReviewMapOverlays = { risk: true, priority: true, state: true, spend: false };

const HIGH_RISK: ReviewRiskSignal[] = ['auth', 'persistence', 'public_api'];

export function placeRiskBand(signals: ReviewRiskSignal[]): string | null {
  if (signals.some((signal) => HIGH_RISK.includes(signal))) return 'high';
  return signals.length > 0 ? 'medium' : null;
}

/**
 * Places, in the shape the shared layout and canvas already draw.
 *
 * This is the whole adapter: `layoutChangeMap` and `ChangeMapCanvas` are
 * imported unchanged and know nothing about places, so Changes keeps rendering
 * exactly what it rendered before. The cost of the reuse is that the canvas
 * names each node "Decision N" in its accessible label — that string lives in
 * a file the isolation contract forbids Review from editing, so the node's
 * `behavior` carries the correction instead.
 */
export function placeMapAsChangeMap(placeMap: ReviewPlaceMap, overlays: ReviewMapOverlays): {
  map: ChangeMap;
  riskBands: Map<string, string>;
} {
  const degrees = new Map<string, number>();
  for (const link of placeMap.links) {
    degrees.set(link.fromId, (degrees.get(link.fromId) ?? 0) + 1);
    degrees.set(link.toId, (degrees.get(link.toId) ?? 0) + 1);
  }

  const riskBands = new Map<string, string>();
  const nodes = placeMap.places.map((place, index): ChangeMapNode => {
    const band = overlays.risk ? placeRiskBand(place.riskSignals) : null;
    if (band) riskBands.set(place.id, band);
    const priority = overlays.priority && place.tier ? `${place.tier} · ` : '';
    const blocks = place.blockIds.length;
    return {
      id: place.id,
      ordinal: index + 1,
      label: `${priority}${place.label}`,
      subject: place.label,
      filePath: place.path,
      fileCount: 1,
      filePaths: [place.path],
      // The spend reading rides the symbol line, which is the only free line on
      // a node the canvas draws.
      symbols: overlays.spend
        ? [{ name: `${place.answers} answers`, kind: 'value' as const, change: 'changed' as const }, ...place.symbols]
        : place.symbols,
      signatureChanges: [],
      behavior: place.changed
        ? `The module ${place.path}, holding ${blocks} ${blocks === 1 ? 'block' : 'blocks'} of this patch.`
        : `The module ${place.path}, which this patch does not change.`,
      additions: place.additions,
      deletions: place.deletions,
      state: overlays.state ? place.state : null,
      riskSignals: place.riskSignals,
      degree: degrees.get(place.id) ?? 0,
    };
  });

  return {
    map: { nodes, edges: placeMap.links, omittedEdges: 0 },
    riskBands,
  };
}
