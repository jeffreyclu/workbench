import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Network } from 'lucide-react';
import { CHANGE_RELATIONS, CHANGE_RELATION_LABELS, type ChangeMap, type ChangeRelation } from '../../../shared/change-map.js';
import { layoutChangeMap } from './change-map-layout.js';
import { plainRelationText, selectFocusedChangeMap } from './change-map-logic.js';
import { ChangeMapCanvas } from './change-map-canvas.js';
import { ChangeMapProgressLegend } from './change-map-progress-legend.js';
import type { DecisionPopoverAnchor } from './decision-popover.js';

const CHANGE_MAP_FOCUS_LIMIT = 4;

/** The diagram answers one question the queue cannot: which of these changes
 * exist because of another one. It reads left to right — a cause sits left of
 * everything that moved for it — and shares its selection with the queue and
 * the diff pane, so clicking a node is the same act as clicking its decision.
 *
 * Relationships now read primarily as inline links inside the diff itself; the
 * diagram stays as the opt-in whole-diff view for wide refactors. */

export const DiffReviewChangeMap = memo(function DiffReviewChangeMap({ map, selectedId, cameFromId, riskBands, openDetailFor, onSelect, onOpenDetail }: {
  map: ChangeMap;
  selectedId: string | null;
  /** Where the reviewer was before following a relationship into the current
   * change, so the way back stays visible while they read. */
  cameFromId?: string | null;
  /** Scored risk band per decision, the same map the gutter dot reads, so a
   * node carries its AI score without being opened. */
  riskBands?: Map<string, string>;
  openDetailFor?: string | null;
  onSelect: (decisionId: string) => void;
  /** Opens the decision detail — score and AI assist — anchored to the node.
   * The diagram is a review surface, not an index: a node must reach the same
   * panel its gutter marker does. */
  onOpenDetail?: (decisionId: string, anchor: DecisionPopoverAnchor) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [fullMapForSelection, setFullMapForSelection] = useState<string | null>(null);
  const focused = useMemo(() => selectedId
    ? selectFocusedChangeMap(map, selectedId, CHANGE_MAP_FOCUS_LIMIT)
    : { map, visibleConnections: map.edges.length, hiddenConnections: 0 }, [map, selectedId]);
  const showingAll = Boolean(selectedId) && fullMapForSelection === selectedId;
  const visibleMap = showingAll ? map : focused.map;
  const layout = useMemo(() => layoutChangeMap(visibleMap), [visibleMap]);

  // One change has nothing to relate to, and a map of it would only take space
  // away from the diff.
  if (map.nodes.length < 2) return null;

  const selectedEdge = layout.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const relationsPresent = CHANGE_RELATIONS.filter((relation) => layout.edges.some((edge) => edge.relation === relation));
  const relatedCount = layout.nodes.filter((node) => node.degree > 0).length;

  return <section className="diff-review-change-map" aria-label="Change relationship map">
    <header>
      <button type="button" className="change-map-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <Network size={14} aria-hidden="true" />
        <span>Full change diagram</span>
        <small>{layout.edges.length === 0
          ? 'No relationships found between these changes'
          : `${layout.edges.length} ${layout.edges.length === 1 ? 'relationship' : 'relationships'} across ${relatedCount} of ${layout.nodes.length} changes`}</small>
      </button>
    </header>
    {open && <>
      {selectedId && <div className="change-map-scope">
        <span>{showingAll
          ? `All ${map.nodes.length} changes`
          : `Focused on change ${map.nodes.find((node) => node.id === selectedId)?.ordinal ?? ''} · ${focused.visibleConnections} direct ${focused.visibleConnections === 1 ? 'relationship' : 'relationships'}`}</span>
        {(focused.hiddenConnections > 0 || showingAll || focused.map.nodes.length < map.nodes.length) && <button type="button" onClick={() => setFullMapForSelection(showingAll ? null : selectedId)}>
          {showingAll ? 'Focus on current change' : `Show all ${map.nodes.length} changes`}
        </button>}
      </div>}
      <ChangeMapCanvas
        layout={layout}
        selectedId={selectedId}
        cameFromId={cameFromId}
        riskBands={riskBands}
        openDetailFor={openDetailFor}
        selectedEdgeId={selectedEdgeId}
        onSelect={onSelect}
        onOpenDetail={onOpenDetail}
        onSelectEdge={setSelectedEdgeId}
      />
      <p className="change-map-explanation" role="status">
        {selectedEdge
          ? plainRelationText(selectedEdge.explanation)
          : layout.edges.length === 0
            ? 'Nothing in this diff references anything else in it. Each change stands alone.'
            : 'Select a line to read why two changes are related, or a box to open that decision — risk score and AI assist included.'}
      </p>
      <ChangeMapProgressLegend nodes={map.nodes} cameFromId={cameFromId} />
      {relationsPresent.length > 0 && <ul className="change-map-legend" aria-label="Relationship types">
        {relationsPresent.map((relation: ChangeRelation) => <li key={relation} className={`relation-${relation}`}><span aria-hidden="true" />{CHANGE_RELATION_LABELS[relation]}</li>)}
      </ul>}
      {map.omittedEdges > 0 && <p className="muted change-map-omitted">{map.omittedEdges} weaker relationships are not drawn; this diff exceeds the map limit.</p>}
    </>}
  </section>;
});
