import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { agentEnvironmentForWorkspace, commandFor } from '../src/server/agent-runner.js';
import { CODEX_APP_SERVER_ARGS, codexThreadBootstrapRequest, codexTurnStartParams } from '../src/server/shared-room.js';

const cwd = process.cwd();
const port = 5199;
const sessionId = randomUUID();
const mcpConfig = JSON.stringify({ mcpServers: { spike: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } });
const events: Array<Record<string, unknown>> = [];
let server: Server | undefined;
let bootId = '';
let calls = 0;
let child: ChildProcessWithoutNullStreams | undefined;

function log(label: string, value: unknown) {
  console.log(`${label} ${JSON.stringify(value)}`);
}

function createSpikeServer(): Server {
  bootId = randomUUID();
  calls = 0;
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    const mcp = new McpServer({ name: 'session-spike', version: '1.0.0' });
    mcp.registerTool('spike_ping', { description: 'Returns this server boot and call count.', inputSchema: {} }, async () => {
      calls += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ bootId, calls }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    } finally {
      await mcp.close();
    }
  });
}

async function startServer() {
  server = createSpikeServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  log('mcp_started', { port, bootId });
}

async function stopServer() {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  log('mcp_stopped', { port });
}

function json(value: unknown) {
  if (!child?.stdin.writable) throw new Error('Claude stdin is not writable');
  log('sent', value);
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function user(prompt: string) {
  json({ type: 'user', message: { role: 'user', content: prompt } });
}

function control(subtype: string, extra: Record<string, unknown> = {}) {
  const requestId = randomUUID();
  json({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } });
  return requestId;
}

function isControlResponse(event: Record<string, unknown>, requestId: string) {
  const response = event.response as Record<string, unknown> | undefined;
  return event.type === 'control_response' && response?.request_id === requestId;
}

