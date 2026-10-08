#!/usr/bin/env node
// Claude Code hook: forwards SessionStart, UserPromptSubmit, and Stop payloads
// to the local Workbench so terminal sessions appear without transcript files.
// It must never block or fail the session: every error exits 0 silently.
import { readFileSync } from 'node:fs';

const base = (process.env.WORKBENCH_URL || 'http://127.0.0.1:5180').replace(/\/+$/, '');
const TIMEOUT_MS = 2000;

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  // `claude -p` runs (Workbench's own agents) report an sdk-* entrypoint and are
  // skipped by the server. WORKBENCH_HOOK_ALLOW_SDK=1 withholds it for end-to-end tests.
  const body = { ...payload, provider: 'claude' };
  if (entrypoint && process.env.WORKBENCH_HOOK_ALLOW_SDK !== '1') body.entrypoint = entrypoint;
  await fetch(`${base}/api/terminal-sessions/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch {
  // Workbench is down or the payload was unreadable; the session carries on.
}
process.exit(0);
