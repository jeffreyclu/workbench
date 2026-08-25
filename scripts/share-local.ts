// Temporarily point Workbench's single reserved ngrok hostname at an already
// running local app. This is intentionally owned by Workbench, not by the
// project being tested.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const target = process.argv[2];
const usage = 'Usage: npm run share -- http://127.0.0.1:<port>';

if (!target) {
  console.error(usage);
  process.exit(1);
}

let url: URL;
try {
  url = new URL(target);
} catch {
  console.error(`Invalid local URL: ${target}`);
  process.exit(1);
}

if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
  console.error(`The target must be a local HTTP URL. ${usage}`);
  process.exit(1);
}

const envPath = new URL('../.env', import.meta.url).pathname;
const envDomain = existsSync(envPath)
  ? readFileSync(envPath, 'utf8').split('\n').find((line) => line.startsWith('NGROK_DOMAIN='))?.slice('NGROK_DOMAIN='.length).trim()
  : undefined;
const domain = process.env.NGROK_DOMAIN?.trim() || envDomain;

if (!domain) {
  console.error(`NGROK_DOMAIN is required in ${envPath}.`);
  process.exit(1);
}

async function verifyTarget(candidate: URL): Promise<void> {
  const response = await fetch(candidate, { signal: AbortSignal.timeout(3_000), redirect: 'manual' });
  if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
}

try {
  await verifyTarget(url);
} catch (error) {
  // Vite may bind only the IPv6 loopback address. `localhost` follows that
  // listener while an explicit 127.0.0.1 target cannot.
  if (url.hostname === '127.0.0.1') {
    const localhostUrl = new URL(url);
    localhostUrl.hostname = 'localhost';
    try {
      await verifyTarget(localhostUrl);
      url = localhostUrl;
    } catch {
      console.error(`Nothing usable is serving at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    console.error(`Nothing usable is serving at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (spawnSync('ngrok', ['version'], { stdio: 'ignore' }).error) {
  console.error('ngrok is not installed. Install it with: brew install ngrok');
  process.exit(1);
}

const uid = process.getuid?.();
const label = 'com.jeffrey.workbench.ngrok';
const watchdogLabel = 'com.jeffrey.workbench.ngrok-watchdog';
const service = uid === undefined ? null : `gui/${uid}/${label}`;
const workbenchWasSharing = service !== null && spawnSync('launchctl', ['print', service], { stdio: 'ignore' }).status === 0;

if (workbenchWasSharing && uid !== undefined) {
  spawnSync('launchctl', ['bootout', `gui/${uid}/${watchdogLabel}`], { stdio: 'ignore' });
  const stopped = spawnSync('launchctl', ['bootout', service!], { stdio: 'inherit' });
  if (stopped.status !== 0) {
    console.error('Could not stop Workbench\'s tunnel; refusing to compete for the shared hostname.');
    process.exit(1);
  }
}

let stopping = false;
// Vite rejects arbitrary Host headers by default. Preserve the target's local
// host while the browser still connects through the public ngrok hostname.
const tunnel = spawn('ngrok', [
  'http',
  url.origin,
  `--url=https://${domain}`,
  `--request-header-add=Host: ${url.host}`,
  '--log',
  'stdout',
], { stdio: 'inherit' });
const publicUrl = `https://${domain}`;

async function verifyPublicUrl(): Promise<void> {
  let lastError = 'no response';
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(publicUrl, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
      if (response.ok) {
        console.log(`Public check passed: ${publicUrl} returned HTTP ${response.status}. Press Ctrl-C to stop and restore Workbench's tunnel.`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  console.error(`Public check failed for ${publicUrl}: ${lastError}. Stopping the share session.`);
  restore();
}

console.log(`Starting share of ${url.origin} at ${publicUrl}; waiting for the public check.`);
void verifyPublicUrl();

function restore(): void {
  if (stopping) return;
  stopping = true;
  tunnel.kill('SIGTERM');
  if (workbenchWasSharing) {
    const result = spawnSync('zsh', ['scripts/install-ngrok-supervisor.sh'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' });
    if (result.status !== 0) console.error('Workbench tunnel was not restored; run npm run ngrok:install-supervisor from Workbench.');
  }
}

process.on('SIGINT', restore);
process.on('SIGTERM', restore);
tunnel.on('exit', (code) => {
  if (!stopping) console.error(`ngrok exited unexpectedly (code ${code ?? 0}).`);
  restore();
  process.exit(code ?? 1);
});
