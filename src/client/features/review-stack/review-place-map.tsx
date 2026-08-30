import { memo, useMemo } from 'react';
import { ChangeMapCanvas } from '../diff-review/change-map-canvas.js';
import { layoutChangeMap } from '../diff-review/change-map-layout.js';
import {
  DEFAULT_REVIEW_MAP_OVERLAYS,
  REVIEW_MAP_OVERLAY_LABELS,
  placeMapAsChangeMap,
  type ReviewMapOverlays,
} from './review-map-overlays.js';
import type { ReviewPlaceMap } from './review-places.js';
import type { ReviewSelection } from './review-selection.js';

/**
 * The map, drawn only for a block that earned it.
 *
 * It is the shared change-map drawing with a Review-owned graph fed into it:
 * places instead of decisions, unchanged surroundings included, and the
 * readings switchable. Nothing in `../diff-review` is modified to make this
 * work — the canvas and the layout are imported exactly as Changes uses them.
 */
export const ReviewPlaceMapPanel = memo(function ReviewPlaceMapPanel({
  placeMap, overlays = DEFAULT_REVIEW_MAP_OVERLAYS, selection, onToggleOverlay, onHighlightPlace, onHighlightRelationship,
}: {
  placeMap: ReviewPlaceMap;
  overlays?: ReviewMapOverlays;
  selection: ReviewSelection;
  onToggleOverlay: (overlay: keyof ReviewMapOverlays) => void;
  onHighlightPlace: (placeId: string) => void;
  onHighlightRelationship: (relationshipId: string | null) => void;
}) {
  const { map, riskBands } = useMemo(() => placeMapAsChangeMap(placeMap, overlays), [placeMap, overlays]);
  const layout = useMemo(() => layoutChangeMap(map), [map]);

  // A lone box with nothing around it is not a map: the block's own file
  // already says everything the drawing would.
  if (placeMap.places.length < 2) return null;

  const surroundings = placeMap.places.filter((place) => !place.changed).length;

  return <section className="review-place-map" aria-label="Where this block sits">
    <header>
      <h4>Where this sits</h4>
      <p>
        {placeMap.places.length} {placeMap.places.length === 1 ? 'place' : 'places'}
        {surroundings > 0 ? ` · ${surroundings} unchanged` : ''}
        {placeMap.omitted > 0 ? ` · ${placeMap.omitted} not drawn` : ''}
      </p>
      <div className="review-place-map-overlays" role="group" aria-label="Overlays">
        {(Object.keys(REVIEW_MAP_OVERLAY_LABELS) as (keyof ReviewMapOverlays)[]).map((overlay) => <button
          key={overlay}
          type="button"
          className={`review-place-map-overlay${overlays[overlay] ? ' on' : ''}`}
          aria-pressed={overlays[overlay]}
          onClick={() => onToggleOverlay(overlay)}
        >{REVIEW_MAP_OVERLAY_LABELS[overlay]}</button>)}
      </div>
    </header>
    <ChangeMapCanvas
      layout={layout}
      // Falls back to the place the queue put the reviewer in, so the drawing
      // is centred on the open block until the reviewer looks elsewhere.
      selectedId={selection.nodeId ?? placeMap.focusPlaceId}
      selectedEdgeId={selection.relationshipId}
      riskBands={riskBands}
      label="Places around this block"
      nodeAttribute="data-review-place"
      onSelect={onHighlightPlace}
      onSelectEdge={onHighlightRelationship}
    />
  </section>;
});
