import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../../data/api';
import { ModalDialog } from '../../components/dialogs/modal-dialog';
import { useDebouncedValue } from '../conversation/hooks';
import { commandsForMode, rankCommands, splitPath, wrapIndex, type PaletteCommand, type PaletteMode } from './logic';
import { usePalette } from './registry';

const TITLES: Record<PaletteMode, { label: string; placeholder: string }> = {
  commands: { label: 'Command palette', placeholder: 'Type a command or search…' },
  switcher: { label: 'Quick switcher', placeholder: 'Go to a file, task, or conversation…' },
};

/** Tasks and conversations are server data; they load only while the palette is open. */
function useRecordCommands(open: boolean, query: string, onOpenTask: (id: string) => void, onOpenConversation: (id: string) => void) {
  const search = useDebouncedValue(query.trim(), 200);
  const tasks = useQuery({
    queryKey: ['command-palette-tasks', search],
    queryFn: async () => {
      const [attention, workbench] = await Promise.all([api.listWorkItems('active', search), api.listWorkItems('workbench', search)]);
      // A task can sit in both stacks' results; the list needs one row per task.
      return [...new Map([...attention.items, ...workbench.items].map((task) => [task.id, task])).values()];
    },
    enabled: open,
    staleTime: 15_000,
  });
  const conversations = useQuery({
    queryKey: ['command-palette-conversations'],
    queryFn: () => api.listSharedConversations('active'),
    enabled: open,
    staleTime: 15_000,
  });
  const commands = useMemo<PaletteCommand[]>(() => [
    ...(tasks.data ?? []).map((task) => ({ id: `task:${task.id}`, group: 'Tasks' as const, label: task.title, detail: task.projectName ?? undefined, run: () => onOpenTask(task.id) })),
    ...(conversations.data?.conversations ?? []).map((conversation) => ({ id: `conversation:${conversation.id}`, group: 'Conversations' as const, label: conversation.title || 'Untitled conversation', detail: conversation.linkedProjectName ?? undefined, run: () => onOpenConversation(conversation.id) })),
  ], [conversations.data, onOpenConversation, onOpenTask, tasks.data]);
  return { commands, loading: tasks.isPending || conversations.isPending, failed: tasks.isError || conversations.isError };
}

function PaletteRow({ command, index, active, onChoose, onHover }: { command: PaletteCommand; index: number; active: boolean; onChoose: () => void; onHover: () => void }) {
  const rowRef = useRef<HTMLLIElement>(null);
  // Arrow keys can move the highlight past the visible rows.
  useEffect(() => { if (active) rowRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  const file = command.group === 'Files' ? splitPath(command.label) : null;
  return (
    <li ref={rowRef} id={`command-palette-option-${index}`} role="option" aria-selected={active} className={`command-palette-option ${active ? 'is-active' : ''}`} onMouseMove={onHover} onClick={onChoose}>
      <span className="command-palette-group">{command.group}</span>
      <span className="command-palette-text">
        <strong>{file ? file.name : command.label}</strong>
        {(file ? file.directory : command.detail) && <small>{file ? file.directory : command.detail}</small>}
      </span>
      {command.shortcut && <kbd>{command.shortcut}</kbd>}
    </li>
  );
}

export function CommandPalette({ onOpenTask, onOpenConversation }: { onOpenTask: (id: string) => void; onOpenConversation: (id: string) => void }) {
  const { open } = usePalette();
  return open ? <CommandPaletteDialog onOpenTask={onOpenTask} onOpenConversation={onOpenConversation} /> : null;
}

function CommandPaletteDialog({ onOpenTask, onOpenConversation }: { onOpenTask: (id: string) => void; onOpenConversation: (id: string) => void }) {
  const { mode, commands: registered, close } = usePalette();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const records = useRecordCommands(true, query, onOpenTask, onOpenConversation);
  const results = useMemo(() => rankCommands(commandsForMode([...registered, ...records.commands], mode), query), [mode, query, records.commands, registered]);
  const active = results[wrapIndex(activeIndex, results.length)];
  const activeOptionId = active ? `command-palette-option-${results.indexOf(active)}` : undefined;

  function choose(command: PaletteCommand) {
    close();
    command.run();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(wrapIndex(activeIndex + (event.key === 'ArrowDown' ? 1 : -1), results.length));
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      choose(active);
    }
  }

  const title = TITLES[mode];
  return (
    <ModalDialog className="command-palette" backdropClassName="command-palette-backdrop" label={title.label} onClose={close}>
      <div className="command-palette-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-label={title.label}
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={title.placeholder}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={handleKeyDown}
        />
      </div>
      <ul id="command-palette-results" role="listbox" aria-label={`${title.label} results`} className="command-palette-results">
        {results.map((command, index) => (
          <PaletteRow key={command.id} command={command} index={index} active={command === active} onChoose={() => choose(command)} onHover={() => setActiveIndex(index)} />
        ))}
      </ul>
      <div className="command-palette-status" role="status">
        {results.length === 0 && (records.loading ? 'Loading…' : `No matches${query.trim() ? ` for “${query.trim()}”` : ''}.`)}
        {results.length > 0 && records.failed && 'Some tasks or conversations could not be loaded.'}
      </div>
    </ModalDialog>
  );
}
