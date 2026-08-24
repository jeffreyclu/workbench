import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, LoaderCircle, RefreshCw, Search, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { DiscoveryCandidate, WorkItem } from '../shared/contracts';
import { api } from './api';
import { MarkdownComposer } from './markdown-composer.js';
import { ListRowSkeleton } from './skeleton';

export function DiscoveryNav({ active, onClick }: { active: boolean; onClick: () => void }) {
  const inbox = useQuery({ queryKey: ['discovery', 'pending'], queryFn: () => api.getDiscoveryInbox('pending'), refetchInterval: 10_000 });
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}><Search size={16} /> Discoveries <span>{inbox.data?.pendingCount ?? '…'}</span></button>;
}

export function DiscoveryInboxView({ onOpenTask, onOpenStack }: { onOpenTask: (id: string) => void; onOpenStack: () => void }) {
  const queryClient = useQueryClient();
  const [inboxView, setInboxView] = useState<'pending' | 'reviewed'>('pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inbox = useQuery({ queryKey: ['discovery', inboxView], queryFn: () => api.getDiscoveryInbox(inboxView), refetchInterval: 10_000 });
  const activeTasks = useQuery({ queryKey: ['discovery-merge-targets'], queryFn: () => api.listWorkItems('active', '') });
  const scan = useMutation({ mutationFn: api.scanDiscovery, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['discovery'] }) });
  const resolveCandidate = useMutation({
    mutationFn: ({ candidate, action }: { candidate: DiscoveryCandidate; action: 'convert' | 'dismiss' | 'snooze' }) => api.resolveDiscovery(candidate.id, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
      void queryClient.invalidateQueries({ queryKey: ['work-item-counts'] });
    },
  });
  const bulkResolve = useMutation({
    mutationFn: (action: 'convert' | 'dismiss' | 'snooze') => api.bulkResolveDiscovery([...selected], action),
    onSuccess: () => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['discovery'] });
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
      void queryClient.invalidateQueries({ queryKey: ['work-item-counts'] });
    },
  });
  const restore = useMutation({ mutationFn: api.restoreDiscovery, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['discovery'] }); } });
  const lastRun = inbox.data?.lastRun;
  // The scan endpoint returns as soon as the background job is accepted. Keep
  // the button visibly busy during that handoff as well as for the job itself.
  const isScanning = scan.isPending || Boolean(inbox.data?.running);
  return <section className="discovery-workspace">
    <header className="discovery-header">
      <div><span className="eyebrow">Morning review</span><h2>Discovered overnight</h2><p>Nothing enters your stack until you approve it.</p></div>
      <button className="button secondary compact" onClick={() => scan.mutate()} disabled={isScanning}>
        {isScanning ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} {isScanning ? 'Scanning sources…' : 'Scan now'}
      </button>
    </header>
    <div className="discovery-status">
      <strong>{inbox.data?.pendingCount ?? 0} to review</strong>
      <span>{lastRun?.completedAt ? `Last scan ${new Date(lastRun.completedAt).toLocaleString()}` : 'No completed scan yet'}</span>
      {lastRun?.errors.map((error) => <span className="error-message" key={error}>{error}</span>)}
    </div>
    {inbox.data?.queueProposal && <div className="morning-proposal"><span><Sparkles size={15} /><strong>Morning stack proposal ready</strong><small>{inbox.data.queueProposal.rationale}</small></span><button className="button primary compact" onClick={onOpenStack}>Review reorder</button></div>}
    <div className="discovery-tabs"><button className={inboxView === 'pending' ? 'active' : ''} onClick={() => { setInboxView('pending'); setSelected(new Set()); }}>Pending <span>{inbox.data?.pendingCount ?? '…'}</span></button><button className={inboxView === 'reviewed' ? 'active' : ''} onClick={() => { setInboxView('reviewed'); setSelected(new Set()); }}>Reviewed <span>{inbox.data?.reviewedCount ?? '…'}</span></button></div>
    {inboxView === 'pending' && !!inbox.data?.candidates.length && <div className="discovery-bulkbar">
      <label><input type="checkbox" checked={selected.size === inbox.data.candidates.length} onChange={(event) => setSelected(event.target.checked ? new Set(inbox.data!.candidates.map((candidate) => candidate.id)) : new Set())} /> Select all</label>
      <span>{selected.size ? `${selected.size} selected` : 'Select items for bulk review'}</span>
      <button disabled={!selected.size || bulkResolve.isPending} onClick={() => bulkResolve.mutate('snooze')}>Tomorrow</button>
      <button disabled={!selected.size || bulkResolve.isPending} onClick={() => bulkResolve.mutate('dismiss')}>Dismiss</button>
      <button className="accept" disabled={!selected.size || bulkResolve.isPending} onClick={() => bulkResolve.mutate('convert')}>Add / update</button>
    </div>}
    <div className="discovery-list">
      {inbox.isLoading && <ListRowSkeleton count={5} />}
      {!inbox.isLoading && !inbox.data?.candidates.length && <div className="discovery-empty"><Search size={26} /><h3>{inboxView === 'pending' ? 'Inbox clear' : 'No reviewed discoveries'}</h3><p>{inboxView === 'pending' ? 'The 5:00 AM scan will put new signals here for review.' : 'Decisions you make in the inbox will appear here.'}</p></div>}
      {inboxView === 'reviewed' ? inbox.data?.candidates.map((candidate) => <article className="discovery-card reviewed" key={candidate.id}><div className="discovery-source"><label><span>{candidate.provider}</span><em className={`decision-${candidate.status}`}>{candidate.status}</em></label><time>{new Date(candidate.updatedAt).toLocaleString()}</time></div><h3>{candidate.title}</h3>{candidate.description && <p>{candidate.description}</p>}<div className="discovery-actions">{candidate.sourceUrl && <a className="button secondary compact" href={candidate.sourceUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> Source</a>}{candidate.workItemId && <button className="button secondary compact" onClick={() => onOpenTask(candidate.workItemId!)}>Open task</button>}{(candidate.status === 'dismissed' || candidate.status === 'snoozed') && <button className="button primary compact" disabled={restore.isPending} onClick={() => restore.mutate(candidate.id)}><RefreshCw size={13} /> Restore to inbox</button>}</div></article>) : inbox.data?.candidates.map((candidate) => <DiscoveryCard key={candidate.id} candidate={candidate} selected={selected.has(candidate.id)} tasks={activeTasks.data?.items ?? []}
        onSelected={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(candidate.id); else next.delete(candidate.id); return next; })}
        onResolve={(action, workItemId) => action === 'merge' ? api.resolveDiscovery(candidate.id, action, workItemId).then(() => { void queryClient.invalidateQueries({ queryKey: ['discovery'] }); }) : resolveCandidate.mutate({ candidate, action })} />)}
    </div>
  </section>;
}

