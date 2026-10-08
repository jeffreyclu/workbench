import { matchesGlob } from 'node:path';
import type { AgentRunReviewDispatch } from '../shared/review-dispatch.js';
import type { ChangedFileStat } from './run-worktree.js';

/**
 * Path globs that decide review dispatch, matched against lower-cased,
 * repository-relative paths. Jeffrey's rule: review is required when a change
 * is multi-file, touches a shared component or public API, or involves auth,
 * authorization, data, or migrations; it is skipped for isolated
 * low-blast-radius edits.
 */
export const REVIEW_DISPATCH_PATHS = {
  /** Any hit makes the review ALWAYS and the tier sensitive. */
  sensitive: {
    auth: ['**/auth/**', '**/auth.*', '**/*-auth.*', '**/*-auth-*', '**/*oauth*', '**/*authentication*', '**/security/**', '**/*-security.*'],
    authorization: ['**/*authorization*', '**/*authz*', '**/*permission*', '**/*rbac*', '**/*access-control*'],
    data: ['**/database.*', '**/repository.*', '**/repositories/**', '**/unit-of-work.*', '**/*.sql', '**/db/**', '**/schema.prisma'],
    migrations: ['**/migrations/**', '**/*migration*'],
    secrets: ['**/.env', '**/.env.*', '**/*secret*', '**/*credential*', '**/*.pem', '**/*.key'],
  },
  /** Shared components and public API: ALWAYS, standard tier. */
  sharedOrPublicApi: ['src/shared/**', '**/contracts.*', '**/routes/**', '**/api/**', '**/*.d.ts', '**/openapi.*', '**/*mcp*', 'src/client/components/**'],
  /** A change made only of these is NEVER reviewed. */
  docs: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.txt', 'docs/**', '**/license*'],
} as const;

/** A single-file change below this many added plus removed lines is a
 * single-value edit and is NEVER reviewed. */
export const SMALL_CHANGE_LINE_LIMIT = 10;

export type ReviewDispatchDecision = Pick<AgentRunReviewDispatch, 'mode' | 'tier' | 'reason' | 'files' | 'changedLines'>;

const MAX_REASON_PATHS = 3;

function matches(path: string, globs: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return globs.some((glob) => matchesGlob(normalized, glob));
}

function namePaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_REASON_PATHS).join(', ');
  return paths.length > MAX_REASON_PATHS ? `${shown} and ${paths.length - MAX_REASON_PATHS} more` : shown;
}

function changedLines(files: ChangedFileStat[]): number | null {
  let total = 0;
  for (const file of files) {
    if (file.added === null || file.removed === null) return null;
    total += file.added + file.removed;
  }
  return total;
}

/**
 * Decides whether a completed change gets a review, and how deep. Pure: the
 * caller supplies the changed files, and nothing here reads Git or the
 * database. Returns null when there is no change to decide about.
 */
export function classifyReviewDispatch(changes: ChangedFileStat[]): ReviewDispatchDecision | null {
  const byPath = new Map<string, ChangedFileStat>();
  for (const change of changes) if (change.path.trim()) byPath.set(change.path, change);
  const unique = [...byPath.values()];
  if (!unique.length) return null;
  const files = unique.map((file) => file.path);
  const lines = changedLines(unique);
  const decide = (mode: ReviewDispatchDecision['mode'], tier: ReviewDispatchDecision['tier'], reason: string): ReviewDispatchDecision => ({ mode, tier, reason, files, changedLines: lines });

  const sensitive = Object.entries(REVIEW_DISPATCH_PATHS.sensitive)
    .map(([category, globs]) => ({ category, paths: files.filter((path) => matches(path, globs)) }))
    .filter((hit) => hit.paths.length);
  if (sensitive.length) return decide('always', 'sensitive', `it touches ${sensitive.map((hit) => `${hit.category} (${namePaths(hit.paths)})`).join('; ')}`);

  if (files.every((path) => matches(path, REVIEW_DISPATCH_PATHS.docs))) return decide('never', 'trivial', `it is a docs-only change (${namePaths(files)})`);

  const shared = files.filter((path) => matches(path, REVIEW_DISPATCH_PATHS.sharedOrPublicApi));
  const reasons = [
    ...(files.length > 1 ? [`it is a multi-file change (${files.length} files)`] : []),
    ...(shared.length ? [`it touches a shared component or public API (${namePaths(shared)})`] : []),
  ];
  if (reasons.length) return decide('always', 'standard', reasons.join('; '));

  if (lines !== null && lines < SMALL_CHANGE_LINE_LIMIT) return decide('never', 'trivial', `it is a single-file change of ${lines} line${lines === 1 ? '' : 's'} (${files[0]})`);
  return decide('judgment', 'standard', lines === null
    ? `it is a single-file change whose line count is unavailable (${files[0]})`
    : `it is a single-file change of ${lines} lines (${files[0]}), at or over the ${SMALL_CHANGE_LINE_LIMIT}-line limit`);
}
