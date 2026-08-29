import { memo, useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import { CHANGE_RELATIONS, CHANGE_RELATION_LABELS, type ChangeMap, type ChangeRelation } from '../../../shared/change-map.js';
import { layoutChangeMap } from './change-map-layout.js';
import { plainRelationText, selectFocusedChangeMap } from './change-map-logic.js';
import { ChangeMapCanvas } from './change-map-canvas.js';

/** The neighbourhood of one decision, drawn beside its open panel.
 *
 * The whole-diff diagram answers "how does this change set hang together";
 * this answers the narrower question a reviewer has while reading a single
 * decision — what moved because of this, and what did this move for. It is
 * always open, because it exists to be read alongside the panel rather than
 * opted into. */

const DECISION_DIAGRAM_FOCUS_LIMIT = 3;

export const DecisionRelationshipDiagram = memo(function DecisionRelationshipDiagram({ map, decisionId, riskBands, onSelect }: {
  map: ChangeMap;
  /** The decision the open panel is showing. This diagram belongs to that
   * panel, so it follows the panel rather than the diff-pane selection. */
  decisionId: string;
  riskBands?: Map<string, string>;
  onSelect: (decisionId: string) => void;
}) {
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const focused = useMemo(() => selectFocusedChangeMap(map, decisionId, DECISION_DIAGRAM_FOCUS_LIMIT), [map, decisionId]);
  const layout = useMemo(() => layoutChangeMap(focused.map), [focused.map]);

  // A one-change diff has nothing to relate, and an empty frame next to the
  // panel would only crowd the diff behind it.
  if (map.nodes.length < 2) return null;

  const selectedEdge = layout.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const relationsPresent = CHANGE_RELATIONS.filter((relation) => layout.edges.some((edge) => edge.relation === relation));

  return <section className="decision-relationship-diagram" aria-label="Related changes for this decision">
    <header>
      <Network size={13} aria-hidden="true" />
      <span>Related changes</span>
      <small>{focused.visibleConnections === 0
        ? 'None in this diff'
        : `${focused.visibleConnections} direct ${focused.visibleConnections === 1 ? 'relationship' : 'relationships'}${focused.hiddenConnections > 0 ? ` · ${focused.hiddenConnections} more` : ''}`}</small>
    </header>
    {focused.visibleConnections === 0
      ? <p className="muted">Nothing else in this diff references this change. It stands alone.</p>
      : <>
        <ChangeMapCanvas
          layout={layout}
          selectedId={decisionId}
          riskBands={riskBands}
          selectedEdgeId={selectedEdgeId}
          label="Related changes diagram"
          nodeAttribute="data-decision-diagram-node"
          onSelect={onSelect}
          onSelectEdge={setSelectedEdgeId}
        />
        <p className="change-map-explanation" role="status">
          {selectedEdge
            ? plainRelationText(selectedEdge.explanation)
            : 'Select a line to read why two changes are related, or a box to jump to that change.'}
        </p>
        {relationsPresent.length > 0 && <ul className="change-map-legend" aria-label="Relationship types">
          {relationsPresent.map((relation: ChangeRelation) => <li key={relation} className={`relation-${relation}`}><span aria-hidden="true" />{CHANGE_RELATION_LABELS[relation]}</li>)}
        </ul>}
      </>}
  </section>;
});
