import type { LinearTeam, WorkItemStatus } from '../../shared/contracts.js';
import type { ProviderWorkItem } from '../repository.js';
import { createOutboundFetch } from '../outbound-policy.js';

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string;
  dueDate: string | null;
  updatedAt: string;
  state: { type: string; name: string };
  project: { id: string; name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  team: { id: string; name: string };
}

interface LinearResponse {
  data?: {
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

type LinearIssuesData = NonNullable<LinearResponse['data']>;

const issueFields = `
  nodes {
    id identifier title description priority url dueDate updatedAt
    state { type name }
    project { id name }
    labels { nodes { name } }
    team { id name }
  }
  pageInfo { hasNextPage endCursor }
`;

const allIssuesQuery = `
  query WorkbenchIssues($after: String) {
    issues(
      first: 100
      after: $after
      orderBy: updatedAt
    ) { ${issueFields} }
  }
`;

const projectIssuesQuery = `
  query WorkbenchIssues($after: String, $projectIds: [ID!]) {
    issues(
      first: 100
      after: $after
      filter: {
        project: { id: { in: $projectIds } }
      }
      orderBy: updatedAt
    ) { ${issueFields} }
  }
`;

const teamIssuesQuery = `
  query WorkbenchIssues($after: String, $teamIds: [ID!]) {
    issues(
      first: 100
      after: $after
      filter: {
        team: { id: { in: $teamIds } }
      }
      orderBy: updatedAt
    ) { ${issueFields} }
  }
`;

const teamsQuery = `
  query WorkbenchTeams {
    teams(first: 100) {
      nodes { id name key }
    }
  }
`;

const issueQuery = `
  query WorkbenchIssue($id: String!) {
    issue(id: $id) {
      id identifier title description priority url dueDate updatedAt
      state { type name }
      project { id name }
      labels { nodes { name } }
      team { id name }
    }
  }
`;

const issueSearchQuery = `
  query WorkbenchIssueSearch($term: String!, $first: Int!, $teamId: String) {
    searchIssues(term: $term, first: $first, teamId: $teamId) { ${issueFields} }
  }
`;

const issueUpdateMutation = `
  mutation WorkbenchUpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id identifier title description priority url dueDate updatedAt
        state { type name }
        project { id name }
        labels { nodes { name } }
        team { id name }
      }
    }
  }
`;

const teamProjectsQuery = `
  query WorkbenchTeamProjects($teamId: String!) {
    team(id: $teamId) {
      projects(first: 100) { nodes { id name state } }
    }
  }
`;

function mapStatus(type: string): WorkItemStatus {
  switch (type) {
    case 'started':
      return 'in_progress';
    case 'completed':
      return 'done';
    case 'canceled':
      return 'canceled';
    case 'unstarted':
      return 'ready';
    default:
      return 'backlog';
  }
}

function mapPriority(priority: number): number {
  // Linear: 0=no priority, 1=urgent, 2=high, 3=normal, 4=low.
  return priority === 0 ? 3 : Math.max(0, priority - 1);
}

function mapIssue(issue: LinearIssue): ProviderWorkItem {
  return {
    sourceIdentifier: issue.identifier,
    sourceUrl: issue.url,
    title: issue.title,
    description: issue.description ?? '',
    status: mapStatus(issue.state.type),
    priority: mapPriority(issue.priority),
    projectName: issue.project?.name ?? issue.team.name,
    labels: issue.labels.nodes.map((label) => label.name),
    dueDate: issue.dueDate,
    providerUpdatedAt: issue.updatedAt,
    providerPayload: issue,
  };
}

const maxRateLimitRetries = 5;
const maxRateLimitDelayMs = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });

