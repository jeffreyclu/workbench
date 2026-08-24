import { randomUUID } from 'node:crypto';

import { matchProjectKey, projectKey } from '../shared/project-name.js';
import type { ProjectSummary } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';

/**
 * The canonical project vocabulary. Every project name Workbench has ever
 * accepted lives in `projects`; every spelling that resolved to one lives in
 * `project_aliases`.
 *
 * The point of the registry is that nobody has to type a project name
 * accurately, or at all. `resolveProjectName` is the single choke point every
 * write passes through, so a task created from the UI, from an AI draft, from
 * an MCP tool call, or from a Linear sync all end up carrying the same spelling
 * of the same project.
 *
 * Aliases make that learned rather than re-derived: the first time `wkbnch`
 * fuzzily resolves to `Workbench` it is recorded, and every later `wkbnch` is
 * an exact lookup that no threshold change can reinterpret.
 */

export interface ResolvedProject {
  /** The canonical display name. Callers write this to `work_items.project_name`. */
  name: string;
  /** The comparison key, or `null` for a name with no alphanumeric content. */
  key: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  key: string;
}

export interface ResolveProjectOptions {
  /**
   * Whether to forgive typos. On for names Jeffrey or an agent authored, where
   * a near-miss is almost always a mistake. Off for Linear, whose project names
   * are authoritative — two similar Linear projects are two real projects, and
   * merging them would misrepresent the provider.
   */
  fuzzy: boolean;
  now?: string;
}

/**
 * Resolves a free-text project name to its canonical spelling, registering it
 * the first time it is seen. Returns `null` for a blank name, which callers
 * store as "no project".
 */
export function resolveProjectName(
  database: WorkbenchDatabase,
  rawName: string | null | undefined,
  options: ResolveProjectOptions,
): ResolvedProject | null {
  const name = rawName?.trim() ?? '';
  if (!name) return null;
  const key = projectKey(name);
  // Punctuation-only names have no comparison identity, so they are stored as
  // typed and never registered. Keeping them out of the vocabulary stops them
  // becoming a fuzzy-match target for everything else.
  if (!key) return { name, key: null };

  const now = options.now ?? new Date().toISOString();
  const existing = lookupByKey(database, key);
  if (existing) {
    touchProject(database, existing.id, now);
    return { name: existing.name, key: existing.key };
  }

  if (options.fuzzy) {
    const knownKeys = (database.prepare('SELECT key FROM projects').all() as unknown as Array<{ key: string }>).map((row) => row.key);
    const matched = matchProjectKey(key, knownKeys);
    if (matched) {
      const project = lookupByKey(database, matched)!;
      database
        .prepare('INSERT OR IGNORE INTO project_aliases (alias_key, alias_text, project_id, created_at) VALUES (?, ?, ?, ?)')
        .run(key, name, project.id, now);
      touchProject(database, project.id, now);
      return { name: project.name, key: project.key };
    }
  }

  const id = randomUUID();
  database
    .prepare('INSERT INTO projects (id, name, key, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, key, now, now, now);
  return { name, key };
}

function lookupByKey(database: WorkbenchDatabase, key: string): ProjectRow | null {
  const direct = database.prepare('SELECT id, name, key FROM projects WHERE key = ?').get(key) as ProjectRow | undefined;
  if (direct) return direct;
  const aliased = database
    .prepare('SELECT projects.id AS id, projects.name AS name, projects.key AS key FROM project_aliases JOIN projects ON projects.id = project_aliases.project_id WHERE project_aliases.alias_key = ?')
    .get(key) as ProjectRow | undefined;
  return aliased ?? null;
}

function touchProject(database: WorkbenchDatabase, id: string, now: string): void {
  database.prepare('UPDATE projects SET last_used_at = ? WHERE id = ?').run(now, id);
}

/**
 * The picker's vocabulary, most-used first. Counts cover live tasks only, so a
 * project whose work is all archived sinks rather than disappearing — it is
 * still a name Jeffrey can pick and still resolves on write.
 */
export function listProjects(database: WorkbenchDatabase): ProjectSummary[] {
  const rows = database
    .prepare(`
      SELECT projects.id AS id, projects.name AS name, projects.key AS key, projects.last_used_at AS last_used_at,
        (SELECT COUNT(*) FROM work_items
          WHERE work_items.deleted_at IS NULL AND work_items.archived_at IS NULL
            AND work_items.project_key = projects.key) AS task_count
      FROM projects
      ORDER BY task_count DESC, projects.last_used_at DESC, projects.name ASC
    `)
    .all() as unknown as Array<{ id: string; name: string; key: string; last_used_at: string | null; task_count: number }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    key: row.key,
    taskCount: Number(row.task_count ?? 0),
    lastUsedAt: row.last_used_at,
  }));
}
