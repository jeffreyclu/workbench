#!/usr/bin/env node
// Claude Code hook: forwards session, prompt, tool, and stop payloads
// to the local Workbench so terminal sessions appear without transcript files.
// It must never block or fail the session: every error exits 0 silently.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const base = (process.env.WORKBENCH_URL || 'http://127.0.0.1:5180').replace(/\/+$/, '');
const TIMEOUT_MS = 2000; // curl --max-time takes seconds

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  // `claude -p` runs (Workbench's own agents) report an sdk-* entrypoint and are
  // skipped by the server. WORKBENCH_HOOK_ALLOW_SDK=1 withholds both payload and
  // environment forms for end-to-end tests.
  const { entrypoint: payloadEntrypoint, ...hookPayload } = payload;
  const body = { ...hookPayload, provider: 'claude' };
  if (process.env.WORKBENCH_HOOK_ALLOW_SDK !== '1' && (entrypoint || payloadEntrypoint)) body.entrypoint = entrypoint || payloadEntrypoint;
  // Hand the request to a detached child and return at once, so a busy or
  // stopped Workbench never delays Jeffrey's prompt. The child gives up after
  // TIMEOUT_MS on its own.
  const child = spawn('curl', [
    '--silent', '--output', '/dev/null', '--max-time', String(TIMEOUT_MS / 1000),
    '--header', 'content-type: application/json', '--data-binary', '@-',
    `${base}/api/terminal-sessions/events`,
  ], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify(body));
  child.unref();
} catch {
  // Workbench is down or the payload was unreadable; the session carries on.
}
process.exit(0);
