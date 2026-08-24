import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Points `PATH` at a directory holding fake `codex`/`claude` executables so tests can
 * exercise agent dispatch without spawning the real CLI (which would hit a live provider).
 * Callers own restoring `process.env.PATH` and removing the returned directory afterward.
 */
export function fakeAgentDirectory(codexBody: string, claudeBody: string): { directory: string; log: string } {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-agent-test-'));
  const log = join(directory, 'spawns.log');
  for (const [agent, body] of [['codex', codexBody], ['claude', claudeBody]] as const) {
    const path = join(directory, agent);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${agent}' >> '${log}'\n${body}\n`);
    chmodSync(path, 0o755);
  }
  process.env.PATH = directory;
  return { directory, log };
}
