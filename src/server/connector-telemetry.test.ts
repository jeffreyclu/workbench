import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TelemetryError,
  buildLogql,
  connectorFailureSummary,
  connectorLogs,
  connectorObservabilityQuery,
  resetDatasourceCache,
  resolveRange,
} from './connector-telemetry.js';

const NOW = new Date('2026-09-02T12:00:00.000Z');

function stubGrafana(handler: (url: string) => unknown, options: { status?: number; body?: string } = {}) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    // The datasource-proxy path also contains `/api/datasources`, so dispatch on the query first.
    if (options.status && url.includes('query_range')) return new Response(options.body ?? 'nope', { status: options.status });
    return new Response(JSON.stringify(handler(url)), { headers: { 'content-type': 'application/json' } });
  });
  return { urls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const datasources = [
  { uid: 'prom-uid', type: 'prometheus', isDefault: true },
  { uid: 'loki-uid', type: 'loki' },
];

function matrix(labels: Record<string, string>, values: Array<[number, string]>) {
  return { data: { result: [{ metric: labels, values }] } };
}

beforeEach(() => {
  resetDatasourceCache();
});

describe('buildLogql', () => {
  it('reproduces the gateway build-logql.ts output for a preset plus filter', () => {
    expect(buildLogql({ cluster: 'prod-us', preset: 'wa-all-tools', filter: 'thread-123', extra: null }))
      .toBe('{k8s_cluster_name="prod-us", k8s_container_name="skynet-worker"} |= "thread-123" |= "Executing tool:"');
  });

  it('targets mcp-gateway with the executor marker for MCP payloads', () => {
    expect(buildLogql({ cluster: 'prod-us', preset: 'mcp-payload', filter: 'action-uuid', extra: null }))
      .toBe('{k8s_cluster_name="prod-us", k8s_container_name="mcp-gateway"} |= "action-uuid" |= "MCPToolExecutorExecuteTool"');
  });

  it('escapes quotes so a filter cannot silently rewrite the query', () => {
    expect(buildLogql({ cluster: 'prod-us', preset: 'wa-thread', filter: 'a"b', extra: null }))
      .toBe('{k8s_cluster_name="prod-us", k8s_container_name="skynet-backend"} |= "a\\"b"');
  });
});

describe('resolveRange', () => {
  it('defaults the window backwards from now', () => {
    expect(resolveRange({ windowMinutes: 30 }, NOW)).toEqual({
      start: '2026-09-02T11:30:00.000Z',
      end: '2026-09-02T12:00:00.000Z',
      seconds: 1800,
    });
  });

  it('rejects a range that ends before it starts', () => {
    expect(() => resolveRange({ start: '2026-09-02T12:00:00Z', end: '2026-09-02T11:00:00Z' }, NOW)).toThrow(TelemetryError);
  });
});

describe('connectorFailureSummary', () => {
  it('scopes every breakdown to the cluster and connector and ranks series by peak', async () => {
    const { urls, fetchImpl } = stubGrafana((url) => (url.includes('query_range')
      ? matrix({ failure_reason: 'invalid_credentials' }, [[1, '0.5'], [2, '2']])
      : datasources));

    const result = await connectorFailureSummary({ cluster: 'prod-us', connector: 'SALESFORCE', windowMinutes: 60 }, 'token', NOW, fetchImpl);

    expect(result.breakdowns.map((breakdown) => breakdown.name)).toEqual([
      'tool_calls_by_result', 'failures_by_reason', 'top_apps_by_failure', 'auth_failures', 'oauth_failures', 'upstream_status',
    ]);
    expect(result.breakdowns[0].series[0]).toEqual({ labels: { failure_reason: 'invalid_credentials' }, latest: 2, peak: 2 });
    const queries = urls.filter((url) => url.includes('query_range')).map((url) => decodeURIComponent(url));
    expect(queries).toHaveLength(6);
    expect(queries.every((query) => query.includes('cluster=~"prod-us"') && query.includes('app=~"SALESFORCE"'))).toBe(true);
    expect(queries.every((query) => query.includes('/api/datasources/proxy/uid/prom-uid/'))).toBe(true);
  });

  it('omits the app selector when no connector is given', async () => {
    const { urls, fetchImpl } = stubGrafana((url) => (url.includes('query_range') ? matrix({}, []) : datasources));
    await connectorFailureSummary({ cluster: 'prod-us', connector: null }, 'token', NOW, fetchImpl);
    expect(urls.filter((url) => url.includes('query_range')).some((url) => decodeURIComponent(url).includes('app=~'))).toBe(false);
  });

  it('requires a cluster rather than guessing one', async () => {
    const { fetchImpl } = stubGrafana(() => datasources);
    await expect(connectorFailureSummary({ cluster: ' ', connector: null }, 'token', NOW, fetchImpl)).rejects.toThrow(/cluster is required/);
  });
});

describe('connectorLogs', () => {
  it('queries the Loki datasource with the built query and normalizes lines', async () => {
    const { urls, fetchImpl } = stubGrafana((url) => (url.includes('query_range')
      ? { data: { result: [{ stream: { k8s_container_name: 'mcp-gateway' }, values: [['1756814400000000000', 'function_name=SALESFORCE_SEARCH']] }] } }
      : datasources));

    const result = await connectorLogs({ cluster: 'prod-us', preset: 'mcp-payload', filter: 'action-uuid', limit: 5 }, 'token', NOW, fetchImpl);

    expect(result.query).toContain('k8s_container_name="mcp-gateway"');
    expect(result.count).toBe(1);
    expect(result.lines[0]).toEqual({ timestamp: '2025-09-02T12:00:00.000Z', container: 'mcp-gateway', line: 'function_name=SALESFORCE_SEARCH' });
    expect(result.exploreUrl).toContain('loki-uid');
    const query = decodeURIComponent(urls.find((url) => url.includes('query_range')) ?? '');
    expect(query).toContain('/api/datasources/proxy/uid/loki-uid/loki/api/v1/query_range');
    expect(query).toContain('limit=5');
  });

  it('caps the line limit so a wide query cannot flood the context', async () => {
    const { urls, fetchImpl } = stubGrafana((url) => (url.includes('query_range') ? { data: { result: [] } } : datasources));
    await connectorLogs({ cluster: 'prod-us', preset: 'wa-thread', limit: 5_000 }, 'token', NOW, fetchImpl);
    expect(decodeURIComponent(urls.find((url) => url.includes('query_range')) ?? '')).toContain('limit=200');
  });
});

describe('connectorObservabilityQuery', () => {
  it('runs raw PromQL through the prometheus datasource', async () => {
    const { urls, fetchImpl } = stubGrafana((url) => (url.includes('query_range')
      ? matrix({ cluster: 'prod-us' }, [[1, '3']])
      : datasources));
    const result = await connectorObservabilityQuery({ kind: 'metrics', expr: 'count by (cluster) (mcp_gateway_tool_calls_total)' }, 'token', NOW, fetchImpl);
    expect(result.series?.[0].labels).toEqual({ cluster: 'prod-us' });
    expect(decodeURIComponent(urls.find((url) => url.includes('query_range')) ?? '')).toContain('uid/prom-uid/api/v1/query_range');
  });

  it('surfaces the Grafana status and body when a query is rejected', async () => {
    const { fetchImpl } = stubGrafana((url) => (url.includes('query_range') ? {} : datasources), { status: 400, body: 'parse error' });
    await expect(connectorObservabilityQuery({ kind: 'metrics', expr: 'bad{' }, 'token', NOW, fetchImpl)).rejects.toThrow(/Grafana 400.*parse error/);
  });

  it('fails clearly when the service account cannot see a loki datasource', async () => {
    const { fetchImpl } = stubGrafana(() => [{ uid: 'prom-uid', type: 'prometheus' }]);
    await expect(connectorObservabilityQuery({ kind: 'logs', expr: '{k8s_cluster_name="x"}' }, 'token', NOW, fetchImpl)).rejects.toThrow(/no loki datasource/);
  });
});