async function processInfo(label: string) {
  if (!child?.pid) throw new Error('Claude did not start');
  const output = await new Promise<string>((resolve, reject) => execFile('ps', ['-o', 'pid,lstart', '-p', String(child!.pid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  log('ps', { label, output });
}

async function waitFor(predicate: (event: Record<string, unknown>) => boolean, label: string, timeoutMs = 90_000, start = events.length) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.slice(start).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function turn(label: string, prompt: string) {
  const start = events.length;
  user(prompt);
  const result = await waitFor((event) => event.type === 'result', `${label} result`, 90_000, start);
  await processInfo(label);
  return result;
}

function startClaude(resume = false) {
  const base = commandFor('claude', cwd, 'economy');
  const args = base.args.flatMap((arg, index, all) => arg === '--mcp-config' ? [arg, mcpConfig] : index > 0 && all[index - 1] === '--mcp-config' ? [] : [arg]);
  args.push('--session-id', sessionId, '--replay-user-messages');
  if (resume) args.push('--resume', sessionId);
  child = spawn(base.command, args, {
    cwd,
    // agentEnvironmentForWorkspace is the runner environment source; this spike only overrides its MCP configuration.
    env: agentEnvironmentForWorkspace('claude', 'default', cwd),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => console.error(`claude_stderr ${chunk.toString('utf8').trim()}`));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      if (['assistant', 'result', 'control_response', 'user'].includes(String(event.type))) log('event', event);
    } catch {
      console.log(`stdout ${line}`);
    }
  });
  child.once('exit', (code, signal) => log('claude_exit', { code, signal }));
  log('claude_started', { pid: child.pid, args });
}

async function killChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

type RpcEvent = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
let codexChild: ChildProcessWithoutNullStreams | undefined;
const rpcEvents: RpcEvent[] = [];
let nextRpcId = 1;

function codexSend(method: string, params?: Record<string, unknown> | null) {
  if (!codexChild?.stdin.writable) throw new Error('Codex app-server stdin is not writable');
  const message = { jsonrpc: '2.0', id: nextRpcId++, method, ...(params === undefined ? {} : { params }) };
  log('sent', message);
  codexChild.stdin.write(`${JSON.stringify(message)}\n`);
  return message.id;
}

function codexNotification(method: string, params: Record<string, unknown> = {}) {
  const message = { jsonrpc: '2.0', method, params };
  log('sent', message);
  codexChild?.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForRpc(predicate: (event: RpcEvent) => boolean, label: string, start = rpcEvents.length, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = rpcEvents.slice(start).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function codexRequest(method: string, params?: Record<string, unknown> | null) {
  const start = rpcEvents.length;
  const id = codexSend(method, params);
  const event = await waitForRpc((candidate) => candidate.id === id, `${method} response`, start);
  if (event.error) throw new Error(`${method}: ${event.error.message ?? 'unknown error'}`);
  return event.result ?? {};
}

function startCodex() {
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const args = [...CODEX_APP_SERVER_ARGS, '-c', `mcp_servers.workbench.url="${mcpUrl}"`];
  codexChild = spawn('codex', args, {
    cwd,
    env: { ...agentEnvironmentForWorkspace('codex', 'default', cwd), WORKBENCH_LOCAL_MCP_TOKEN: 'loopback' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  codexChild.stderr.on('data', (chunk) => console.error(`codex_stderr ${chunk.toString('utf8').trim()}`));
  createInterface({ input: codexChild.stdout }).on('line', (line) => {
    try {
      const event = JSON.parse(line) as RpcEvent;
      rpcEvents.push(event);
      if (event.method === 'turn/started' || event.method === 'turn/completed' || event.method === 'item/completed' || event.id !== undefined) log('event', event);
    } catch { console.log(`codex_stdout ${line}`); }
  });
  codexChild.once('exit', (code, signal) => log('codex_exit', { code, signal }));
  log('codex_started', { pid: codexChild.pid, args });
}

async function codexProcessInfo(label: string) {
  const pid = codexChild?.pid;
  if (!pid) throw new Error('Codex did not start');
  const output = await new Promise<string>((resolve, reject) => execFile('ps', ['-o', 'pid,lstart', '-p', String(pid)], (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  log('ps', { label, output });
}

async function codexTurn(threadId: string, label: string, prompt: string, overrides: Record<string, unknown> = {}) {
  const start = rpcEvents.length;
  const params = { ...codexTurnStartParams(threadId, cwd, prompt), ...overrides };
  await codexRequest('turn/start', params);
  const completed = await waitForRpc((event) => event.method === 'turn/completed' && event.params?.threadId === threadId, `${label} completed`, start);
  await codexProcessInfo(label);
  return completed;
}

async function killCodex() {
  if (!codexChild || codexChild.exitCode !== null || codexChild.signalCode !== null) return;
  codexChild.kill('SIGTERM');
  await Promise.race([once(codexChild, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (codexChild.exitCode === null && codexChild.signalCode === null) codexChild.kill('SIGKILL');
}

async function mainCodex() {
  await startServer();
  startCodex();
  await codexRequest('initialize', { clientInfo: { name: 'workbench', title: 'Workbench', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  codexNotification('initialized');
  const bootstrap = codexThreadBootstrapRequest(cwd);
  bootstrap.params.config = { 'mcp_servers.workbench.url': `http://127.0.0.1:${port}/mcp`, 'mcp_servers.workbench.bearer_token_env_var': 'WORKBENCH_LOCAL_MCP_TOKEN' };
  const thread = await codexRequest(bootstrap.method, bootstrap.params);
  const threadRecord = thread.thread as Record<string, unknown> | undefined;
  const threadId = String(threadRecord?.id ?? thread.threadId);
  if (!threadId || threadId === 'undefined') throw new Error(`thread/start returned no thread id: ${JSON.stringify(thread)}`);
  log('thread_started', { threadId });

  await codexTurn(threadId, 'multi_turn_1', 'Reply with exactly: one');
  await codexTurn(threadId, 'multi_turn_2', 'Reply with exactly: two');
  await codexTurn(threadId, 'multi_turn_3', 'Reply with exactly: three');

  const interruptStart = rpcEvents.length;
  await codexRequest('turn/start', codexTurnStartParams(threadId, cwd, 'Use Bash to sleep for 20 seconds, then reply with exactly: interrupted-test.'));
  const started = await waitForRpc((event) => event.method === 'turn/started' && event.params?.threadId === threadId, 'turn/started', interruptStart);
  const startedTurn = started.params?.turn as Record<string, unknown> | undefined;
  const turnId = String(startedTurn?.id ?? started.params?.turnId);
  await waitForRpc((event) => event.method === 'item/completed' && /agentMessage|agent_message/.test(String((event.params?.item as Record<string, unknown> | undefined)?.type)), 'first agent text', interruptStart);
  await codexRequest('turn/interrupt', { threadId, turnId });
  await waitForRpc((event) => event.method === 'turn/completed' && event.params?.threadId === threadId, 'interrupted completion', interruptStart);
  await codexTurn(threadId, 'interrupt_follow_up', 'Reply with exactly: after-interrupt');

  const markerRoot = await mkdtemp(join(tmpdir(), 'codex-session-spike-'));
  const firstCwd = join(markerRoot, 'one'); const secondCwd = join(markerRoot, 'two');
  await mkdir(firstCwd); await mkdir(secondCwd);
  await writeFile(join(markerRoot, 'one.marker'), 'one'); await writeFile(join(markerRoot, 'two.marker'), 'two');
  await codexTurn(threadId, 'override_one', 'Use Bash to print pwd and cat ../one.marker. Reply with both outputs only.', { cwd: firstCwd, model: 'gpt-6.1-sol', effort: 'low' });
  await codexTurn(threadId, 'override_two', 'Use Bash to print pwd and cat ../two.marker. Reply with both outputs only.', { cwd: secondCwd, model: 'gpt-6.1-sol', effort: 'high' });

  await codexTurn(threadId, 'mcp_before_restart', 'Call the spike_ping MCP tool and reply with its returned JSON only.');
  await stopServer(); await startServer();
  try {
    await codexTurn(threadId, 'mcp_after_restart', 'Call the spike_ping MCP tool and reply with its returned JSON only.');
    log('mcp_reconnect', { firstWorkingStep: 'automatic' });
  } catch (automaticError) {
    log('mcp_reconnect', { automatic: String(automaticError) });
    for (const [method, params] of [['mcpServerStatus/list', { threadId }], ['config/mcpServer/reload', null]] as const) {
      await codexRequest(method, params);
      try { await codexTurn(threadId, `mcp_after_${method}`, 'Call the spike_ping MCP tool and reply with its returned JSON only.'); log('mcp_reconnect', { firstWorkingStep: method }); return; } catch (error) { log('mcp_reconnect', { [method]: String(error) }); }
    }
    await killCodex(); startCodex();
    await codexRequest('initialize', { clientInfo: { name: 'workbench', title: 'Workbench', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }); codexNotification('initialized');
    await codexRequest('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', config: bootstrap.params.config });
    await codexTurn(threadId, 'mcp_after_resume', 'Call the spike_ping MCP tool and reply with its returned JSON only.'); log('mcp_reconnect', { firstWorkingStep: 'thread/resume' });
  }
}

async function main() {
  await startServer();
  startClaude();
  await turn('multi_turn_1', 'Reply with exactly: one');
  await turn('multi_turn_2', 'Reply with exactly: two');
  await turn('multi_turn_3', 'Reply with exactly: three');

  const interruptStart = events.length;
  user('Use Bash to sleep for 20 seconds, then reply with exactly: interrupted-test.');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const interruptControlStart = events.length;
  const interruptId = control('interrupt');
  await waitFor((event) => isControlResponse(event, interruptId), 'interrupt control response', 90_000, interruptControlStart);
  await waitFor((event) => event.type === 'result', 'interrupt result', 90_000, interruptStart);
  await processInfo('interrupt');
  await turn('interrupt_follow_up', 'Reply with exactly: after-interrupt');

  const modelStart = events.length;
  const modelId = control('set_model', { model: 'haiku' });
  await waitFor((event) => isControlResponse(event, modelId), 'set_model control response', 90_000, modelStart);
  user('Reply with exactly: model-check');
  const modelEvent = await waitFor((event) => event.type === 'assistant' && !!(event.message as Record<string, unknown> | undefined)?.model, 'assistant model event', 90_000, modelStart);
  log('model_after_switch', { model: (modelEvent.message as Record<string, unknown>).model });
  await waitFor((event) => event.type === 'result', 'model switch result', 90_000, modelStart);
  await processInfo('model_switch');

  await turn('mcp_before_restart', 'Call the spike_ping MCP tool and reply with its returned JSON only.');
  await stopServer();
  await startServer();
  try {
    await turn('mcp_after_restart', 'Call the spike_ping MCP tool and reply with its returned JSON only.');
    log('mcp_reconnect', { firstWorkingStep: 'automatic' });
  } catch (error) {
    log('mcp_reconnect', { automatic: String(error) });
    for (const subtype of ['mcp_status', 'mcp_reconnect']) {
      const controlStart = events.length;
      const requestId = control(subtype);
      await waitFor((event) => isControlResponse(event, requestId), `${subtype} response`, 90_000, controlStart);
      try {
        await turn(`mcp_after_${subtype}`, 'Call the spike_ping MCP tool and reply with its returned JSON only.');
        log('mcp_reconnect', { firstWorkingStep: subtype });
        return;
      } catch (retryError) {
        log('mcp_reconnect', { [subtype]: String(retryError) });
      }
    }
    await killChild();
    startClaude(true);
    await turn('mcp_after_resume', 'Call the spike_ping MCP tool and reply with its returned JSON only.');
    log('mcp_reconnect', { firstWorkingStep: 'resume' });
  }
}

try {
  if (process.env.SPIKE_PROVIDER === 'codex') await mainCodex(); else await main();
} finally {
  await killChild();
  await killCodex();
  await stopServer();
  console.log('cleanup_complete');
}
