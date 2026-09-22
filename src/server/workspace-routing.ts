import { basename, resolve } from 'node:path';
import type { WorkItem } from '../shared/contracts.js';

export const ROUTED_REPOSITORIES = ['workbench', 'writer-monorepo', 'fe.web-app', 'be.mcp-gateway'] as const;
export type RoutedRepository = typeof ROUTED_REPOSITORIES[number];

export interface RepositoryRoute {
  repository: RoutedRepository;
  reason: string;
}

export interface RoutedExecutionWorkspace {
  routingWorkspace?: string;
  sourceWorkspace: string;
  worktree: string;
}

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (text: string, repository: RoutedRepository) => new RegExp(`(?:^|[^a-z0-9])${escaped(repository)}(?:$|[^a-z0-9])`, 'i').test(text);

/** Infer code ownership from the whole Linear ticket, not its broad project. */
export function inferTaskRepositories(item: Pick<WorkItem, 'title' | 'description' | 'projectName' | 'sourceUrl'>): RepositoryRoute[] {
  const text = `${item.title}\n${item.description}\n${item.projectName ?? ''}\n${item.sourceUrl ?? ''}`;
  const routes = new Map<RoutedRepository, string>();
  const add = (repository: RoutedRepository, reason: string) => { if (!routes.has(repository)) routes.set(repository, reason); };

  for (const match of text.matchAll(/https?:\/\/github\.com\/[^/\s]+\/([^/\s#?]+)/gi)) {
    const repository = match[1].replace(/\.git$/i, '').toLowerCase() as RoutedRepository;
    if ((ROUTED_REPOSITORIES as readonly string[]).includes(repository)) add(repository, `GitHub URL names ${repository}.`);
  }
  for (const repository of ROUTED_REPOSITORIES) {
    if (named(text, repository) || text.toLowerCase().includes(`/dev/${repository}`)) add(repository, `Ticket text names ${repository}.`);
  }

  if (item.projectName?.toLowerCase() === 'workbench' || /localhost:5180|review director|conversation supervisor|repo explorer|diff viewer/i.test(text)) {
    add('workbench', 'Ticket describes the Workbench product or its local UI.');
  }
  if (/\b(?:ais|ai studio)\b|\bservice\.writer-app\b|\bfe web app rewrite\b/i.test(text)) {
    add('fe.web-app', 'Ticket describes the AI Studio / fe.web-app surface.');
  }
  if (/private[-\s]+endpoint[^\n]*(?:fallback[-\s]+url|custom[-\s]+domain|custom[-\s]+dns|dns[-\s]+name)|(?:fallback[-\s]+url|custom[-\s]+domain|custom[-\s]+dns)[^\n]*private[-\s]+endpoint/i.test(text)) {
    add('fe.web-app', 'Ticket describes the legacy Private Endpoint provisioning UI.');
  }
  if (/\b(?:wa|writer agent)\b|frontend\/src|backend\/mcp_gateway/i.test(text)) {
    add('writer-monorepo', 'Ticket describes the Writer Agent monorepo surface.');
  }
  if (/\bconnector gateway backend\b|\bmcp gateway backend\b|\b(?:elysia|bun)\b|src\/services\/mcp-sync|profile\/user\/service|exchangegrant|tools\.json/i.test(text)) {
    add('be.mcp-gateway', 'Ticket describes Connector Gateway server code.');
  }

  if (routes.size === 0 && item.sourceUrl?.includes('linear.app/') && /\bconnectors?\b/i.test(text)) {
    add('writer-monorepo', 'Connector ticket has no narrower repository marker; Writer Agent is the default surface.');
  }
  return [...routes].map(([repository, reason]) => ({ repository, reason }));
}

/** Resolve inferred ownership only to exact checkout names, never fuzzy clones. */
export function routedWorkspacePaths(
  item: Pick<WorkItem, 'title' | 'description' | 'projectName' | 'sourceUrl'>,
  candidates: readonly string[],
): Array<RepositoryRoute & { path: string }> {
  const byName = new Map(candidates.map((path) => [basename(path).toLowerCase(), resolve(path)]));
  return inferTaskRepositories(item).flatMap((route) => {
    const path = byName.get(route.repository);
    return path ? [{ ...route, path }] : [];
  });
}

export function repositoryRoutingPrompt(
  item: Pick<WorkItem, 'title' | 'description' | 'projectName' | 'sourceUrl'>,
  candidates: readonly string[],
  executionWorkspaces: readonly RoutedExecutionWorkspace[] = [],
): string {
  const routes = routedWorkspacePaths(item, candidates);
  if (!routes.length) return 'Repository routing: no repository could be inferred from the ticket; use the resolved starting workspace and verify ownership before editing.';
  const executionBySource = new Map(executionWorkspaces.map((workspace) => [resolve(workspace.routingWorkspace ?? workspace.sourceWorkspace), resolve(workspace.worktree)]));
  const routedLines = routes.map((route, index) => {
    const executionPath = executionBySource.get(resolve(route.path));
    const path = executionPath && executionPath !== resolve(route.path)
      ? `${executionPath} (isolated worktree for ${route.path})`
      : route.path;
    return `- ${index === 0 ? 'Primary' : 'Also relevant'}: ${path} — ${route.reason}`;
  });
  const hasIsolatedWorkspace = executionWorkspaces.some((workspace) => resolve(workspace.sourceWorkspace) !== resolve(workspace.worktree));
  const isolationRule = hasIsolatedWorkspace
    ? 'Edit only the isolated worktree path listed for each repository. Never edit its source checkout directly.'
    : 'Read-only work may inspect these checkouts. Before any code write, create and use a dedicated worktree under ~/dev for each repository.';
  return `Repository routing from the ticket (also drives Changes):\n${routedLines.join('\n')}\n${isolationRule} Use the primary repository as the starting workspace. If the ticket spans additional repositories listed here, inspect and change them in the same task; do not silently collapse a multi-repository ticket to one checkout. The linked ticket remains authoritative through every follow-up. A request to commit, push, or open a PR means only this ticket's verified changes. If the branch or diff belongs to another ticket, stop and report the mismatch; never rename a branch or replay unrelated commits to make it look aligned.`;
}
