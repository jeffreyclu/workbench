import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get as httpGet, request as httpRequest, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDatabaseCompatible, newestCompatibleRelease } from '../src/server/runtime-compatibility.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const currentLink = join(root, '.workbench-runtime/current');
const releasesRoot = join(root, '.workbench-runtime/releases');
const publicPort = Number(process.env.PORT?.trim() || 5180);
// Keep blue/green backends away from the low 4xxx range used by local product
// apps. These ports are loopback-only implementation details behind 5180.
const runtimePorts = [45173, 45174] as const;
const tsx = join(root, 'node_modules/.bin/tsx');
const databasePath = process.env.DATABASE_PATH?.trim() || join(root, 'data/workbench.db');

interface Runtime { releasePath: string; port: number; child: ChildProcess }
let active: Runtime | null = null;
let deploying = false;
let stopping = false;

function currentRelease(): string {
  if (!existsSync(currentLink)) throw new Error('No promoted runtime exists. Run npm run runtime:promote first.');
  const requested = realpathSync(currentLink);
  if (isDatabaseCompatible(requested, databasePath)) return requested;
  const fallback = newestCompatibleRelease(releasesRoot, databasePath);
  if (fallback) {
    console.error(`Promoted release ${requested.split('/').at(-1)} cannot open the current database; retaining compatible release ${fallback.split('/').at(-1)}.`);
    return fallback;
  }
  throw new Error(`No runtime release is compatible with the current database schema.`);
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolveHealth) => {
    const request = httpGet({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 750 }, (response) => {
      response.resume();
      resolveHealth(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveHealth(false));
  });
}

function runtimeWorkActive(port: number): Promise<boolean | null> {
  return new Promise((resolveStatus) => {
    const request = httpGet({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 750 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body = `${body}${chunk}`.slice(-4_000); });
      response.on('end', () => {
        try {
          const status = JSON.parse(body) as { runtimeWorkActive?: boolean };
          resolveStatus(typeof status.runtimeWorkActive === 'boolean' ? status.runtimeWorkActive : null);
        } catch { resolveStatus(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveStatus(null));
  });
}

async function stopAfterDrain(runtime: Runtime): Promise<void> {
  let reported = false;
  while (runtime.child.exitCode === null) {
    const activeWork = await runtimeWorkActive(runtime.port);
    if (activeWork === false) {
      runtime.child.kill('SIGTERM');
      return;
    }
    if (activeWork && !reported) {
      reported = true;
      console.log(`Workbench backend on port ${runtime.port} is draining in-flight work before shutdown.`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Runtime exited with code ${child.exitCode}.`);
    if (await healthy(port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Runtime on port ${port} did not become healthy.`);
}

async function deploy(releasePath = currentRelease()): Promise<void> {
  if (deploying || (active?.releasePath === releasePath && active.child.exitCode === null)) return;
  deploying = true;
  const port = active?.port === runtimePorts[0] ? runtimePorts[1] : runtimePorts[0];
  const serverEntry = join(releasePath, 'src/server/index.ts');
  const clientPath = join(releasePath, 'client');
  if (!existsSync(serverEntry) || !existsSync(join(clientPath, 'index.html'))) {
    deploying = false;
    throw new Error(`Incomplete promoted runtime: ${releasePath}`);
  }

  const child = spawn(tsx, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      WORKBENCH_CLIENT_PATH: clientPath,
      DATABASE_PATH: databasePath,
    },
    stdio: 'inherit',
  });

  try {
    await waitForHealth(port, child);
    const previous = active;
    active = { releasePath, port, child };
    child.once('exit', () => {
      if (stopping || active?.child !== child) return;
      active = null;
      console.error(`Workbench backend on port ${port} exited; restarting the promoted release.`);
      setTimeout(() => {
        if (!stopping) void deploy().catch((error) => console.error('Runtime restart failed:', error));
      }, 250).unref();
    });
    console.log(`Workbench live runtime switched to ${releasePath.split('/').at(-1)}.`);
    if (previous) void stopAfterDrain(previous);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  } finally {
    deploying = false;
  }
}

const gateway = createServer((incoming, outgoing) => {
  if (!active) {
    outgoing.statusCode = 503;
    outgoing.end('Workbench runtime is starting.');
    return;
  }
  const proxied = httpRequest({
    hostname: '127.0.0.1',
    port: active.port,
    method: incoming.method,
    path: incoming.url,
    headers: incoming.headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  proxied.on('error', (error) => {
    if (!outgoing.headersSent) outgoing.statusCode = 502;
    outgoing.end(`Workbench runtime unavailable: ${error.message}`);
  });
  incoming.pipe(proxied);
});

/**
 * HTTP requests and WebSocket upgrades share the public gateway. Keep the
 * upgrade connection byte-for-byte intact after the backend accepts it.
 */
gateway.on('upgrade', (incoming: IncomingMessage, socket: Socket, head: Buffer) => {
  if (!active) {
    socket.destroy();
    return;
  }
  const proxied = httpRequest({
    hostname: '127.0.0.1',
    port: active.port,
    method: incoming.method,
    path: incoming.url,
    headers: incoming.headers,
  });
  proxied.once('upgrade', (response, backendSocket, backendHead) => {
    const statusLine = `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}`;
    const headers = response.rawHeaders.reduce<string[]>((lines, value, index) => {
      if (index % 2 === 0) lines.push(`${value}: ${response.rawHeaders[index + 1] ?? ''}`);
      return lines;
    }, []);
    socket.write(`${statusLine}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) backendSocket.write(head);
    if (backendHead.length) backendSocket.unshift(backendHead);
    backendSocket.pipe(socket);
    socket.pipe(backendSocket);
  });
  proxied.once('response', (response) => {
    response.resume();
    socket.destroy();
  });
  proxied.once('error', () => socket.destroy());
  proxied.end();
});

await deploy();
gateway.listen(publicPort, () => console.log(`Workbench stable gateway listening on http://localhost:${publicPort}`));

const watcher = setInterval(() => {
  if (stopping) return;
  try {
    const releasePath = currentRelease();
    if (releasePath !== active?.releasePath) void deploy(releasePath).catch((error) => console.error('Runtime switch failed:', error));
  } catch (error) {
    console.error(error);
  }
}, 1_000);
watcher.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(watcher);
    active?.child.kill('SIGTERM');
    gateway.close(() => process.exit(0));
  });
}
