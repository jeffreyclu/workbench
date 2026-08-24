import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface TestHttpServer {
  server: Server;
  baseUrl: string;
}

/** Binds `app` to an ephemeral 127.0.0.1 port and resolves once it is actually listening. */
export async function listenTestServer(app: Express): Promise<TestHttpServer> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolveListening) => server.once('listening', () => resolveListening()));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Force-closes lingering keep-alive sockets before resolving. `server.close()` alone
 * waits for open connections to end on their own, which can leave a vitest worker
 * process hanging past the test run instead of exiting cleanly.
 */
export async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}
