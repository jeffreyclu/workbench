import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Check, GripVertical, LoaderCircle, Sparkles, User } from 'lucide-react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { AgentRun, Assignee, WorkItem } from '../shared/contracts';
import { api } from './api';

const taskPalette = [
  { accent: '#648bd8', tint: '#151c2a', border: '#2d4164' },
  { accent: '#9676d3', tint: '#1e1928', border: '#43365d' },
  { accent: '#c06ca8', tint: '#261824', border: '#543046' },
] as const;

function taskColor(item: WorkItem) {
  const familyId = item.parentWorkItemId ?? item.id;
  let hash = 0;
  for (const character of familyId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return taskPalette[Math.abs(hash) % taskPalette.length];
}

function AssigneeIcon({ assignee }: { assignee: Assignee }) {
  const Icon = assignee === 'jeffrey' ? User : Bot;
  return <span className={`assignee-chip assignee-${assignee}`} title={assignee}><Icon size={12} /> {assignee}</span>;
}

export function TaskClassificationSelect({ itemId, kind, compact = false }: { itemId: string; kind?: string | null; compact?: boolean }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (nextKind: AgentRun['kind']) => api.classifyWorkItem(itemId, nextKind),
    onSuccess: async () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['work-items'] }),
      queryClient.invalidateQueries({ queryKey: ['work-item', itemId] }),
    ]),
  });
  if (!kind || !['research', 'analysis', 'strategy', 'execute', 'review'].includes(kind)) return null;
  const selectedKind = kind as AgentRun['kind'];
  return <span className={`card-classification-control ${compact ? 'compact' : ''}`} onClick={(event) => event.stopPropagation()}>
    <span className="card-classification"><Bot size={10} /> Task type</span>
    <select className="card-classification-select" aria-label="Task type" value={selectedKind} onChange={(event) => update.mutate(event.target.value as AgentRun['kind'])} disabled={update.isPending}>
      <option value="research">Research</option><option value="analysis">Analysis</option><option value="strategy">Strategy</option><option value="execute">Execute</option><option value="review">Review</option>
    </select>
    {update.isPending && <LoaderCircle className="spin card-classification-spinner" size={10} />}
  </span>;
}

export function SortableQueueItem({ item, index, selected, focused, draggable, onSelect, onOpenTask, onFocus, onKeyDown }: {
  item: WorkItem; index: number; selected: boolean; focused: boolean; draggable: boolean;
  onSelect: () => void; onOpenTask: (id: string) => void; onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !draggable });
  const hasFollowUps = (item.lineage?.followUpCount ?? 0) > 0;
  const isFollowUp = Boolean(item.parentWorkItemId && item.lineage?.parentTitle);
  const color = hasFollowUps || isFollowUp ? taskColor(item) : null;
  // Sortable's full transform includes scale values when neighboring slots
  // have different dimensions. A queue card should move, never morph.
  const style = { transform: CSS.Translate.toString(transform), transition, ...(color ? { '--task-accent': color.accent, '--task-tint': color.tint, '--task-border': color.border } : {}) } as CSSProperties;
  const isHumanOnly = !item.agentOutcome && item.assignees.length === 1 && item.assignees[0] === 'jeffrey';
  const openDependencies = (item.blockedBy ?? []).filter((dependency) => dependency.isOpen);
  return <div ref={setNodeRef} data-work-item-id={item.id} style={style} role="listitem" tabIndex={focused ? 0 : -1} className={`queue-item ${item.agentOutcome ? `outcome-${item.agentOutcome}` : ''} ${isHumanOnly ? 'human-only' : ''} ${hasFollowUps || isFollowUp ? 'relationship-family' : ''} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''}`} onClick={onSelect} onFocus={onFocus} onKeyDown={onKeyDown}>
    {draggable ? <button className="drag-handle" onClick={(event) => event.stopPropagation()} aria-label={`Reorder ${item.title}`} {...attributes} {...listeners}><GripVertical size={15} /></button> : <span className="rank">{String(index + 1).padStart(2, '0')}</span>}
    <span className="item-copy"><strong>{item.title}</strong>
      <span className="item-meta"><span>{item.sourceIdentifier ? `${item.sourceIdentifier} · ` : ''}{item.projectName ?? 'Personal'}</span><span className="source-tags">{item.sourceTags.map((source) => <span key={source} className={`source-tag source-${source.toLowerCase()}`}>{source}</span>)}</span></span>
      <TaskClassificationSelect itemId={item.id} kind={item.classificationKind} compact />
      {isFollowUp && <button type="button" className="task-lineage child-lineage" onClick={(event) => { event.stopPropagation(); onOpenTask(item.parentWorkItemId!); }} aria-label={`Open parent task: ${item.lineage!.parentTitle}`}><span aria-hidden="true">↳</span> Follow-up to: {item.lineage!.parentTitle}</button>}
      {hasFollowUps && <button type="button" className="task-lineage follow-up-summary" onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={`View ${item.lineage!.followUpCount} follow-ups for ${item.title}`}>{item.lineage!.followUpCount} follow-up{item.lineage!.followUpCount === 1 ? '' : 's'} · {item.lineage!.openFollowUpCount} open</button>}
      {openDependencies.length > 0 && <span className="dependency-signal"><AlertTriangle size={11} /> Blocked by {openDependencies.length} prerequisite{openDependencies.length === 1 ? '' : 's'}</span>}
      {isHumanOnly && <span className="human-only-marker"><User size={11} /> Your task</span>}
      {item.agentOutcome && <span className={`agent-outcome agent-outcome-${item.agentOutcome}`}>{item.agentOutcome === 'needs_attention' ? <AlertTriangle size={11} /> : item.agentOutcome === 'follow_ups' ? <Sparkles size={11} /> : <Check size={11} />}{item.agentOutcome === 'needs_attention' ? 'Needs attention' : item.agentOutcome === 'follow_ups' ? 'Follow-ups recommended' : 'Finished'}</span>}
      {item.archivedAt && <span className={`archive-meta ${item.completionStatus}`}>{item.completionStatus === 'completed' ? 'Completed' : 'Incomplete'} · {new Date(item.archivedAt).toLocaleDateString()}</span>}
      {item.assignees.length > 0 && <span className="assignees">{item.assignees.map((assignee) => <AssigneeIcon key={assignee} assignee={assignee} />)}</span>}
    </span>
  </div>;
}
