import { memo } from 'react';
import type { ChangeMapNode } from '../../../shared/change-map.js';

/** Colour alone tells a reviewer nothing until something names it. The diagram
 * paints two things the reviewer cannot infer from the boxes — the change they
 * followed a relationship out of, and the ones they have already decided — so
 * this strip names both and keeps the running count of what is left.
 *
 * It counts the whole diff rather than the drawn subgraph: focusing the
 * diagram narrows what is visible, not how much review is done. */

export const ChangeMapProgressLegend = memo(function ChangeMapProgressLegend({ nodes, cameFromId }: {
  nodes: ChangeMapNode[];
  cameFromId?: string | null;
}) {
  const reviewed = nodes.filter((node) => node.state !== null).length;
  const cameFrom = cameFromId ? nodes.find((node) => node.id === cameFromId) ?? null : null;

  if (reviewed === 0 && !cameFrom) return null;

  return <ul className="change-map-progress-legend" aria-label="Review progress in this diagram">
    {cameFrom && <li className="came-from"><span aria-hidden="true" />Came from change {cameFrom.ordinal}</li>}
    {reviewed > 0 && <li className="reviewed"><span aria-hidden="true" />{reviewed} of {nodes.length} already reviewed</li>}
  </ul>;
});
