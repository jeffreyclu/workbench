import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, LoaderCircle, Paperclip, Plus, Search, Sparkles, X } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import type { AgentRun, BrokerSourceId, WorkItem } from '../shared/contracts';
import { api } from './api';
import { MarkdownComposer } from './markdown-composer.js';
import { ModalDialog } from './modal-dialog';
import { ProjectField } from './project-field';
import { toast, toastError } from './toast-store';

export function CreateTask({ onClose, onCreated, defaultProjectName = '' }: { onClose: () => void; onCreated: (item: WorkItem) => void; defaultProjectName?: string }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'search' | 'link' | 'ai' | 'manual'>('manual');
  const [sourceQuery, setSourceQuery] = useState('');
  const [submittedSourceQuery, setSubmittedSourceQuery] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiDraftReady, setAiDraftReady] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [classificationKind, setClassificationKind] = useState<AgentRun['kind']>('execute');
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const taskTypeField = <label>Task type<select aria-label="Task type" value={classificationKind} onChange={(event) => setClassificationKind(event.target.value as AgentRun['kind'])}>
    <option value="execute">Execute</option><option value="bugfix">Bug fix</option><option value="research">Research</option><option value="analysis">Analysis</option><option value="strategy">Strategy</option><option value="review">Review</option>
  </select></label>;
  const attachmentField = <div className="task-attachment-picker"><span className="section-label">Files for the agent</span><p className="muted">Saved with this task and available when it executes.</p>{files.length > 0 && <div className="pending-files">{files.map((file) => <button type="button" key={`${file.name}-${file.size}`} onClick={() => setFiles((current) => current.filter((entry) => entry !== file))}><Paperclip size={11} /> {file.name} <X size={10} /></button>)}</div>}<input ref={fileRef} className="visually-hidden" type="file" multiple onChange={(event) => setFiles((current) => [...current, ...Array.from(event.target.files ?? [])].slice(0, 10))} /><button type="button" className="button secondary compact" onClick={() => fileRef.current?.click()}><Paperclip size={13} /> Attach files</button></div>;
  const closeBeforeShowingCreatedTask = async () => {
    // Let the dialog leave the tree before invalidating the list. Otherwise the
    // new card begins its enter animation behind the dialog and it is invisible.
    onClose();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  };
  const createManual = useMutation({
    mutationFn: api.createWorkItem,
    onSuccess: async ({ item }) => {
      await closeBeforeShowingCreatedTask();
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
      onCreated(item);
    },
  });
  const searchedSources: BrokerSourceId[] = ['linear', 'github', 'atlassian', 'slack'];
  const sourceSearches = useQueries({
    queries: searchedSources.map((source) => ({
      queryKey: ['source-search', source, submittedSourceQuery],
      queryFn: ({ signal }) => api.searchSources(submittedSourceQuery, [source], signal),
      enabled: mode === 'search' && submittedSourceQuery.length >= 2,
    })),
  });
  const searchIsFetching = sourceSearches.some((search) => search.isFetching);
  const searchResults = sourceSearches.flatMap((search) => search.data?.results ?? []);
  async function startSourceSearch() {
    const query = sourceQuery.trim();
    if (query.length < 2) return;
    await queryClient.cancelQueries({ queryKey: ['source-search'] });
    setSubmittedSourceQuery(query);
  }
  async function cancelSourceSearch() {
    await queryClient.cancelQueries({ queryKey: ['source-search'] });
    queryClient.removeQueries({ queryKey: ['source-search'] });
    setSubmittedSourceQuery('');
  }
  const addSearchResult = useMutation({
    mutationFn: (result: { title: string; summary: string; url: string | null }) => api.createWorkItem({ title: result.title.replace(/^[^·]+ · /, ''), description: result.summary, projectName: defaultProjectName || null, status: 'backlog', dueDate: null, sourceUrl: result.url, workspacePath: null, classificationKind }),
    onSuccess: async ({ item }) => {
      toast.success('Task added to queue.', { description: item.title });
      await closeBeforeShowingCreatedTask();
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
      onCreated(item);
    },
    onError: (error) => toastError('Could not add the task from search.', error),
  });
  const resolveLink = useMutation({
    mutationFn: api.resolveSourceUrl,
    onSuccess: ({ draft }) => { setTitle(draft.title); setDescription(draft.description); setSourceUrl(draft.sourceUrl); },
  });
  const generateDraft = useMutation({
    mutationFn: api.generateTaskDraft,
    onSuccess: ({ draft }) => {
      setTitle(draft.title); setDescription(draft.description); setProjectName(defaultProjectName || draft.projectName || ''); setAiDraftReady(true);
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const attachments = await Promise.all(files.map(async (file) => ({
      name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
      dataBase64: await new Promise<string>((resolveValue, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolveValue(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file); }),
    })));
    createManual.mutate({
      title,
      description,
      projectName: projectName || null,
      status: 'backlog',
      dueDate: null,
      sourceUrl: sourceUrl || null,
      workspacePath: null,
      classificationKind,
      attachments,
    });
  }

  return (
    <ModalDialog className="add-task-dialog" labelledBy="create-task-dialog-title" onClose={onClose}>
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Add to queue</span>
            <h2 id="create-task-dialog-title">Choose your next task</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="task-mode-tabs four-tabs" role="group" aria-label="Task creation mode">
          <button type="button" className={mode === 'search' ? 'active' : ''} aria-pressed={mode === 'search'} onClick={() => setMode('search')}><Search size={14} /> From search</button>
          <button type="button" className={mode === 'link' ? 'active' : ''} aria-pressed={mode === 'link'} onClick={() => setMode('link')}><ArrowUpRight size={14} /> Paste link</button>
          <button type="button" className={mode === 'ai' ? 'active' : ''} aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}><Sparkles size={14} /> Describe to AI</button>
          <button type="button" className={mode === 'manual' ? 'active' : ''} aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}><Plus size={14} /> Manual task</button>
        </div>

        {mode === 'search' ? (
          <div className="linear-picker">
            <form className="linear-search" onSubmit={(event) => { event.preventDefault(); void startSourceSearch(); }}><Search size={16} /><input autoFocus value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} placeholder="Search Linear, Slack, Atlassian, and GitHub…" />{searchIsFetching && <button type="button" className="button secondary compact" onClick={() => void cancelSourceSearch()}>Cancel</button>}<button className="button primary compact" disabled={sourceQuery.trim().length < 2}>Search</button></form>
            {taskTypeField}
            <div className="linear-results">
              {submittedSourceQuery && <div className="source-search-progress">{searchedSources.map((source, index) => <span key={source} className={sourceSearches[index].isFetching ? 'searching' : sourceSearches[index].data || sourceSearches[index].error ? 'done' : ''}>{sourceSearches[index].isFetching && <LoaderCircle className="spin" size={10} />}{source}</span>)}</div>}
              {sourceSearches.map((search, index) => search.error ? <p key={searchedSources[index]} className="source-search-error"><strong>{searchedSources[index]}</strong> · {search.error.message}</p> : search.data ? Object.entries(search.data.errors).map(([source, error]) => <p key={source} className="source-search-error"><strong>{source}</strong> · {error}</p>) : null)}
              {!searchIsFetching && submittedSourceQuery.length >= 2 && searchResults.length === 0 && (
                <div className="list-state compact-state">No matching work found.</div>
              )}
              {searchResults.map((result, index) => (
                <button className="linear-result" key={`${result.source}-${result.url ?? index}`} onClick={() => addSearchResult.mutate(result)} disabled={addSearchResult.isPending}>
                  <span className="source-result-badge">{result.source}</span>
                  <span className="source-result-copy"><strong>{result.title}</strong><small>{result.summary}</small></span>
                  <span className="add-result">Add</span>
                </button>
              ))}
            </div>
          </div>
        ) : mode === 'link' ? (
          <form onSubmit={submit}>
            <label>Source URL<div className="resolve-row"><input autoFocus value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="Slack, GitHub, Linear, Confluence, or Gmail URL" /><button type="button" className="button secondary" onClick={() => resolveLink.mutate(sourceUrl)} disabled={!sourceUrl || resolveLink.isPending}>{resolveLink.isPending ? <LoaderCircle className="spin" size={14} /> : 'Resolve'}</button></div></label>
            <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Generated from the source" /></label>
            <label>Description<MarkdownComposer conversationId="create-task-link" value={description} onChange={setDescription} placeholder="Generated description remains editable" ariaLabel="Task description" /></label>{taskTypeField}{attachmentField}
            {resolveLink.error && <p className="error-message">{resolveLink.error.message}</p>}
            <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!title.trim() || createManual.isPending}><Plus size={16} /> Add to stack</button></div>
          </form>
        ) : mode === 'ai' ? (
          <form onSubmit={submit} className="ai-task-form">
            {!aiDraftReady ? <>
              <label>Describe the task<MarkdownComposer conversationId="create-task-prompt" value={aiPrompt} onChange={setAiPrompt} placeholder="Paste rough notes, links, constraints, or the outcome you want…" ariaLabel="Describe the task" autoFocus /></label>
              <p className="ai-draft-help">AI will turn this into one self-contained, executable task. You can edit everything before adding it.</p>
              {generateDraft.error && <p className="error-message">{generateDraft.error.message}</p>}
              <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={() => generateDraft.mutate(aiPrompt)} disabled={aiPrompt.trim().length < 3 || generateDraft.isPending}>{generateDraft.isPending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} {generateDraft.isPending ? 'Writing task…' : 'Create draft'}</button></div>
            </> : <>
              <div className="ai-draft-banner"><Sparkles size={14} /><span><strong>AI draft</strong><small>Review and edit before adding it to the stack.</small></span><button type="button" onClick={() => setAiDraftReady(false)}>Start over</button></div>
              <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <label>Description<MarkdownComposer conversationId="create-task-ai" value={description} onChange={setDescription} placeholder="Task description" ariaLabel="Task description" /></label>
              <ProjectField value={projectName} onChange={setProjectName} placeholder="Optional" />{taskTypeField}{attachmentField}
              {createManual.error && <p className="error-message">{createManual.error.message}</p>}
              <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setAiDraftReady(false)}>Back</button><button className="button primary" disabled={!title.trim() || createManual.isPending}><Plus size={16} /> Add to stack</button></div>
            </>}
          </form>
        ) : (
          <form onSubmit={submit}>
            <label>
              Title
              <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to happen?" />
            </label>
            <label>
              Description
              <MarkdownComposer conversationId="create-task-manual" value={description} onChange={setDescription} placeholder="Notes, constraints, links…" ariaLabel="Task description" />
            </label>
            <ProjectField value={projectName} onChange={setProjectName} />
            {taskTypeField}{attachmentField}
            {createManual.error && <p className="error-message">{createManual.error.message}</p>}
            <div className="dialog-actions">
              <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
              <button className="button primary" disabled={!title.trim() || createManual.isPending}>
                {createManual.isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                Add to queue
              </button>
            </div>
          </form>
        )}
    </ModalDialog>
  );
}
