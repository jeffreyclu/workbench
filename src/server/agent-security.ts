/**
 * Execute subprocesses run with write-capable approval settings; retryable read-only kinds use
 * each CLI's restricted mode (see `commandFor` in agent-runner.ts). In either mode, the process
 * environment is a separate boundary protecting Workbench's own secrets. The CLIs authenticate from local
 * config under HOME, not from env vars, and have no legitimate need for anything Workbench itself
 * reads via `process.env` — LINEAR_API_KEY, GITHUB_TOKEN, WORKBENCH_TOKEN, SLACK_*, CLOUDFLARE_*,
 * WORKBENCH_*_MODEL*, pricing vars, etc. This is an explicit allowlist of what the agent actually
 * needs to run, not a denylist of what it shouldn't have — new Workbench secrets are excluded by
 * default instead of requiring someone to remember to add them here.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'NODE_ENV'];

// Not a Workbench secret: proxy configuration is host/network setup the agent needs to reach its
// own provider API from behind a corporate proxy, independent of anything Workbench holds.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

const ALLOWED_AGENT_ENV_KEYS = new Set([...RUNTIME_ENV_KEYS, ...PROXY_ENV_KEYS]);

/**
 * Builds the environment for a spawned agent subprocess from `ALLOWED_AGENT_ENV_KEYS` rather than
 * inheriting the full parent environment. Everything not on the allowlist is dropped, regardless
 * of whether it looks sensitive by name.
 */
export function agentSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(source)) {
    if (!ALLOWED_AGENT_ENV_KEYS.has(key)) continue;
    const value = source[key];
    if (value !== undefined) filtered[key] = value;
  }
  return filtered;
}

export type AgentAccount = 'default' | (string & {});

export function accountProfileKey(account: string): string {
  return account.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Managed profile roots are deliberately separate from each CLI's default home.
 * An explicit env directory remains available for existing installs. */
export function managedAccountDirectory(agent: 'codex' | 'claude', account: string, source: NodeJS.ProcessEnv = process.env): string | null {
  const normalized = accountProfileKey(account);
  if (!normalized || normalized === 'DEFAULT') return null;
  const configured = source[`WORKBENCH_${agent.toUpperCase()}_ACCOUNT_${normalized}_DIR`]?.trim();
  return configured || join(source.WORKBENCH_AGENT_ACCOUNT_ROOT?.trim() || join(homedir(), '.workbench', 'agent-accounts'), agent, normalized.toLowerCase());
}

/** Select an isolated provider credential directory without putting credentials in prompts. */
export function agentAccountEnv(agent: 'codex' | 'claude', account: AgentAccount = 'default', source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = agentSubprocessEnv(source);
  const configured = managedAccountDirectory(agent, account, source);
  if (!configured) return env;
  if (!existsSync(configured) || !statSync(configured).isDirectory()) throw new Error(`No credential directory configured for ${agent} account profile "${account}".`);
  env[agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = configured;
  return env;
}
