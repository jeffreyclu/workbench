import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { agentEnvironmentForWorkspace, commandFor } from '../src/server/agent-runner.js';

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
  await main();
} finally {
  await killChild();
  await stopServer();
  console.log('cleanup_complete');
}
