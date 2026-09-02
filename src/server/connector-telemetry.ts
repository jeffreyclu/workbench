/**
 * Connector production troubleshooting telemetry.
 *
 * Backs the runbook playbook directly: Prometheus metrics answer "is this systemic and which
 * failure class", Loki answers "what happened to this specific tool call". Both ride the Grafana
 * service-account token already stored in source settings and the existing `grafana-api` outbound
 * policy, so this adds no new credential and no new egress host.
 *
 * Every query shape here is copied from the gateway's own tooling rather than invented:
 * metric and label names come from `be.mcp-gateway/grafana/dashboards/mcp-gateway-failure-taxonomy.json`,
 * and the Loki presets come from `.agents/skills/grafana-tool-call-search/scripts/build-logql.ts`.
 */
import { createOutboundFetch } from './outbound-policy.js';

const GRAFANA_URL = 'https://grafana.observability.writer.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SERIES_PER_BREAKDOWN = 10;
const MAX_LOG_LINE_CHARS = 600;

export type TelemetryFetch = typeof fetch;

/** Loki stream presets, mirroring the gateway skill's `build-logql.ts` so queries match the team's. */
export const LOGQL_PRESETS = {
  'wa-thread': { container: 'skynet-backend', extras: [] as string[] },
  'backend-thread': { container: 'skynet-backend', extras: [] as string[] },
  'wa-all-tools': { container: 'skynet-worker', extras: ['Executing tool:'] },
  'worker-tool': { container: 'skynet-worker', extras: ['Executing tool: WRITER_EXECUTE_FUNCTION'] },
  'mcp-payload': { container: 'mcp-gateway', extras: ['MCPToolExecutorExecuteTool'] },
  'mcp-execute': { container: 'mcp-gateway', extras: ['Executing function:'] },
} as const;

export type LogqlPreset = keyof typeof LOGQL_PRESETS;

export class TelemetryError extends Error {}

/** Grafana rejects nothing here, but an unescaped quote silently changes the query's meaning. */
function quoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function grafanaJson<T>(path: string, token: string, fetchImpl: TelemetryFetch): Promise<T> {
  const response = await fetchImpl(`${GRAFANA_URL}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new TelemetryError(`Grafana ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return response.json() as Promise<T>;
}

const datasourceCache = new Map<string, string>();

/** Only the Prometheus UID is published in the dashboard, so resolve both by type at call time. */
export async function resolveDatasourceUid(type: 'prometheus' | 'loki', token: string, fetchImpl: TelemetryFetch): Promise<string> {
  const cached = datasourceCache.get(type);
  if (cached) return cached;
  const datasources = await grafanaJson<Array<{ uid?: string; type?: string; isDefault?: boolean }>>('/api/datasources', token, fetchImpl);
  const matches = datasources.filter((datasource) => datasource.type === type && typeof datasource.uid === 'string');
  const chosen = matches.find((datasource) => datasource.isDefault) ?? matches[0];
  if (!chosen?.uid) throw new TelemetryError(`Grafana has no ${type} datasource visible to this service account.`);
  datasourceCache.set(type, chosen.uid);
  return chosen.uid;
}

export function resetDatasourceCache(): void {
  datasourceCache.clear();
}

export interface TimeRangeInput {
  start?: string | null;
  end?: string | null;
  windowMinutes?: number;
}

export function resolveRange(input: TimeRangeInput, now: Date): { start: string; end: string; seconds: number } {
  const end = input.end ? new Date(input.end) : now;
  if (Number.isNaN(end.getTime())) throw new TelemetryError(`Unparseable end time: ${input.end}`);
  const start = input.start ? new Date(input.start) : new Date(end.getTime() - (input.windowMinutes ?? 60) * 60_000);
  if (Number.isNaN(start.getTime())) throw new TelemetryError(`Unparseable start time: ${input.start}`);
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  if (seconds <= 0) throw new TelemetryError('The time range ends before it starts.');
  return { start: start.toISOString(), end: end.toISOString(), seconds };
}

interface PrometheusMatrix {
  data?: { result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }> };
}

