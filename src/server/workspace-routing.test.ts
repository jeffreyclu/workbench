import { describe, expect, it } from 'vitest';
import { inferTaskRepositories, repositoryRoutingPrompt, routedWorkspacePaths } from './workspace-routing.js';

const item = (description: string, extras: Partial<{ title: string; projectName: string | null; sourceUrl: string | null }> = {}) => ({
  title: extras.title ?? 'Implement ticket',
  description,
  projectName: extras.projectName ?? null,
  sourceUrl: extras.sourceUrl ?? 'https://linear.app/writer/issue/CON-999/example',
});

describe('workspace routing', () => {
  it.each([
    [item('Fix the conversation supervisor and diff viewer.', { projectName: 'Workbench' }), 'workbench'],
    [item('Update Writer Agent under frontend/src.'), 'writer-monorepo'],
    [item('Update the AIS service.writer-app page.'), 'fe.web-app'],
    [item('Change the connector gateway backend mcp-sync service and tools.json.'), 'be.mcp-gateway'],
  ] as const)('infers repository ownership from the whole ticket', (task, expected) => {
    expect(inferTaskRepositories(task).map((route) => route.repository)).toContain(expected);
  });

  it('treats an explicit GitHub repository URL as authoritative evidence', () => {
    const routes = inferTaskRepositories(item('Fix the linked PR.', {
      sourceUrl: 'https://github.com/WriterInternal/be.mcp-gateway/pull/123',
    }));
    expect(routes[0]).toMatchObject({ repository: 'be.mcp-gateway', reason: expect.stringContaining('GitHub URL') });
  });

  it('routes the exact CON-214 private-endpoint fallback task to fe.web-app', () => {
    const routes = inferTaskRepositories(item('During private endpoint provisioning, update the fallback URL so the DNS NAME shows the custom domain when provided.', {
      title: 'CON-214 · Show custom domain in Private endpoint fallback URL',
      sourceUrl: 'https://linear.app/writer/issue/CON-214/show-custom-domain-in-private-endpoint-fallback-url',
    }));
    expect(routes[0]).toMatchObject({ repository: 'fe.web-app' });
    expect(routes.map((route) => route.repository)).not.toContain('writer-monorepo');
  });

  it('preserves multi-repository ownership instead of collapsing full-stack work', () => {
    const routes = inferTaskRepositories(item('Update AIS in fe.web-app, Writer Agent in writer-monorepo, and the mcp gateway backend.'));
    expect(routes.map((route) => route.repository)).toEqual(['writer-monorepo', 'fe.web-app', 'be.mcp-gateway']);
  });

  it('resolves only exact canonical checkout names', () => {
    const candidates = [
      '/Users/jeffrey.lu/dev/writer-monorepo-old',
      '/Users/jeffrey.lu/dev/writer-monorepo',
      '/Users/jeffrey.lu/dev/be.mcp-gateway-feature',
      '/Users/jeffrey.lu/dev/be.mcp-gateway',
    ];
    expect(routedWorkspacePaths(item('Update writer-monorepo and be.mcp-gateway.'), candidates).map((route) => route.path)).toEqual([
      '/Users/jeffrey.lu/dev/writer-monorepo',
      '/Users/jeffrey.lu/dev/be.mcp-gateway',
    ]);
  });

  it('hands the same ordered repositories to the agent prompt', () => {
    const prompt = repositoryRoutingPrompt(item('Update fe.web-app and be.mcp-gateway.'), [
      '/Users/jeffrey.lu/dev/fe.web-app',
      '/Users/jeffrey.lu/dev/be.mcp-gateway',
    ]);
    expect(prompt).toContain('also drives Changes');
    expect(prompt).toContain('Primary: /Users/jeffrey.lu/dev/fe.web-app');
    expect(prompt).toContain('Also relevant: /Users/jeffrey.lu/dev/be.mcp-gateway');
  });

  it('hands agents the isolated path for every routed repository', () => {
    const prompt = repositoryRoutingPrompt(item('Update fe.web-app and be.mcp-gateway.'), [
      '/Users/jeffrey.lu/dev/fe.web-app',
      '/Users/jeffrey.lu/dev/be.mcp-gateway',
    ], [
      { sourceWorkspace: '/Users/jeffrey.lu/dev/fe.web-app', worktree: '/Users/jeffrey.lu/dev/.workbench-worktrees/fe/run-1' },
      { sourceWorkspace: '/Users/jeffrey.lu/dev/be.mcp-gateway', worktree: '/Users/jeffrey.lu/dev/.workbench-worktrees/be/run-1' },
    ]);
    expect(prompt).toContain('Primary: /Users/jeffrey.lu/dev/.workbench-worktrees/fe/run-1 (isolated worktree for /Users/jeffrey.lu/dev/fe.web-app)');
    expect(prompt).toContain('Also relevant: /Users/jeffrey.lu/dev/.workbench-worktrees/be/run-1 (isolated worktree for /Users/jeffrey.lu/dev/be.mcp-gateway)');
    expect(prompt).toContain('Never edit its source checkout directly.');
    expect(prompt).toContain('linked ticket remains authoritative through every follow-up');
    expect(prompt).toContain('never rename a branch or replay unrelated commits');
  });

  it('keeps canonical routing mapped when a ticket branch worktree sits between the clone and run worktree', () => {
    const prompt = repositoryRoutingPrompt(item('Update fe.web-app.'), ['/Users/jeffrey.lu/dev/fe.web-app'], [{
      routingWorkspace: '/Users/jeffrey.lu/dev/fe.web-app',
      sourceWorkspace: '/Users/jeffrey.lu/dev/.workbench-worktrees/fe/tasks/con-214',
      worktree: '/Users/jeffrey.lu/dev/.workbench-worktrees/fe/run-1',
    }]);
    expect(prompt).toContain('Primary: /Users/jeffrey.lu/dev/.workbench-worktrees/fe/run-1 (isolated worktree for /Users/jeffrey.lu/dev/fe.web-app)');
  });
});
