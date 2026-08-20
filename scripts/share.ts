// Publishes the local Workbench through an outbound tunnel and prints the
// authorized link. Outbound-only, so the managed-Mac inbound firewall never
// sees it.
//
// Three modes, picked from .env / the environment:
//   NGROK_DOMAIN=xyz.ngrok-free.app   -> ngrok, stable hostname (recommended)
//   TUNNEL_HOSTNAME=work.example.com  -> cloudflared named tunnel, stable hostname
//   (neither)                         -> cloudflared quick tunnel, random hostname
//
// A stable hostname matters for daily use: the auth cookie is scoped to the
// host, so a fresh hostname means re-opening the ?token= link every single time.
// Cloudflare is forced onto HTTP/2 because outbound QUIC on UDP 7844 is blocked
// on the Writer network.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { generateToken } from '../src/server/auth.js';

const target = process.argv[2] ?? 'http://localhost:5173';
const port = new URL(target).port || '80';
const envPath = new URL('../.env', import.meta.url).pathname;

function env(key: string) {
  if (process.env[key]?.trim()) return process.env[key]!.trim();
  if (!existsSync(envPath)) return null;
  const line = readFileSync(envPath, 'utf8').split('\n').find((entry) => entry.startsWith(`${key}=`));
  return line?.slice(line.indexOf('=') + 1).trim() || null;
}

let token = env('WORKBENCH_TOKEN');
if (!token) {
  token = generateToken();
  appendFileSync(envPath, `${readFileSync(envPath, 'utf8').endsWith('\n') ? '' : '\n'}WORKBENCH_TOKEN=${token}\n`);
  console.log('Wrote a new WORKBENCH_TOKEN to .env — restart the dev servers so both the API and Vite pick it up, then rerun this.');
  process.exit(1);
}

const ngrokDomain = env('NGROK_DOMAIN');
const cloudflareHostname = env('TUNNEL_HOSTNAME');

const plan = ngrokDomain
  ? { command: 'ngrok', args: ['http', port, `--domain=${ngrokDomain}`, '--log', 'stdout'], url: `https://${ngrokDomain}`, install: 'brew install ngrok && ngrok config add-authtoken <token>' }
  : cloudflareHostname
    ? { command: 'cloudflared', args: ['tunnel', '--protocol', 'http2', 'run', '--url', target, 'workbench'], url: `https://${cloudflareHostname}`, install: 'brew install cloudflared' }
    : { command: 'cloudflared', args: ['tunnel', '--protocol', 'http2', '--url', target], url: null, install: 'brew install cloudflared' };

function announce(url: string) {
  console.log(`\n  ${url}\n\n  First visit on a new device: open ${url}/?token=${token} once — it sets a\n  one-year cookie, then the bare URL works. Anyone with that link has full\n  read/write Workbench. Ctrl-C to take it down.\n`);
}

const tunnelCommand = process.platform === 'darwin' ? 'caffeinate' : plan.command;
const tunnelArgs = process.platform === 'darwin' ? ['-i', '--', plan.command, ...plan.args] : plan.args;
const tunnel = spawn(tunnelCommand, tunnelArgs, { stdio: ['ignore', plan.url ? 'ignore' : 'inherit', 'pipe'] });
tunnel.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'ENOENT' ? `${tunnelCommand} is not installed.${tunnelCommand === plan.command ? ` Run: ${plan.install}` : ''}` : String(error));
  process.exit(1);
});

if (plan.url) {
  tunnel.on('spawn', () => announce(plan.url!));
  tunnel.stderr.pipe(process.stderr);
} else {
  let announced = false;
  tunnel.stderr.on('data', (chunk) => {
    const text = String(chunk);
    process.stderr.write(text);
    const url = announced ? null : text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (!url) return;
    announced = true;
    console.log('\n  Random hostname — you will need the ?token= link again tomorrow.\n  Set NGROK_DOMAIN in .env for a stable one. See README.');
    announce(url);
  });
}

tunnel.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) process.on(signal, () => tunnel.kill(signal));
