import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendMcpQualityRun, type McpQualityRun } from '../src/server/mcp-quality-history.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const mcpjam = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpjam.cmd' : 'mcpjam');
const baselinePath = join(root, '.mcpjam', 'workbench-baseline.json');
const fixturesPath = join(root, '.mcpjam', 'fixtures.json');
const toolMatrixPath = join(root, '.mcpjam', 'tool-matrix.json');
const defaultArtifactsPath = join(root, 'data', 'mcpjam', 'local-latest');
const testAccessToken = 'loopback';
const maxOutput = 30 * 1024 * 1024;

export interface McpJamGateOptions {
  url: string;
  artifactDirectory?: string;
  accessToken?: string;
  source?: McpQualityRun['source'];
  historyPath?: string;
}

interface JsonObject { [key: string]: unknown }
interface ToolMatrixEntry { name: string; expected: 'success' | 'error'; arguments: Record<string, unknown> }

function parseLastJson(output: string, label: string): JsonObject {
  const lines = output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject;
    } catch { /* MCPJam may print capability warnings before its JSON result. */ }
  }
  throw new Error(`${label} did not return a JSON result.\n\n${output.slice(-4_000)}`);
}

function resultFailure(payload: JsonObject): string {
  const error = payload.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const failures = groups.flatMap((group) => {
    if (!group || typeof group !== 'object' || !('cases' in group) || !Array.isArray(group.cases)) return [];
    return group.cases.filter((entry: unknown) => entry && typeof entry === 'object' && 'status' in entry && entry.status === 'failed');
  });
  if (failures.length) return failures.map((entry) => {
    const item = entry as { id?: unknown; error?: unknown };
    return `${String(item.id ?? 'check')}: ${String(item.error ?? 'failed')}`;
  }).join('\n');
  return 'MCPJam reported a failed check. Open the saved JSON artifact for the complete trace.';
}

function runMcpJam(label: string, args: string[], outputPath: string): JsonObject {
  const result = spawnSync(mcpjam, ['--no-telemetry', '--quiet', '--format', 'json', ...args], {
    cwd: root,
    env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    maxBuffer: maxOutput,
  });
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  let payload: JsonObject;
  try {
    payload = parseLastJson(result.stdout || combined, label);
  } catch (error) {
    writeFileSync(outputPath.replace(/\.json$/, '.log'), combined);
    throw error;
  }
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0 || payload.passed === false || payload.status === 'failed') {
    throw new Error(`${label} failed.\n\n${resultFailure(payload)}\n\nTrace: ${outputPath}`);
  }
  return payload;
}

function targetArgs(url: string, accessToken: string): string[] {
  return ['--url', url, '--access-token', accessToken];
}

