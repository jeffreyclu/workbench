import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Registers scripts/claude-hook-bridge.mjs for SessionStart, UserPromptSubmit,
// and Stop in the Claude Code settings file. Existing hooks are kept; a previous
// bridge entry is replaced, so re-running after a checkout moves is safe.
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json');
const bridge = resolve(dirname(fileURLToPath(import.meta.url)), 'claude-hook-bridge.mjs');
const command = `node ${JSON.stringify(bridge)}`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];

type HookEntry = { hooks?: Array<{ type?: string; command?: string; timeout?: number }> };

let settings: Record<string, unknown> = {};
try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, HookEntry[]>;
for (const event of EVENTS) {
  const kept = (hooks[event] ?? []).filter((entry) => !entry.hooks?.some((hook) => hook.command?.includes('claude-hook-bridge.mjs')));
  hooks[event] = [...kept, { hooks: [{ type: 'command', command, timeout: 5 }] }];
}
settings.hooks = hooks;
mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Registered ${bridge} for ${EVENTS.join(', ')} in ${settingsPath}`);