/** Collapse a range vector to one row per series: enough to rank a failure class without dumping points. */
function summarizeSeries(payload: PrometheusMatrix) {
  return (payload.data?.result ?? [])
    .map((series) => {
      const numbers = (series.values ?? []).map(([, value]) => Number(value)).filter((value) => Number.isFinite(value));
      const latest = numbers.length ? numbers[numbers.length - 1] : 0;
      const peak = numbers.length ? Math.max(...numbers) : 0;
      return { labels: series.metric ?? {}, latest: Number(latest.toPrecision(4)), peak: Number(peak.toPrecision(4)) };
    })
    .filter((series) => series.peak > 0)
    .sort((left, right) => right.peak - left.peak)
    .slice(0, MAX_SERIES_PER_BREAKDOWN);
}

async function promQuery(expr: string, range: { start: string; end: string; seconds: number }, uid: string, token: string, fetchImpl: TelemetryFetch) {
  const step = Math.max(15, Math.ceil(range.seconds / 60));
  const params = new URLSearchParams({ query: expr, start: range.start, end: range.end, step: String(step) });
  const payload = await grafanaJson<PrometheusMatrix>(`/api/datasources/proxy/uid/${uid}/api/v1/query_range?${params}`, token, fetchImpl);
  return summarizeSeries(payload);
}

export interface FailureSummaryInput extends TimeRangeInput {
  cluster: string;
  connector?: string | null;
}

/** The six breakdowns the failure-taxonomy dashboard uses, run in one call. */
function breakdowns(selector: string, windowSeconds: number) {
  const failing = `${selector},result="failure"`;
  return [
    { name: 'tool_calls_by_result', question: 'Is this failing at all, and how much?', expr: `sum by (result) (rate(mcp_gateway_tool_calls_total{${selector}}[5m]))` },
    { name: 'failures_by_reason', question: 'Which failure class dominates?', expr: `sum by (failure_reason) (rate(mcp_gateway_tool_calls_total{${failing}}[5m]))` },
    { name: 'top_apps_by_failure', question: 'Is one connector carrying the failures?', expr: `topk(10, sum by (app, failure_reason) (increase(mcp_gateway_tool_calls_total{${failing}}[${windowSeconds}s])))` },
    { name: 'auth_failures', question: 'Not authenticated vs invalid credentials, by connector.', expr: `sum by (failure_reason, app) (rate(mcp_gateway_tool_calls_total{${failing},failure_reason=~"not_authenticated|invalid_credentials"}[5m]))` },
    { name: 'oauth_failures', question: 'Is token exchange or refresh failing?', expr: `sum by (operation, error_code) (rate(mcp_gateway_oauth_token_total{${selector},result="failure"}[5m]))` },
    { name: 'upstream_status', question: 'Is the third-party API itself returning errors?', expr: `sum by (status_code, transport) (rate(mcp_gateway_upstream_response_total{${selector}}[5m]))` },
  ];
}

export async function connectorFailureSummary(input: FailureSummaryInput, token: string, now: Date, fetchImpl: TelemetryFetch = createOutboundFetch('grafana-api')) {
  if (!input.cluster.trim()) throw new TelemetryError('A cluster is required. Run connector_observability_query with `count by (cluster) (mcp_gateway_tool_calls_total)` to list them.');
  const range = resolveRange(input, now);
  const uid = await resolveDatasourceUid('prometheus', token, fetchImpl);
  const selector = [`cluster=~"${quoted(input.cluster)}"`, input.connector ? `app=~"${quoted(input.connector)}"` : '']
    .filter(Boolean)
    .join(',');
  const results = await Promise.all(breakdowns(selector, range.seconds).map(async (breakdown) => ({
    ...breakdown,
    series: await promQuery(breakdown.expr, range, uid, token, fetchImpl),
  })));
  return { cluster: input.cluster, connector: input.connector ?? null, range: { start: range.start, end: range.end }, breakdowns: results };
}

export interface ConnectorLogsInput extends TimeRangeInput {
  cluster: string;
  preset: LogqlPreset;
  filter?: string | null;
  extra?: string | null;
  limit?: number;
  direction?: 'forward' | 'backward';
}

