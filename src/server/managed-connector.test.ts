import { describe, expect, it, vi } from 'vitest';

const { runAgentCommand } = vi.hoisted(() => ({ runAgentCommand: vi.fn() }));

vi.mock('./agent-runner.js', () => ({ runAgentCommand }));

import { searchGrafanaWithCodex } from './managed-connector.js';

describe('managed Grafana connector', () => {
  it('uses the authenticated Codex Grafana connector for a search', async () => {
    runAgentCommand.mockResolvedValueOnce('<connector-result>{"results":[{"title":"API latency","summary":"p95 rose after deploy","url":"https://writer.grafana.net/d/api-latency"}],"error":null}</connector-result>');

    await expect(searchGrafanaWithCodex('api latency after deploy')).resolves.toEqual([{
      provider: 'grafana', title: 'API latency', summary: 'p95 rose after deploy', url: 'https://writer.grafana.net/d/api-latency', occurredAt: null,
    }]);
    expect(runAgentCommand).toHaveBeenCalledWith('codex', process.cwd(), expect.stringContaining('authenticated Grafana connector'), undefined, undefined, 'economy');
  });
});
