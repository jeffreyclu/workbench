import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get as httpGet, request as httpRequest } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const currentLink = join(root, '.workbench-runtime/current');
const publicPort = Number(process.env.PORT?.trim() || 5173);
// Keep blue/green backends away from the low 4xxx range used by local product
// apps. These ports are loopback-only implementation details behind 5173.
const runtimePorts = [45173, 45174] as const;
const tsx = join(root, 'node_modules/.bin/tsx');

interface Runtime { releasePath: string; port: number; child: ChildProcess }
let active: Runtime | null = null;
let deploying = false;
let stopping = false;

function currentRelease(): string {
  if (!existsSync(currentLink)) throw new Error('No promoted runtime exists. Run npm run runtime:promote first.');
  return realpathSync(currentLink);
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
  if (deploying || active?.releasePath === releasePath) return;
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
      DATABASE_PATH: process.env.DATABASE_PATH?.trim() || join(root, 'data/workbench.db'),
    },
    stdio: 'inherit',
  });

  try {
    await waitForHealth(port, child);
    const previous = active;
    active = { releasePath, port, child };
    console.log(`Workbench live runtime switched to ${releasePath.split('/').at(-1)}.`);
    if (previous) setTimeout(() => previous.child.kill('SIGTERM'), 2_000).unref();
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
