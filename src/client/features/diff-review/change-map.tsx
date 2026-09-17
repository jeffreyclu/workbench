import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Maximize2, Minimize2, Network } from 'lucide-react';
import { CHANGE_RELATIONS, CHANGE_RELATION_LABELS, type ChangeMap, type ChangeRelation } from '../../../shared/change-map.js';
import { ModalDialog } from '../../components/dialogs/modal-dialog.js';
import { layoutChangeMap } from './change-map-layout.js';
import { CODE_CATEGORIES, CODE_CATEGORY_DESCRIPTIONS, CODE_CATEGORY_LABELS } from './change-map-taxonomy.js';
import { plainRelationText, selectFocusedChangeMap } from './change-map-logic.js';
import { ChangeMapCanvas } from './change-map-canvas.js';
import { ChangeMapProgressLegend } from './change-map-progress-legend.js';
import { DiffReviewChangeMapCode } from './change-map-code.js';
import type { ReviewDecision } from '../../../shared/review-decisions.js';

const CHANGE_MAP_FOCUS_LIMIT = 4;

/** The diagram answers two questions the queue cannot: which of these changes
 * exist because of another one, and how far each one reaches. A disc is a
 * change and its area is how much code it moves; the rings around it are the
 * folder and the package it lives in, so a relationship that stays at home is
 * a short line and one that crosses the codebase is a long one.
 *
 * Relationships also read as inline links inside the diff itself; the diagram
 * stays as the opt-in whole-diff view for wide refactors. */