export function buildLogql(input: Pick<ConnectorLogsInput, 'cluster' | 'preset' | 'filter' | 'extra'>): string {
  const preset = LOGQL_PRESETS[input.preset];
  if (!preset) throw new TelemetryError(`Unknown preset: ${input.preset}`);
  const filters = [input.filter, ...preset.extras, input.extra].filter((value): value is string => Boolean(value && value.trim()));
  return [`{k8s_cluster_name="${quoted(input.cluster)}", k8s_container_name="${preset.container}"}`, ...filters.map((value) => `|= "${quoted(value)}"`)].join(' ');
}

interface LokiStreams {
  data?: { result?: Array<{ stream?: Record<string, string>; values?: Array<[string, string]> }> };
}

function exploreUrl(uid: string, expr: string, range: { start: string; end: string }): string {
  const left = JSON.stringify({ datasource: uid, queries: [{ refId: 'A', datasource: { type: 'loki', uid }, expr }], range: { from: range.start, to: range.end } });
  return `${GRAFANA_URL}/explore?left=${encodeURIComponent(left)}`;
}

export async function connectorLogs(input: ConnectorLogsInput, token: string, now: Date, fetchImpl: TelemetryFetch = createOutboundFetch('grafana-api')) {
  if (!input.cluster.trim()) throw new TelemetryError('A cluster is required.');
  const range = resolveRange(input, now);
  const query = buildLogql(input);
  const uid = await resolveDatasourceUid('loki', token, fetchImpl);
  const params = new URLSearchParams({
    query,
    start: range.start,
    end: range.end,
    limit: String(Math.min(Math.max(input.limit ?? 50, 1), 200)),
    direction: input.direction ?? 'backward',
  });
  const payload = await grafanaJson<LokiStreams>(`/api/datasources/proxy/uid/${uid}/loki/api/v1/query_range?${params}`, token, fetchImpl);
  const lines = (payload.data?.result ?? []).flatMap((stream) => (stream.values ?? []).map(([nanoseconds, line]) => ({
    timestamp: new Date(Number(nanoseconds) / 1e6).toISOString(),
    container: stream.stream?.k8s_container_name ?? LOGQL_PRESETS[input.preset].container,
    line: line.slice(0, MAX_LOG_LINE_CHARS),
  })));
  lines.sort((left, right) => (input.direction === 'forward' ? left.timestamp.localeCompare(right.timestamp) : right.timestamp.localeCompare(left.timestamp)));
  return { query, range: { start: range.start, end: range.end }, count: lines.length, lines, exploreUrl: exploreUrl(uid, query, range) };
}

export interface RawTelemetryQueryInput extends TimeRangeInput {
  kind: 'metrics' | 'logs';
  expr: string;
  limit?: number;
}

/** Escape hatch for anything the two playbook tools do not cover. */
export async function connectorObservabilityQuery(input: RawTelemetryQueryInput, token: string, now: Date, fetchImpl: TelemetryFetch = createOutboundFetch('grafana-api')) {
  if (!input.expr.trim()) throw new TelemetryError('An expression is required.');
  const range = resolveRange(input, now);
  if (input.kind === 'metrics') {
    const uid = await resolveDatasourceUid('prometheus', token, fetchImpl);
    return { kind: input.kind, expr: input.expr, range: { start: range.start, end: range.end }, series: await promQuery(input.expr, range, uid, token, fetchImpl) };
  }
  const uid = await resolveDatasourceUid('loki', token, fetchImpl);
  const params = new URLSearchParams({ query: input.expr, start: range.start, end: range.end, limit: String(Math.min(Math.max(input.limit ?? 50, 1), 200)), direction: 'backward' });
  const payload = await grafanaJson<LokiStreams>(`/api/datasources/proxy/uid/${uid}/loki/api/v1/query_range?${params}`, token, fetchImpl);
  const lines = (payload.data?.result ?? []).flatMap((stream) => (stream.values ?? []).map(([nanoseconds, line]) => ({
    timestamp: new Date(Number(nanoseconds) / 1e6).toISOString(),
    container: stream.stream?.k8s_container_name ?? null,
    line: line.slice(0, MAX_LOG_LINE_CHARS),
  })));
  return { kind: input.kind, expr: input.expr, range: { start: range.start, end: range.end }, count: lines.length, lines, exploreUrl: exploreUrl(uid, input.expr, range) };
}