function prepareArtifacts(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

function readToolMatrix(): ToolMatrixEntry[] {
  const parsed = JSON.parse(readFileSync(toolMatrixPath, 'utf8')) as { tools?: ToolMatrixEntry[] };
  if (!Array.isArray(parsed.tools)) throw new Error('MCPJam tool matrix must contain a tools array.');
  return parsed.tools;
}

function baselineToolNames(): string[] {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as { tools?: Array<{ name?: unknown }> };
  if (!Array.isArray(parsed.tools)) throw new Error('MCPJam baseline does not contain a tool catalog.');
  return parsed.tools.map((tool) => String(tool.name)).sort();
}

function runToolMatrix(url: string, accessToken: string, artifactDirectory: string): number {
  const matrix = readToolMatrix();
  const matrixNames = matrix.map((entry) => entry.name).sort();
  const advertisedNames = baselineToolNames();
  if (new Set(matrixNames).size !== matrixNames.length || JSON.stringify(matrixNames) !== JSON.stringify(advertisedNames)) {
    const missing = advertisedNames.filter((name) => !matrixNames.includes(name));
    const stale = matrixNames.filter((name) => !advertisedNames.includes(name));
    throw new Error(`MCPJam tool matrix must cover every advertised tool exactly once. Missing: ${missing.join(', ') || 'none'}. Stale: ${stale.join(', ') || 'none'}.`);
  }
  const resultDirectory = join(artifactDirectory, 'tools');
  mkdirSync(resultDirectory, { recursive: true });
  const summary: Array<{ name: string; expected: ToolMatrixEntry['expected']; passed: boolean; durationMs: number }> = [];
  for (const entry of matrix) {
    const startedAt = Date.now();
    const result = spawnSync(mcpjam, [
      '--no-telemetry', '--quiet', '--format', 'json', 'tools', 'call',
      '--tool-name', entry.name, '--tool-args', JSON.stringify(entry.arguments), '--validate-response',
      ...targetArgs(url, accessToken),
    ], {
      cwd: root,
      env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      maxBuffer: maxOutput,
    });
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const payload = parseLastJson(result.stdout || combined, `MCPJam ${entry.name} tool probe`);
    writeFileSync(join(resultDirectory, `${entry.name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    const returnedError = payload.isError === true;
    const passed = entry.expected === 'success'
      ? result.status === 0 && !returnedError
      : result.status !== 0 && returnedError;
    summary.push({ name: entry.name, expected: entry.expected, passed, durationMs: Date.now() - startedAt });
    if (!passed) throw new Error(`MCPJam tool probe ${entry.name} expected ${entry.expected} but exited ${result.status ?? 'without status'} with isError=${String(payload.isError)}.`);
  }
  writeFileSync(join(artifactDirectory, 'tool-matrix-summary.json'), `${JSON.stringify({ passed: true, covered: summary.length, tools: summary }, null, 2)}\n`);
  return summary.length;
}

/**
 * Deterministic MCP release gate. It never invokes a language model or uploads
 * Workbench data: every check runs locally against one candidate endpoint.
 */
export function runMcpJamGate(options: McpJamGateOptions): void {
  const startedAt = Date.now();
  const artifacts = resolve(options.artifactDirectory ?? defaultArtifactsPath);
  const accessToken = options.accessToken ?? testAccessToken;
  const source = options.source ?? (process.env.CI ? 'ci' : 'local');
  const revisionResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const revision = revisionResult.status === 0 ? revisionResult.stdout.trim() || null : null;
  let protocolScore: number | null = null;
  let compatibleHosts: number | null = null;
  let toolProbes: number | null = null;
  let totalTools = 0;
  let breakingChanges: number | null = null;
  let tasksWire: McpQualityRun['tasksWire'] = null;
  let taskScore: number | null = null;
  let subscriptionChecks: McpQualityRun['subscriptionChecks'] = null;
  const record = (status: McpQualityRun['status'], failure: string | null) => appendMcpQualityRun({
    id: randomUUID(), checkedAt: new Date().toISOString(), status, source, revision,
    durationMs: Date.now() - startedAt, protocolScore, compatibleHosts, toolProbes,
    totalTools, breakingChanges, failure, tasksWire, taskScore, subscriptionChecks,
  }, options.historyPath);

  try {
    if (!existsSync(mcpjam)) throw new Error('MCPJam is not installed. Run npm install before promotion.');
    if (!existsSync(baselinePath)) throw new Error('Missing .mcpjam/workbench-baseline.json. Run npm run mcp:baseline intentionally after reviewing the tool-contract change.');
    if (!existsSync(fixturesPath)) throw new Error('Missing .mcpjam/fixtures.json.');
    if (!existsSync(toolMatrixPath)) throw new Error('Missing .mcpjam/tool-matrix.json.');
    totalTools = baselineToolNames().length;
    prepareArtifacts(artifacts);

    const doctor = runMcpJam('MCPJam server doctor', [
      'server', 'doctor', ...targetArgs(options.url, accessToken),
    ], join(artifacts, 'doctor.json'));

    const conformance = runMcpJam('MCPJam protocol conformance', [
      'protocol', 'conformance', ...targetArgs(options.url, accessToken),
      '--fixtures-file', fixturesPath,
      '--reporter', 'json-summary',
    ], join(artifacts, 'protocol-conformance.json'));
    const rawScore = conformance.score && typeof conformance.score === 'object' && 'score' in conformance.score
      ? conformance.score.score : null;
    protocolScore = rawScore === null ? null : Number(rawScore);
    const protocolGroups = Array.isArray(conformance.groups) ? conformance.groups : [];
    const protocolCases = protocolGroups.flatMap((group) => group && typeof group === 'object' && 'cases' in group && Array.isArray(group.cases) ? group.cases : []);
    const subscriptions = protocolCases.filter((entry) => entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string' && entry.id.startsWith('modern-subscription-')) as Array<{ status?: unknown; skipReason?: unknown }>;
    if (subscriptions.length !== 3) throw new Error(`MCPJam protocol profile exposed ${subscriptions.length} subscription checks; expected 3.`);
    subscriptionChecks = {
      passed: subscriptions.filter((entry) => entry.status === 'passed').length,
      notApplicable: subscriptions.filter((entry) => entry.status === 'skipped' && entry.skipReason === 'not-applicable').length,
      total: subscriptions.length,
    };

    const taskCapabilities = runMcpJam('MCPJam task capability resolution', [
      'tasks', 'capabilities', ...targetArgs(options.url, accessToken),
    ], join(artifacts, 'task-capabilities.json'));
    if (taskCapabilities.wire !== 'none' && taskCapabilities.wire !== 'legacy' && taskCapabilities.wire !== 'extension') {
      throw new Error(`MCPJam could not resolve one task wire: ${String(taskCapabilities.wire ?? 'missing')}.`);
    }
    tasksWire = taskCapabilities.wire;
    const taskConformance = runMcpJam('MCPJam task conformance', [
      'tasks', 'conformance', '--reporter', 'json-summary', ...targetArgs(options.url, accessToken),
    ], join(artifacts, 'task-conformance.json'));
    const rawTaskScore = taskConformance.score && typeof taskConformance.score === 'object' && 'score' in taskConformance.score
      ? taskConformance.score.score : null;
    taskScore = rawTaskScore === null ? null : Number(rawTaskScore);

    const compatibility = runMcpJam('MCPJam full client compatibility', [
      'compat', '--offline',
      ...targetArgs(options.url, accessToken),
    ], join(artifacts, 'host-compatibility.json'));
    const summary = compatibility.summary && typeof compatibility.summary === 'object' ? compatibility.summary as { works?: unknown } : {};
    compatibleHosts = Number(summary.works ?? 0);

    runMcpJam('MCPJam tool-contract diff', [
      'server', 'diff', '--baseline', baselinePath, '--fail-on', 'breaking',
      '--reporter', 'json-summary', '--out', join(artifacts, 'contract-diff.json'),
      ...targetArgs(options.url, accessToken),
    ], join(artifacts, 'contract-diff-summary.json'));
    breakingChanges = 0;

    runMcpJam('MCPJam safe tool execution', [
      'tools', 'call', '--tool-name', 'list_projects', '--tool-args', '{}',
      '--validate-response', '--expect-success', '--reporter', 'json-summary',
      '--debug-out', join(artifacts, 'list-projects-debug.json'),
      ...targetArgs(options.url, accessToken),
    ], join(artifacts, 'list-projects-summary.json'));

    toolProbes = runToolMatrix(options.url, accessToken, artifacts);
    record('passed', null);
    console.log(`MCPJam gate passed: doctor=${String(doctor.status ?? 'ready')}; protocol=${protocolScore ?? 'passing'}; compatible-hosts=${compatibleHosts}; breaking-contract-changes=0; tool-probes=${toolProbes}/${totalTools}; tasks=${tasksWire}:${taskScore ?? 'passing'}; subscriptions=${subscriptionChecks.passed}/${subscriptionChecks.total} active (${subscriptionChecks.notApplicable} not applicable).`);
    console.log(`MCPJam traces: ${artifacts}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { record('failed', message.slice(0, 500)); }
    catch (historyError) { console.error(`Could not persist MCPJam regression history: ${historyError instanceof Error ? historyError.message : historyError}`); }
    throw error;
  }
}

function captureBaseline(url: string, accessToken: string): void {
  const result = spawnSync(mcpjam, [
    '--no-telemetry', '--quiet', '--format', 'json',
    'server', 'export', '--stable', ...targetArgs(url, accessToken),
  ], {
    cwd: root,
    env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    maxBuffer: maxOutput,
  });
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (result.error || result.status !== 0) throw new Error(`MCPJam baseline export failed.\n\n${combined.slice(-4_000)}`);
  const payload = parseLastJson(result.stdout || combined, 'MCPJam baseline export');
  // The isolated server uses a random port. Keep the reviewed baseline stable
  // so an update shows only contract changes, never test-harness noise.
  payload.target = 'http://127.0.0.1:5180/mcp';
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Updated ${baselinePath}. Review the contract diff before committing it.`);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate an MCPJam test port.');
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  return new Promise((resolveHealth, rejectHealth) => {
    const deadline = Date.now() + 20_000;
    const poll = () => {
      if (child.exitCode !== null) return rejectHealth(new Error(`Isolated Workbench MCP server exited with code ${child.exitCode}.`));
      const request = httpGet({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 750 }, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolveHealth();
        if (Date.now() >= deadline) return rejectHealth(new Error('Isolated Workbench MCP server did not become healthy within 20 seconds.'));
        setTimeout(poll, 100);
      });
      request.on('error', () => Date.now() >= deadline ? rejectHealth(new Error('Isolated Workbench MCP server did not become healthy within 20 seconds.')) : setTimeout(poll, 100));
      request.on('timeout', () => request.destroy());
    };
    poll();
  });
}

async function runStandalone(): Promise<void> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'workbench-mcpjam-'));
  const port = await availablePort();
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'runtime-preflight-api.ts')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(temporaryDirectory, 'workbench.db'),
      AUDIT_DATABASE_PATH: join(temporaryDirectory, 'workbench-audit.db'),
      WORKBENCH_TOKEN: testAccessToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout?.on('data', (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk}`.slice(-8_000); });
  child.stderr?.on('data', (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk}`.slice(-8_000); });
  try {
    await waitForHealth(port, child);
    const url = `http://127.0.0.1:${port}/mcp`;
    if (process.argv.includes('--update-baseline')) captureBaseline(url, testAccessToken);
    else runMcpJamGate({ url, accessToken: testAccessToken });
  } catch (error) {
    if (serverOutput.trim()) console.error(`Isolated Workbench output:\n${serverOutput.trim()}`);
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 5_000);
      child.once('exit', () => { clearTimeout(timeout); resolveExit(); });
    });
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runStandalone().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
