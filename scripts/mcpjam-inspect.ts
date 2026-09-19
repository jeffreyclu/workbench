import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const mcpjam = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpjam.cmd' : 'mcpjam');
const endpoint = process.env.MCPJAM_WORKBENCH_URL?.trim() || 'http://127.0.0.1:5180/mcp';
const artifactDirectory = join(root, 'data', 'mcpjam');

function healthUrl(): URL {
  const url = new URL(endpoint);
  url.pathname = '/api/health';
  url.search = '';
  return url;
}

function requireHealthyWorkbench(): Promise<void> {
  return new Promise((resolveHealth, rejectHealth) => {
    const request = httpGet(healthUrl(), { timeout: 1_000 }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolveHealth();
      else rejectHealth(new Error(`Workbench health returned HTTP ${response.statusCode}.`));
    });
    request.on('timeout', () => request.destroy(new Error('Workbench health check timed out.')));
    request.on('error', () => rejectHealth(new Error(`Workbench is not running at ${healthUrl().origin}. Start it before opening MCPJam.`)));
  });
}

await requireHealthyWorkbench();
mkdirSync(artifactDirectory, { recursive: true });
const validation = spawnSync(mcpjam, [
  '--no-telemetry', '--format', 'json',
  'server', 'validate', '--url', endpoint, '--access-token', 'loopback',
  '--debug-out', join(artifactDirectory, 'inspect-latest.json'),
], {
  cwd: root,
  env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
});

if (validation.error) throw validation.error;
if (validation.status !== 0) process.exit(validation.status ?? 1);

const opened = spawnSync(mcpjam, ['--no-telemetry', 'inspector', 'open', '--tab', 'tools'], {
  cwd: root,
  env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
});
if (opened.error) throw opened.error;
if (opened.status !== 0) process.exit(opened.status ?? 1);

console.log(`Workbench validated. In MCPJam Tools, connect a Streamable HTTP server named Workbench at ${endpoint}. The inspector keeps that local server configuration for later runs.`);