function DiscoveryCard({ candidate, selected, tasks, onSelected, onResolve }: { candidate: DiscoveryCandidate; selected: boolean; tasks: WorkItem[]; onSelected: (checked: boolean) => void; onResolve: (action: 'convert' | 'dismiss' | 'snooze' | 'merge', workItemId?: string) => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [description, setDescription] = useState(candidate.description);
  const [mergeTarget, setMergeTarget] = useState('');
  const suggestedTask = tasks.find((task) => task.id === candidate.suggestedWorkItemId);
  const update = useMutation({ mutationFn: () => api.updateDiscovery(candidate.id, { title: title.trim(), description }), onSuccess: () => { setEditing(false); void queryClient.invalidateQueries({ queryKey: ['discovery'] }); } });
  return <article className={`discovery-card ${selected ? 'selected' : ''}`}>
    <div className="discovery-source"><label><input type="checkbox" checked={selected} onChange={(event) => onSelected(event.target.checked)} /><span>{candidate.provider}</span>{candidate.relevance === 2 && <em>Focus</em>}</label><time>{new Date(candidate.occurredAt ?? candidate.discoveredAt).toLocaleString()}</time></div>
    {editing ? <div className="discovery-editor"><input value={title} onChange={(event) => setTitle(event.target.value)} /><MarkdownComposer conversationId={`discovery-${candidate.id}`} value={description} onChange={setDescription} placeholder="Discovery description" ariaLabel="Discovery description" /><div><button className="button secondary compact" onClick={() => { setTitle(candidate.title); setDescription(candidate.description); setEditing(false); }}>Cancel</button><button className="button primary compact" disabled={!title.trim() || update.isPending} onClick={() => update.mutate()}><Check size={13} /> Save</button></div></div> : <><button className="discovery-copy" onClick={() => setEditing(true)} title="Edit before adding"><h3>{candidate.title}</h3>{candidate.description && <p>{candidate.description}</p>}</button>
    <div className="discovery-actions">
      {candidate.sourceUrl && <a className="button secondary compact" href={candidate.sourceUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> Source</a>}
      {suggestedTask ? <span className="discovery-match"><small>Already tracked as</small><strong>{suggestedTask.title}</strong><button className="button primary compact" onClick={() => onResolve('merge', suggestedTask.id)}>Add update</button></span> : !!tasks.length && <span className="discovery-merge"><select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Merge into task…</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><button className="button secondary compact" disabled={!mergeTarget} onClick={() => onResolve('merge', mergeTarget)}>Merge</button></span>}
      <button className="button secondary compact" onClick={() => onResolve('snooze')}>Tomorrow</button>
      <button className="button secondary compact" onClick={() => onResolve('dismiss')}>Dismiss</button>
      <button className={`button ${suggestedTask ? 'secondary' : 'primary'} compact`} onClick={() => onResolve('convert')}>{suggestedTask ? 'Add separately' : 'Add to stack'}</button>
    </div></>}
  </article>;
}
