import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createAuthGate } from './src/server/auth.js';

// The dev server, not Express, answers the HTML request when Workbench is
// reached over a tunnel, so the same shared secret has to gate it too.
function authGatePlugin(token: string | null): Plugin {
  return {
    name: 'workbench-auth-gate',
    configureServer(server) {
      const gate = createAuthGate(token);
      server.middlewares.use((request, response, next) => gate(request, response, next));
    },
  };
}

export default defineConfig(({ mode }) => {
  const token = loadEnv(mode, process.cwd(), '').WORKBENCH_TOKEN?.trim() || null;
  return {
    plugins: [react(), authGatePlugin(token)],
    server: {
      port: 5173,
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
          // The Vite gate has already authenticated non-loopback requests. This
          // also lets local development reach an API process started before a
          // localhost-auth configuration change.
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
      },
    },
    build: {
      outDir: 'dist/client',
    },
  };
});
