import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createAuthGate } from './src/server/auth.js';

// The dev server, not Express, answers the HTML request when Workbench is
// reached over a tunnel, so the same shared secret has to gate it too.
export function authGatePlugin(token: string | null, env: NodeJS.ProcessEnv): Plugin {
  return {
    name: 'workbench-auth-gate',
    configureServer(server) {
      const gate = createAuthGate(token, env);
      server.middlewares.use((request, response, next) => gate(request, response, next));
    },
  };
}

/**
 * The default preview is a live-data mirror: it may read production through
 * Vite's proxy, but it must never use that proxy to mutate production. Keeping
 * this guard in front of the proxy makes the rule true even if the client UI
 * accidentally leaves an action enabled.
 */
export function previewReadOnlyPlugin(enabled: boolean): Plugin {
  return {
    name: 'workbench-preview-read-only',
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) return next();
        response.statusCode = 403;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: 'Preview mirrors live data and is read-only. Run this action from production.', code: 'PREVIEW_READ_ONLY' }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const token = env.WORKBENCH_TOKEN?.trim() || null;
  const previewReadOnly = process.env.WORKBENCH_PREVIEW_READ_ONLY === '1';
  return {
    plugins: [react(), authGatePlugin(token, env), previewReadOnlyPlugin(previewReadOnly)],
    server: {
      port: 5180,
      // LAN/Tailscale access (npm run dev:lan) arrives with a non-localhost Host
      // header. IP literals are permitted by Vite already; the tailnet domain is
      // not, so allow it explicitly.
      allowedHosts: [
        '.chicken-dojo.ts.net',
        '.trycloudflare.com',
        'broiling-recoil-grouped.ngrok-free.dev',
      ],
      proxy: {
        '/api': {
          target: process.env.WORKBENCH_API_TARGET?.trim() || 'http://localhost:4317',
          ws: true,
          // The Vite gate has already authenticated non-loopback requests. This
          // also lets local development reach an API process started before a
          // localhost-auth configuration change.
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          ...(previewReadOnly ? { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Workbench-Preview-Mirror': '1' } } : {}),
        },
      },
    },
    build: {
      outDir: 'dist/client',
    },
  };
});
