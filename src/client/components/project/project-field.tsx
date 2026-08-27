import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import type { ProjectSummary } from '../../../shared/contracts';
import { matchProjectKey, projectKey } from '../../../shared/project-name';
import { api } from '../../data/api';
import { ProjectColorDot } from './project-color';

/**
 * The canonical project vocabulary. Shared by every project picker so opening a
 * second one costs nothing, and cheap enough to keep fresh: the list only
 * changes when a project is used.
 */
function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: api.getProjects, staleTime: 60_000 });
}

type ProjectOutcome =
  | { kind: 'none' }
  | { kind: 'known'; project: ProjectSummary }
  | { kind: 'resolves'; project: ProjectSummary }
  | { kind: 'new' };

/**
 * What the server will do with the typed name, decided with the same rules the
 * server uses. This is a preview, not the decision — the server resolves again
 * on write — but it means Jeffrey can see that `wkbnch` is about to join
 * Workbench instead of discovering it afterwards.
 */
function resolveProjectPreview(value: string, projects: ProjectSummary[]): ProjectOutcome {
  const key = projectKey(value);
  if (!key) return { kind: 'none' };
  const exact = projects.find((project) => project.key === key);
  if (exact) return exact.name === value.trim() ? { kind: 'known', project: exact } : { kind: 'resolves', project: exact };
  const matchedKey = matchProjectKey(key, projects.map((project) => project.key));
  const matched = matchedKey ? projects.find((project) => project.key === matchedKey) : undefined;
  return matched ? { kind: 'resolves', project: matched } : { kind: 'new' };
}

/**
 * Picks a project without typing one. The recent chips cover the everyday case
 * in a single tap, the datalist autocompletes the rest, and free text still
 * works — it is just no longer the only way in.
 */
export function ProjectField({
  value,
  onChange,
  label = 'Project',
  placeholder = 'Personal',
  autoFocus = false,
  suggestionLimit = 6,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  suggestionLimit?: number;
}) {
  const listId = useId();
  const projectsQuery = useProjects();
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const suggestions = useMemo(() => projects.slice(0, suggestionLimit), [projects, suggestionLimit]);
  const outcome = useMemo(() => resolveProjectPreview(value, projects), [value, projects]);
  const selectedKey = projectKey(value);

  return (
    <div className="project-field">
      <label>
        {label}
        <input
          value={value}
          list={listId}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={outcome.kind === 'resolves' || outcome.kind === 'new' ? `${listId}-outcome` : undefined}
        />
      </label>
      <datalist id={listId}>
        {projects.map((project) => <option key={project.id} value={project.name} />)}
      </datalist>
      <ProjectSuggestions projects={suggestions} selectedKey={selectedKey} onPick={onChange} />
      {outcome.kind === 'resolves' && (
        <p className="project-outcome" id={`${listId}-outcome`}>Joins <strong>{outcome.project.name}</strong>.</p>
      )}
      {outcome.kind === 'new' && (
        <p className="project-outcome new" id={`${listId}-outcome`}>Creates a new project.</p>
      )}
    </div>
  );
}

function ProjectSuggestions({ projects, selectedKey, onPick }: { projects: ProjectSummary[]; selectedKey: string; onPick: (name: string) => void }) {
  if (!projects.length) return null;
  return (
    <div className="project-suggestions" role="group" aria-label="Recent projects">
      {projects.map((project) => {
        const active = project.key === selectedKey;
        return (
          <button
            key={project.id}
            type="button"
            className={`project-suggestion ${active ? 'active' : ''}`}
            aria-pressed={active}
            // Keep focus in the text field. The inline editor commits on blur,
            // and stealing focus here would commit the old value first and
            // throw the tap away.
            onMouseDown={(event) => event.preventDefault()}
            // Tapping the active chip clears it, so a mis-tap is undoable
            // without reaching for the text field.
            onClick={() => onPick(active ? '' : project.name)}
          >
            <ProjectColorDot projectName={project.name} />
            {project.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The task-detail version: same vocabulary, but it owns its draft and commits
 * on Enter, on blur, or the moment a chip is tapped, matching the other inline
 * editors on that screen.
 */
export function InlineProjectEditor({
  initialValue,
  onCommit,
  onCancel,
  suggestionLimit = 6,
}: {
  initialValue: string;
  onCommit: (projectName: string | null) => void;
  onCancel: () => void;
  suggestionLimit?: number;
}) {
  const listId = useId();
  const [value, setValue] = useState(initialValue);
  const projectsQuery = useProjects();
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const suggestions = useMemo(() => projects.slice(0, suggestionLimit), [projects, suggestionLimit]);

  return (
    <div className="project-field inline">
      <input
        className="inline-project-editor"
        autoFocus
        value={value}
        list={listId}
        maxLength={200}
        placeholder="No project"
        aria-label="Project"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => onCommit(value.trim() || null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit(value.trim() || null);
          if (event.key === 'Escape') onCancel();
        }}
      />
      <datalist id={listId}>
        {projects.map((project) => <option key={project.id} value={project.name} />)}
      </datalist>
      <ProjectSuggestions projects={suggestions} selectedKey={projectKey(value)} onPick={(name) => onCommit(name || null)} />
    </div>
  );
}
