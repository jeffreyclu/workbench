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

/**
 * The share session outlives any single tunnel process. Two things used to end
 * it silently: the Mac idle-sleeping (which drops the tunnel), and this script
 * exiting the moment its tunnel child exited. Either one left a dead link and
 * no message, so the tunnel looked like it "went down again" with nothing to
 * restart it. Now the session holds the machine awake for as long as it is
 * sharing, restarts the tunnel with backoff, and probes the public URL so a
 * process that is alive but no longer serving is also restarted.
 */
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const HEALTHY_UPTIME_MS = 60_000;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_FAILURES_BEFORE_RESTART = 2;

// caffeinate is held for the session, not wrapped around the tunnel: wrapping
// meant the assertion died with the tunnel, exactly when it was still needed.
// -d display, -i idle, -m disk, -s system (AC only, ignored on battery).
const keepAwake = process.platform === 'darwin'
  ? spawn('caffeinate', ['-dims'], { stdio: 'ignore' })
  : null;
keepAwake?.on('error', () => console.error('Could not hold the machine awake; the tunnel will drop when this Mac sleeps.'));

let tunnel: ReturnType<typeof spawn> | null = null;
let restarts = 0;
let stopping = false;
let announcedOnce = false;
let probeFailures = 0;

function stamp(): string {
  return new Date().toLocaleTimeString();
}

function startTunnel(): void {
  if (stopping) return;
  const startedAt = Date.now();
  const child = spawn(plan.command, plan.args, { stdio: ['ignore', plan.url ? 'ignore' : 'inherit', 'pipe'] });
  tunnel = child;
  child.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'ENOENT' ? `${plan.command} is not installed. Run: ${plan.install}` : String(error));
    if (error.code === 'ENOENT') { stopping = true; keepAwake?.kill(); process.exit(1); }
  });

  if (plan.url) {
    child.on('spawn', () => {
      probeFailures = 0;
      if (announcedOnce) console.log(`  [${stamp()}] Tunnel restarted (${restarts} so far). ${plan.url} is back.`);
      else { announcedOnce = true; announce(plan.url!); }
    });
    child.stderr?.pipe(process.stderr);
  } else {
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (!url) return;
      probeFailures = 0;
      if (!announcedOnce) console.log('\n  Random hostname — you will need the ?token= link again tomorrow.\n  Set NGROK_DOMAIN in .env for a stable one. See README.');
      announcedOnce = true;
      announce(url);
    });
  }

  child.on('exit', (code) => {
    if (stopping) return;
    // A tunnel that stayed up is a fresh failure, not an escalating one.
    if (Date.now() - startedAt > HEALTHY_UPTIME_MS) restarts = 0;
    const delay = RESTART_BACKOFF_MS[Math.min(restarts, RESTART_BACKOFF_MS.length - 1)];
    restarts += 1;
    console.error(`  [${stamp()}] Tunnel exited (code ${code ?? 0}). Restarting in ${delay / 1_000}s.`);
    setTimeout(startTunnel, delay).unref();
  });
}

/**
 * A tunnel process can stay alive while its session is gone — after a sleep or a
 * network change the link is dead but nothing exited. Probing the public URL is
 * the only check that reflects what a browser would actually get.
 */
async function probePublicUrl(): Promise<void> {
  if (stopping || !plan.url || !tunnel) return;
  try {
    const response = await fetch(`${plan.url}/api/health`, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (response.status >= 500) throw new Error(`status ${response.status}`);
    probeFailures = 0;
  } catch (error) {
    probeFailures += 1;
    console.error(`  [${stamp()}] Public URL probe failed (${probeFailures}/${PROBE_FAILURES_BEFORE_RESTART}): ${error instanceof Error ? error.message : String(error)}`);
    if (probeFailures >= PROBE_FAILURES_BEFORE_RESTART) {
      probeFailures = 0;
      console.error(`  [${stamp()}] Restarting the tunnel: the process is alive but the public URL is not serving.`);
      tunnel.kill('SIGTERM');
    }
  }
}

startTunnel();
setInterval(() => void probePublicUrl(), PROBE_INTERVAL_MS).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
  process.on(signal, () => {
    stopping = true;
    tunnel?.kill(signal);
    keepAwake?.kill();
    process.exit(0);
  });
}
