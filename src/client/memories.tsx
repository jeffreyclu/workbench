import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, LoaderCircle, Pencil, RotateCcw, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { Memory } from '../shared/contracts';

type LibraryView = 'active' | 'proposed' | 'all';

const kindLabels: Record<Memory['kind'], string> = {
  constraint: 'Constraint',
  preference: 'Preference',
  decision: 'Decision',
  convention: 'Convention',
  fact: 'Fact',
};

const scopeLabels: Record<Memory['scope'], string> = {
  global: 'Global',
  project: 'Project',
  workspace: 'Workspace',
  reference: 'Reference',
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
}

function EditMemoryForm({ memory, onDone }: { memory: Memory; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(memory.body);
  const supersede = useMutation({
    mutationFn: () => api.supersedeMemory(memory.id, { kind: memory.kind, body: body.trim() }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['memories'] }); onDone(); },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (body.trim() && body.trim() !== memory.body) supersede.mutate();
    else onDone();
  }

  return (
    <form className="memory-edit-form" onSubmit={submit}>
      <textarea value={body} rows={2} maxLength={800} onChange={(event) => setBody(event.target.value)} aria-label="Edit memory text" autoFocus />
      <div className="memory-edit-actions">
        <button className="button secondary compact" type="button" onClick={onDone}><X size={13} /> Cancel</button>
        <button className="button secondary compact" disabled={!body.trim() || supersede.isPending}>
          {supersede.isPending ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} Save as new version
        </button>
      </div>
      {supersede.error && <p className="error-message">{supersede.error.message}</p>}
    </form>
  );
}

function MemoryCard({ memory }: { memory: Memory }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['memories'] });
  const reject = useMutation({ mutationFn: () => api.rejectMemory(memory.id), onSuccess: invalidate });
  const restore = useMutation({
    mutationFn: () => api.updateMemory(memory.id, { status: 'active' }),
    onSuccess: invalidate,
  });

  return (
    <article className={`memory-card memory-card-${memory.status}`}>
      <header>
        <em className="relationship-tag">{kindLabels[memory.kind]}</em>
        <em className="relationship-tag">{scopeLabels[memory.scope]}</em>
        {memory.scope === 'project' && memory.projectName && <em className="relationship-tag">{memory.projectName}</em>}
        {memory.status !== 'active' && <em className="relationship-tag warn">{memory.status}</em>}
      </header>
      {editing
        ? <EditMemoryForm memory={memory} onDone={() => setEditing(false)} />
        : <p className="memory-body">{memory.body}</p>}
      <div className="memory-meta">
        <time>{formatDate(memory.updatedAt)}</time>
        {memory.createdBy && <span>{memory.createdBy}</span>}
      </div>
      {!editing && memory.status === 'active' && (
        <div className="memory-actions">
          <button className="button secondary compact" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
          <button className="button secondary compact danger" disabled={reject.isPending} onClick={() => reject.mutate()}>
            {reject.isPending ? <LoaderCircle className="spin" size={13} /> : <X size={13} />} Reject
          </button>
        </div>
      )}
      {!editing && memory.status === 'rejected' && (
        <div className="memory-actions">
          <button className="button secondary compact" disabled={restore.isPending} onClick={() => restore.mutate()}>
            {restore.isPending ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} Restore
          </button>
        </div>
      )}
      {reject.error && <p className="error-message">{reject.error.message}</p>}
      {restore.error && <p className="error-message">{restore.error.message}</p>}
    </article>
  );
}

export function MemoriesView() {
  const [view, setView] = useState<LibraryView>('active');
  const library = useQuery({
    queryKey: ['memories', view],
    queryFn: () => api.listMemories(view === 'all' ? undefined : { status: view === 'proposed' ? 'proposed' : 'active' }),
  });
  const memories = library.data?.memories ?? [];

  return (
    <section className="artifact-workspace">
      <header className="discovery-header">
        <div>
          <span className="eyebrow">Shared context</span>
          <h2>Memories</h2>
          <p>Durable facts, decisions, preferences, constraints, and conventions agents carry into every prompt.</p>
        </div>
      </header>
      <div className="discovery-tabs">
        <button className={view === 'active' ? 'active' : ''} onClick={() => setView('active')}>Active <span>{view === 'active' ? memories.length : '…'}</span></button>
        <button className={view === 'proposed' ? 'active' : ''} onClick={() => setView('proposed')}>Proposed</button>
        <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>All</button>
      </div>
      <div className="artifact-list">
        {library.isLoading && <div className="list-state"><LoaderCircle className="spin" /> Loading memories…</div>}
        {library.isError && <div className="list-state error-message">Could not load memories. <button className="button secondary compact" onClick={() => library.refetch()}>Retry</button></div>}
        {!library.isLoading && memories.length === 0 && (
          <div className="discovery-empty">
            <BookOpen size={26} />
            <h3>Nothing here yet</h3>
            <p>Durable facts agents record about this workspace will show up here.</p>
          </div>
        )}
        {memories.map((memory) => <MemoryCard key={memory.id} memory={memory} />)}
      </div>
    </section>
  );
}

export function MemoriesNav({ active, onClick }: { active: boolean; onClick: () => void }) {
  const library = useQuery({ queryKey: ['memories', 'active'], queryFn: () => api.listMemories({ status: 'active' }) });
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <BookOpen size={16} /> Memories <span>{library.data?.memories?.length ?? '…'}</span>
    </button>
  );
}
