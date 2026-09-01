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
        const method = request.method ?? 'GET';
        const pathname = request.url?.split('?')[0] ?? '';
        // Review AI writes only replaceable derived cache entries. It does not
        // mutate tasks, conversations, repositories, or external services, so
        // preview must be able to compute it just as it can perform a GET.
        const derivedAssist = method === 'POST' && [
          '/api/review-assist',
          '/api/review-assist/stream',
          '/api/review-assist/lookup',
          '/api/diff-confidence',
          '/api/diff-confidence/stream',
          '/api/diff-confidence/lookup',
        ].includes(pathname);
        if (!pathname.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(method) || derivedAssist) return next();
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
    cacheDir: process.env.WORKBENCH_VITE_CACHE_DIR?.trim() || undefined,
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
      rollupOptions: {
        output: {
          // Keep vendor code in stable cacheable chunks. This also keeps the
          // entry bundle below Vite's warning threshold as the app grows.
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) return 'react';
            if (id.includes('/node_modules/@tanstack/')) return 'query';
            if (id.includes('/node_modules/@lexical/') || id.includes('/node_modules/lexical/')) return 'editor';
            if (id.includes('/node_modules/@dnd-kit/')) return 'drag-drop';
            if (id.includes('/node_modules/@babel/parser/')) return 'parser';
            if (id.includes('/node_modules/@huggingface/transformers/') || id.includes('/node_modules/onnxruntime-')) return 'ml';
          },
        },
      },
    },
  };
});
