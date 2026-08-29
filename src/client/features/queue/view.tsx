import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Bot, Check, Clock, GripVertical, LoaderCircle, Sparkles, User } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AgentRun, Assignee, WorkItem } from '../../../shared/contracts';
import { ProjectColorDot, projectTheme } from '../../components/project/project-color';
import { useTaskClassification } from '../../features/queue/hooks';

function AssigneeIcon({ assignee }: { assignee: Assignee }) {
  const Icon = assignee === 'jeffrey' ? User : Bot;
  return <span className={`assignee-chip assignee-${assignee}`} title={assignee}><Icon size={12} /> {assignee}</span>;
}

const CLASSIFICATION_LABELS: Record<AgentRun['kind'], string> = {
  research: 'Research', analysis: 'Analysis', strategy: 'Strategy', execute: 'Execute', review: 'Review', bugfix: 'Bug fix',
};
const CLASSIFICATION_KINDS = Object.keys(CLASSIFICATION_LABELS) as AgentRun['kind'][];

export function ClassificationKindDisclosure({ kind, onChange, pending = false, label = 'Task type', ariaLabel }: {
  kind?: string | null; onChange: (kind: AgentRun['kind']) => void; pending?: boolean; label?: string; ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const validKind = !kind || CLASSIFICATION_KINDS.includes(kind as AgentRun['kind']);
  const selectedKind = (validKind ? kind ?? 'execute' : 'execute') as AgentRun['kind'];

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setAnchor(null);
    if (restoreFocus) window.requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);
  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = Math.min(300, window.innerWidth - 24);
    const menuHeight = 154;
    const below = rect.bottom + 8;
    const top = below + menuHeight <= window.innerHeight - 12 ? below : Math.max(12, rect.top - menuHeight - 8);
    const left = Math.min(Math.max(12, rect.left + (rect.width - menuWidth) / 2), window.innerWidth - menuWidth - 12);
    setAnchor({ top, left });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-kind="${selectedKind}"]`)?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) closeMenu();
    };
    const handleViewportChange = () => closeMenu();
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', handleViewportChange);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [closeMenu, open, selectedKind]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (!options.length) return;
    const current = options.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
        : event.key === 'ArrowDown' ? (current + 1 + options.length) % options.length
          : (current - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  if (!validKind) return null;

  return <span className="card-classification-control disclosure" onClick={(event) => event.stopPropagation()}>
    <button ref={buttonRef} type="button" className="icon-button" aria-haspopup="listbox" aria-controls={open ? listboxId : undefined} aria-expanded={open} aria-label={ariaLabel ?? `${label}: ${CLASSIFICATION_LABELS[selectedKind]}`} title={ariaLabel ?? `${label}: ${CLASSIFICATION_LABELS[selectedKind]}`} disabled={pending} onClick={() => open ? closeMenu() : openMenu()}>{pending ? <LoaderCircle className="spin" size={13} /> : <Bot size={13} />}</button>
    {open && anchor && createPortal(
      <div ref={menuRef} id={listboxId} className="classification-kind-menu" role="listbox" aria-label={ariaLabel ?? label} style={anchor} onKeyDown={handleMenuKeyDown}>
        {CLASSIFICATION_KINDS.map((optionKind) => <button key={optionKind} type="button" role="option" data-kind={optionKind} aria-selected={optionKind === selectedKind} className="classification-kind-option" onClick={() => { onChange(optionKind); closeMenu(true); }}>
          <span>{CLASSIFICATION_LABELS[optionKind]}</span>{optionKind === selectedKind && <Check size={14} aria-hidden="true" />}
        </button>)}
      </div>,
      document.body,
    )}
  </span>;
}

export function TaskClassificationSelect({ itemId, kind, compact = false, disclosure = false }: { itemId: string; kind?: string | null; compact?: boolean; disclosure?: boolean }) {
  const update = useTaskClassification(itemId);
  if (kind && !['research', 'analysis', 'strategy', 'execute', 'review', 'bugfix'].includes(kind)) return null;
  const selectedKind = (kind ?? 'execute') as AgentRun['kind'];

  if (disclosure) {
    return <ClassificationKindDisclosure kind={kind} onChange={(next) => update.mutate(next)} pending={update.isPending} label="Task type" />;
  }

  const select = <select className="card-classification-select" aria-label="Task type" value={selectedKind} onChange={(event) => update.mutate(event.target.value as AgentRun['kind'])} disabled={update.isPending}>
    <option value="research">Research</option><option value="analysis">Analysis</option><option value="strategy">Strategy</option><option value="execute">Execute</option><option value="review">Review</option><option value="bugfix">Bug fix</option>
  </select>;

  return <span className={`card-classification-control ${compact ? 'compact' : ''}`} onClick={(event) => event.stopPropagation()}>
    <span className="card-classification"><Bot size={10} /> Task type</span>
    {select}
    {update.isPending && <LoaderCircle className="spin card-classification-spinner" size={10} />}
  </span>;
}

export function SortableQueueItem({ item, index, selected, focused, draggable, onSelect, onOpenTask, onFocus, onKeyDown }: {
  item: WorkItem; index: number; selected: boolean; focused: boolean; draggable: boolean;
  onSelect: () => void; onOpenTask: (id: string) => void; onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !draggable,
    // A manual drop commits a new rank; it should land there immediately.
    // System-driven rank changes use the separate FLIP hook instead.
    transition: null,
  });
  const hasFollowUps = (item.lineage?.followUpCount ?? 0) > 0;
  const isFollowUp = Boolean(item.parentWorkItemId && item.lineage?.parentTitle);
  const color = item.projectName ? projectTheme(item.projectName) : null;
  // Sortable's full transform includes scale values when neighboring slots
  // have different dimensions. A queue card should move, never morph.
  const style = {
    transform: CSS.Translate.toString(transform),
    // dnd-kit can briefly return a transform transition while it reconciles a
    // completed sort even when the configured transition is null. Suppress
    // that teardown value; ordinary card hover transitions resume at rest.
    transition: transform || transition || isDragging ? 'none' : undefined,
    ...(color ? { '--task-accent': color.accent, '--task-tint': color.tint, '--task-border': color.border } : {}),
  } as CSSProperties;
  const isHumanOnly = !item.agentOutcome && item.assignees.length === 1 && item.assignees[0] === 'jeffrey';
  const openDependencies = (item.blockedBy ?? []).filter((dependency) => dependency.isOpen);
  const visibleOutcome = item.agentOutcome ?? (item.status === 'in_progress' ? 'in_progress' : null);
  return <div ref={setNodeRef} data-work-item-id={item.id} style={style} role="listitem" tabIndex={focused ? 0 : -1} className={`stack-card queue-item ${visibleOutcome ? `outcome-${visibleOutcome}` : ''} ${isHumanOnly ? 'human-only' : ''} ${item.projectName ? 'project-colored' : ''} ${hasFollowUps || isFollowUp ? 'relationship-family' : ''} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`} onClick={onSelect} onFocus={onFocus} onKeyDown={onKeyDown}>
    {draggable ? <button className="drag-handle" onClick={(event) => event.stopPropagation()} aria-label={`Reorder ${item.title}`} {...attributes} {...listeners}><GripVertical size={15} /></button> : <span className="rank">{String(index + 1).padStart(2, '0')}</span>}
    <span className="item-copy"><strong>{item.title}</strong>
      <span className="item-meta"><span className="item-project">{item.projectName && <ProjectColorDot projectName={item.projectName} />}{item.sourceIdentifier ? `${item.sourceIdentifier} · ` : ''}{item.projectName ?? 'Personal'}</span><span className="source-tags">{item.sourceTags.map((source) => <span key={source} className={`source-tag source-${source.toLowerCase()}`}>{source}</span>)}</span></span>
      <TaskClassificationSelect itemId={item.id} kind={item.classificationKind} compact />
      {isFollowUp && <button type="button" className="task-lineage child-lineage" onClick={(event) => { event.stopPropagation(); onOpenTask(item.parentWorkItemId!); }} aria-label={`Open parent task: ${item.lineage!.parentTitle}`}><span aria-hidden="true">↳</span> Follow-up to: {item.lineage!.parentTitle}</button>}
      {hasFollowUps && <button type="button" className="task-lineage follow-up-summary" onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={`View ${item.lineage!.followUpCount} follow-ups for ${item.title}`}>{item.lineage!.followUpCount} follow-up{item.lineage!.followUpCount === 1 ? '' : 's'} · {item.lineage!.openFollowUpCount} open</button>}
      {openDependencies.length > 0 && <span className="dependency-signal"><AlertTriangle size={11} /> Blocked by {openDependencies.length} prerequisite{openDependencies.length === 1 ? '' : 's'}</span>}
      {isHumanOnly && <span className="human-only-marker"><User size={11} /> Your task</span>}
      {(item.agentOutcome === 'needs_attention' || item.agentOutcome === 'follow_ups' || openDependencies.length > 0) && <span className="queue-item-ctas">
        {item.agentOutcome === 'needs_attention' && <button type="button" className="queue-item-cta queue-item-cta-review" onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={`Review ${item.title}`}>Review</button>}
        {openDependencies.length > 0 && <button type="button" className="queue-item-cta" onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={`View prerequisites for ${item.title}`}>View prerequisites</button>}
        {item.agentOutcome === 'follow_ups' && <button type="button" className="queue-item-cta queue-item-cta-inspect" onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={`Inspect execution results for ${item.title}`}>Inspect</button>}
      </span>}
      {item.archivedAt && <time className="archive-date" dateTime={item.archivedAt}>Archived {new Date(item.archivedAt).toLocaleDateString()}</time>}
      {item.assignees.length > 0 && <span className="assignees">{item.assignees.map((assignee) => <AssigneeIcon key={assignee} assignee={assignee} />)}</span>}
    </span>
    {visibleOutcome && <span className={`agent-outcome agent-outcome-${visibleOutcome}`}>{visibleOutcome === 'needs_attention' ? <AlertTriangle size={11} /> : visibleOutcome === 'follow_ups' ? <Sparkles size={11} /> : visibleOutcome === 'waiting_promotion' ? <Clock size={11} /> : visibleOutcome === 'promoting' || visibleOutcome === 'in_progress' ? <LoaderCircle className="spin" size={11} /> : <Check size={11} />}{visibleOutcome === 'needs_attention' ? 'Needs attention' : visibleOutcome === 'canceled' ? 'Canceled' : visibleOutcome === 'follow_ups' ? 'Follow-ups recommended' : visibleOutcome === 'promoting' ? 'Approved · promoting preview' : visibleOutcome === 'waiting_promotion' ? 'Approved and waiting promotion' : visibleOutcome === 'in_progress' ? 'In progress' : 'Awaiting'}</span>}
  </div>;
}
