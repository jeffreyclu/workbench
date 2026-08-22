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
  project: { name: string } | null;
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
    project { name }
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
      project { name }
      labels { nodes { name } }
      team { id name }
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

export class LinearProvider {
  constructor(
    private readonly apiKey: string,
    private readonly teamIds: string[] = [],
    private readonly projectIds: string[] = [],
    private readonly fetchImpl: typeof fetch = createOutboundFetch('linear-api'),
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.apiKey) throw new Error('LINEAR_API_KEY is not configured.');
    const response = await this.fetchImpl('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
    if (!response.ok) throw new Error(`Linear returned ${response.status}.`);
    if (!payload.data) throw new Error('Linear returned no data.');
    return payload.data;
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
