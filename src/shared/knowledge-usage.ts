import { projectKey } from './project-name.js';

/** A project is "active" when it had a run inside this many days. */
export const KNOWLEDGE_GAP_WINDOW_DAYS = 14;
export const KNOWLEDGE_RANK_LIMIT = 10;

/** Shown in the panel header and returned by the endpoint so neither can drift. */
export const KNOWLEDGE_USAGE_NOTICE = 'These counts show what is being found. They are never used to prune or archive knowledge.';

export interface KnowledgeUsageCount {
  entryId: string;
  retrievals: number;
  citations: number;
}

export interface KnowledgeEntryRank { entryId: string; file: string; retrievals: number; citations: number }
export interface KnowledgeFileRank { file: string; retrievals: number; citations: number }

export interface KnowledgeGap {
  project: string;
  runs: number;
  /** The matching knowledge file, or null when no file matches the project. */
  file: string | null;
  reason: 'no_file' | 'not_retrieved';
}

export interface KnowledgeUsageReport {
  generatedAt: string;
  windowDays: number;
  notice: string;
  topRetrieved: KnowledgeEntryRank[];
  topCited: KnowledgeEntryRank[];
  topFiles: KnowledgeFileRank[];
  gaps: KnowledgeGap[];
}

export interface ActiveProjectRuns { project: string; runs: number }

/**
 * Entry ids come in two shapes: retrievals are `doc:<root>:<path>[#N]` and
 * citations are `<file>.md#N`. Both reduce to the file's base name.
 */
export function knowledgeFileOfEntry(entryId: string): string | null {
  const path = entryId.startsWith('doc:') ? entryId.slice(4).replace(/^[^:/]*:/, '') : entryId;
  const file = path.split('#')[0].split('/').pop() ?? '';
  return file.endsWith('.md') ? file : null;
}

/** `workbench-product-decisions.md` matches project `Workbench`: its key is a whole hyphen-delimited prefix. */
export function fileMatchesProject(file: string, project: string): boolean {
  const key = projectKey(project);
  if (!key) return false;
  const segments = file.replace(/\.md$/, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return segments.some((_, index) => segments.slice(0, index + 1).join('') === key);
}

function byUse(a: { retrievals: number; citations: number }, b: { retrievals: number; citations: number }): number {
  return b.retrievals + b.citations - (a.retrievals + a.citations);
}

export function buildKnowledgeUsage(input: {
  now: string;
  /** Lifetime counts per entry id, for the rankings. */
  usage: KnowledgeUsageCount[];
  /** Knowledge file base names that exist (indexed), for gap matching. */
  knownFiles: string[];
  /** Retrieval counts per file inside the window, for gap detection. */
  recentRetrievalsByFile: Map<string, number>;
  activeProjects: ActiveProjectRuns[];
}): KnowledgeUsageReport {
  const entries: KnowledgeEntryRank[] = [];
  const files = new Map<string, KnowledgeFileRank>();
  for (const row of input.usage) {
    const file = knowledgeFileOfEntry(row.entryId);
    if (!file) continue;
    entries.push({ entryId: row.entryId, file, retrievals: row.retrievals, citations: row.citations });
    const total = files.get(file) ?? { file, retrievals: 0, citations: 0 };
    total.retrievals += row.retrievals;
    total.citations += row.citations;
    files.set(file, total);
  }
  const top = <T extends { retrievals: number; citations: number }>(rows: T[], key: 'retrievals' | 'citations') =>
    rows.filter((row) => row[key] > 0).sort((a, b) => b[key] - a[key] || byUse(a, b)).slice(0, KNOWLEDGE_RANK_LIMIT);

  const gaps: KnowledgeGap[] = [];
  for (const { project, runs } of input.activeProjects) {
    const matching = input.knownFiles.filter((file) => fileMatchesProject(file, project));
    if (!matching.length) {
      gaps.push({ project, runs, file: null, reason: 'no_file' });
      continue;
    }
    if (matching.some((file) => (input.recentRetrievalsByFile.get(file) ?? 0) > 0)) continue;
    gaps.push({ project, runs, file: [...matching].sort()[0], reason: 'not_retrieved' });
  }
  gaps.sort((a, b) => b.runs - a.runs || a.project.localeCompare(b.project));

  return {
    generatedAt: input.now,
    windowDays: KNOWLEDGE_GAP_WINDOW_DAYS,
    notice: KNOWLEDGE_USAGE_NOTICE,
    topRetrieved: top(entries, 'retrievals'),
    topCited: top(entries, 'citations'),
    topFiles: [...files.values()].sort(byUse).slice(0, KNOWLEDGE_RANK_LIMIT),
    gaps,
  };
}