export const DiffReviewChangeMap = memo(function DiffReviewChangeMap({ map, decisions, selectedId, cameFromId, riskBands, onSelect }: {
  map: ChangeMap;
  /** The changes behind the discs, so a clicked disc can show its own lines
   * without the reviewer going looking for them in the diff below. */
  decisions?: ReviewDecision[];
  selectedId: string | null;
  /** Where the reviewer was before following a relationship into the current
   * change, so the way back stays visible while they read. */
  cameFromId?: string | null;
  /** Scored risk band per decision, the same map the gutter dot reads, so a
   * node carries its AI score without being opened. */
  riskBands?: Map<string, string>;
  /** Moves the review to a change. The diagram never calls this on its own:
   * selecting scrolls the diff pane to the block, and a reviewer reading the
   * map did not ask to be taken anywhere. Only the code column's own control
   * does, when they ask for it. */
  onSelect: (decisionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [fullMapForSelection, setFullMapForSelection] = useState<string | null>(null);
  /** Which disc the reviewer is reading. It is the map's own state, not the
   * review's selection, because changing the selection scrolls the diff pane
   * under the diagram — the exact thing clicking a disc must not do. */
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const focused = useMemo(() => selectedId
    ? selectFocusedChangeMap(map, selectedId, CHANGE_MAP_FOCUS_LIMIT)
    : { map, visibleConnections: map.edges.length, hiddenConnections: 0 }, [map, selectedId]);
  const showingAll = Boolean(selectedId) && fullMapForSelection === selectedId;
  const visibleMap = showingAll ? map : focused.map;
  const layout = useMemo(() => layoutChangeMap(visibleMap), [visibleMap]);

  // One change has nothing to relate to, and a map of it would only take space
  // away from the diff.
  if (map.nodes.length < 2) return null;

  // A disc that the current view no longer draws cannot keep its code open:
  // the column would describe something off the diagram.
  const inspectedNode = layout.nodes.find((node) => node.id === inspectedId) ?? null;
  const inspectedDecision = inspectedNode ? decisions?.find((decision) => decision.id === inspectedNode.id) ?? null : null;

  const selectedEdge = layout.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const relationsPresent = CHANGE_RELATIONS.filter((relation) => layout.edges.some((edge) => edge.relation === relation));
  const categoriesPresent = CODE_CATEGORIES.filter((category) => layout.nodes.some((node) => node.category === category));
  const relatedCount = layout.nodes.filter((node) => node.degree > 0).length;
  const reaching = layout.edges.filter((edge) => edge.scope !== 'folder').length;
  const relationshipSummary = layout.edges.length === 0
    ? 'No relationships found between these changes'
    : `${layout.edges.length} ${layout.edges.length === 1 ? 'relationship' : 'relationships'} across ${relatedCount} of ${layout.nodes.length} changes`;

  const diagramContents = (fullScreenView: boolean) => <div className="change-map-content">
    <div className="change-map-top-hud">
      {selectedId && <div className="change-map-scope">
        <span>{showingAll
          ? `All ${map.nodes.length} changes`
          : `Focused on change ${map.nodes.find((node) => node.id === selectedId)?.ordinal ?? ''} · ${focused.visibleConnections} direct ${focused.visibleConnections === 1 ? 'relationship' : 'relationships'}`}</span>
        {(focused.hiddenConnections > 0 || showingAll || focused.map.nodes.length < map.nodes.length) && <button type="button" onClick={() => setFullMapForSelection(showingAll ? null : selectedId)}>
          {showingAll ? 'Focus on current change' : `Show all ${map.nodes.length} changes`}
        </button>}
      </div>}
      {/* The three readings, said out loud. A diagram whose shape has to be
          guessed at is a puzzle, and a reviewer already has one of those open. */}
      <p className="change-map-key">
        Each disc is a change, sized by how much code it moves. Nested rings group its file, folder, and package. Light flows from called, imported, or used code into the caller or consumer. Click a disc to read its code beside the diagram.
        {layout.edges.length > 0 && ` ${reaching} of ${layout.edges.length} ${layout.edges.length === 1 ? 'relationship reaches' : 'relationships reach'} outside their own folder.`}
        {' '}Scroll to zoom, drag to pan.
      </p>
    </div>
    <ChangeMapCanvas
      layout={layout}
      selectedId={selectedId}
      cameFromId={cameFromId}
      riskBands={riskBands}
      inspectedId={decisions ? inspectedId : undefined}
      codePanel={inspectedDecision
        ? <DiffReviewChangeMapCode
            decision={inspectedDecision}
            onClose={() => setInspectedId(null)}
            onOpenInDiff={() => onSelect(inspectedDecision.id)}
          />
        : undefined}
      selectedEdgeId={selectedEdgeId}
      viewHeight={fullScreenView ? 720 : 560}
      onSelect={decisions ? (decisionId) => setInspectedId((current) => (current === decisionId ? null : decisionId)) : onSelect}
      onSelectEdge={setSelectedEdgeId}
    />
    <div className="change-map-bottom-hud">
      <p className="change-map-explanation" role="status">
        {selectedEdge
          ? plainRelationText(selectedEdge.explanation)
          : layout.edges.length === 0
            ? 'Nothing in this diff references anything else in it. Each change stands alone.'
            : 'Select a line to read why two changes are related, or a disc to read its code beside the diagram.'}
      </p>
      <ChangeMapProgressLegend nodes={map.nodes} cameFromId={cameFromId} />
      <ul className="change-map-change-legend" aria-label="Code change kind">
        <li className="change-added"><span aria-hidden="true" />New</li>
        <li className="change-modified"><span aria-hidden="true" />Modified</li>
        <li className="change-removed"><span aria-hidden="true" />Deleted</li>
      </ul>
      {/* Colour is a claim about what kind of code a change is, so the claim is
          written down next to it rather than left to be inferred. */}
      {categoriesPresent.length > 0 && <ul className="change-map-category-legend" aria-label="Kinds of code">
        {categoriesPresent.map((category) => <li key={category} className={`category-${category}`} title={CODE_CATEGORY_DESCRIPTIONS[category]}>
          <span aria-hidden="true" />{CODE_CATEGORY_LABELS[category]}
        </li>)}
      </ul>}
      {relationsPresent.length > 0 && <ul className="change-map-legend" aria-label="Relationship types">
        {relationsPresent.map((relation: ChangeRelation) => <li key={relation} className={`relation-${relation}`}><span aria-hidden="true" />{CHANGE_RELATION_LABELS[relation]}</li>)}
      </ul>}
      {map.omittedEdges > 0 && <p className="muted change-map-omitted">{map.omittedEdges} weaker relationships are not drawn; this diff exceeds the map limit.</p>}
    </div>
  </div>;

  return <>
    <section className="diff-review-change-map" aria-label="Change relationship map">
      <header>
        <button type="button" className="change-map-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <Network size={14} aria-hidden="true" />
          <span>Full change diagram</span>
          <small>{relationshipSummary}</small>
        </button>
        <button type="button" className="change-map-fullscreen-open" aria-label="Open code relationship diagram full screen" title="Open full screen" onClick={() => { setOpen(true); setFullScreen(true); }}>
          <Maximize2 size={15} aria-hidden="true" />
        </button>
      </header>
      {open && !fullScreen && diagramContents(false)}
    </section>
    {fullScreen && <ModalDialog className="change-map-fullscreen" backdropClassName="change-map-fullscreen-backdrop" label="Code relationship diagram" onClose={() => setFullScreen(false)}>
      <header className="change-map-fullscreen-header">
        <div><span><Network size={14} aria-hidden="true" /> Code relationships</span><h2>Full change diagram</h2><small>{relationshipSummary}</small></div>
        <button type="button" aria-label="Exit full screen" title="Exit full screen" onClick={() => setFullScreen(false)}><Minimize2 size={17} aria-hidden="true" /></button>
      </header>
      {diagramContents(true)}
    </ModalDialog>}
  </>;
});
