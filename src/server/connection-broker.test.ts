import { describe, expect, it, vi } from 'vitest';

const { fetchIssue, searchIssues } = vi.hoisted(() => ({ fetchIssue: vi.fn(), searchIssues: vi.fn() }));

vi.mock('./providers/linear.js', () => ({
  LinearProvider: class {
    fetchIssue = fetchIssue;
    searchIssues = searchIssues;
  },
}));

import { contextForPrompt, listBrokerConnections, searchBrokerSources, sourceQuery } from './connection-broker.js';

describe('Linear connection contract', () => {
  it('advertises the create and update operations Workbench actually exposes', () => {
    const repository = { listSourceConnections: vi.fn().mockReturnValue([]), getSourceSettings: vi.fn().mockReturnValue(null) };
    const linear = listBrokerConnections(repository as never).find((connection) => connection.id === 'linear');
    expect(linear?.capabilities).toEqual(['resolve_links', 'search', 'sync', 'create', 'update']);
  });

  it('routes authorized creation to the mutation tool instead of the read-only search connector', async () => {
    const repository = { searchLinear: vi.fn().mockReturnValue([]), getSourceSettings: vi.fn().mockReturnValue(null) };
    await expect(contextForPrompt(repository as never, 'Create two Linear tickets.')).resolves.toMatch(/call the Workbench `create_linear_issue` tool directly/);
  });
});

describe('sourceQuery', () => {
  it('carries a recent Atlassian URL into a follow-up request', () => {
    const url = 'https://writer.atlassian.net/wiki/spaces/ENG/pages/123/MCP';
    expect(sourceQuery(`summarize the doc for me\n${url}`, 'confluence')).toBe(url);
  });

  it('falls back to text when no provider URL is present', () => {
    expect(sourceQuery('search github for connector gateway', 'github')).toBe('connector gateway');
  });
});

describe('searchBrokerSources', () => {
  it('uses live Linear results and persists them for the New Task search', async () => {
    const providerItem = {
      sourceIdentifier: 'CON-999', sourceUrl: 'https://linear.app/writer/issue/CON-999/example', title: 'Example Linear issue', description: 'Fetched on demand.',
      status: 'ready', priority: 2, projectName: 'Connectors', labels: [], dueDate: null, providerUpdatedAt: '2026-08-25T00:00:00.000Z', providerPayload: {},
    };
    const storedItem = { ...providerItem, id: 'item-1', source: 'linear', isQueued: false, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null, sourceTags: ['Linear'], stack: 'attention', workspacePath: null, strategy: '', assignees: [], blockedBy: [], createdAt: '', updatedAt: '', lastTouchedAt: '' };
    const repository = {
      searchLinear: vi.fn().mockReturnValue([storedItem]),
      upsertLinearItem: vi.fn(),
      getLinearConfig: vi.fn().mockReturnValue({ teamIds: ['team-1'], projectIds: [] }),
    };
    searchIssues.mockResolvedValueOnce([providerItem]);

    await expect(searchBrokerSources(repository as never, 'CON-999', ['linear'])).resolves.toEqual({
      results: [{ source: 'linear', title: 'CON-999 · Example Linear issue', summary: 'Fetched on demand.', url: providerItem.sourceUrl, occurredAt: providerItem.providerUpdatedAt }],
      errors: {},
    });
    expect(searchIssues).toHaveBeenCalledWith('CON-999', 20, undefined);
    expect(fetchIssue).not.toHaveBeenCalled();
    expect(repository.upsertLinearItem).toHaveBeenCalledWith(providerItem);
  });

  it('resolves an identifier beyond the configured sync scope', async () => {
    const providerItem = {
      sourceIdentifier: 'CON-999', sourceUrl: 'https://linear.app/writer/issue/CON-999/example', title: 'Example Linear issue', description: 'Fetched on demand.',
      status: 'ready', priority: 2, projectName: 'Connectors', labels: [], dueDate: null, providerUpdatedAt: '2026-08-25T00:00:00.000Z', providerPayload: {},
    };
    const repository = { searchLinear: vi.fn().mockReturnValue([]), upsertLinearItem: vi.fn(), getLinearConfig: vi.fn().mockReturnValue({ teamIds: ['team-1'], projectIds: [] }) };
    searchIssues.mockResolvedValueOnce([]);
    fetchIssue.mockResolvedValueOnce(providerItem);

    await searchBrokerSources(repository as never, 'CON-999', ['linear']);

    expect(fetchIssue).toHaveBeenCalledWith('CON-999');
    expect(repository.upsertLinearItem).toHaveBeenCalledWith(providerItem);
  });
});