export class LinearProvider {
  constructor(
    private readonly apiKey: string,
    private readonly teamIds: string[] = [],
    private readonly projectIds: string[] = [],
    private readonly fetchImpl: typeof fetch = createOutboundFetch('linear-api'),
    private readonly sleepImpl: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!this.apiKey) throw new Error('LINEAR_API_KEY is not configured.');

    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal,
      });

      if (response.status === 429) {
        if (attempt >= maxRateLimitRetries) {
          throw new Error(`Linear rate limit exceeded after ${attempt + 1} attempts. Try again later.`);
        }
        // Same exponential-backoff-with-jitter shape as the realtime websocket
        // reconnect in src/client/hooks/realtime.ts, so both surfaces back off
        // against Linear/the app server the same way.
        const delay = Math.min(maxRateLimitDelayMs, 1_000 * 2 ** attempt);
        const jitter = Math.round(delay * (0.2 * Math.random()));
        await this.sleepImpl(delay + jitter);
        continue;
      }

      const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403 ? 'auth failure' : 'request failure';
        throw new Error(`Linear returned ${response.status} (${reason}).`);
      }
      if (!payload.data) throw new Error('Linear returned no data.');
      return payload.data;
    }
  }

  async fetchTeams(): Promise<LinearTeam[]> {
    const data = await this.request<{ teams: { nodes: Array<Omit<LinearTeam, 'projects'>> } }>(teamsQuery);
    return data.teams.nodes
      .map((team) => ({ ...team, projects: [] }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async fetchTeamProjects(teamId: string): Promise<LinearTeam['projects']> {
    const data = await this.request<{ team: { projects: { nodes: LinearTeam['projects'] } } }>(
      teamProjectsQuery,
      { teamId },
    );
    return data.team.projects.nodes.sort((left, right) => left.name.localeCompare(right.name));
  }

  async fetchIssue(identifier: string): Promise<ProviderWorkItem> {
    const data = await this.request<{ issue: LinearIssue }>(issueQuery, { id: identifier });
    return mapIssue(data.issue);
  }

  async updateIssue(identifier: string, input: { title?: string; description?: string }): Promise<ProviderWorkItem> {
    const data = await this.request<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(issueUpdateMutation, { id: identifier, input });
    if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error(`Linear did not update ${identifier}.`);
    return mapIssue(data.issueUpdate.issue);
  }

  /**
   * Search Linear at request time. This is a current lookup, not a workspace
   * sync; configured teams/projects still constrain the returned results.
   */
  async searchIssues(query: string, first = 20, signal?: AbortSignal): Promise<ProviderWorkItem[]> {
    // searchIssues only accepts one team ID and has no project filter. Ask for
    // enough matches to apply a project scope locally without downloading the
    // whole catalog, then keep the picker response bounded.
    const teamId = this.teamIds.length === 1 ? this.teamIds[0] : undefined;
    const data = await this.request<{ searchIssues: { nodes: LinearIssue[] } }>(issueSearchQuery, { term: query, first: this.projectIds.length > 0 ? 100 : first, teamId }, signal);
    return data.searchIssues.nodes
      .filter((issue) => this.teamIds.length === 0 || this.teamIds.includes(issue.team.id))
      .filter((issue) => this.projectIds.length === 0 || (issue.project !== null && this.projectIds.includes(issue.project.id)))
      .slice(0, first)
      .map(mapIssue);
  }

  async fetchOpenIssues(): Promise<ProviderWorkItem[]> {
    const results: ProviderWorkItem[] = [];
    let cursor: string | null = null;

    do {
      const activeQuery = this.projectIds.length > 0
        ? projectIssuesQuery
        : this.teamIds.length > 0
          ? teamIssuesQuery
          : allIssuesQuery;
      const variables = this.projectIds.length > 0
        ? { after: cursor, projectIds: this.projectIds }
        : this.teamIds.length > 0
          ? { after: cursor, teamIds: this.teamIds }
          : { after: cursor };
      const payload: LinearIssuesData = await this.request<LinearIssuesData>(activeQuery, variables);

      for (const issue of payload.issues.nodes) {
        results.push(mapIssue(issue));
      }

      cursor = payload.issues.pageInfo.hasNextPage
        ? payload.issues.pageInfo.endCursor
        : null;
    } while (cursor);

    return results;
  }
}
