/**
 * Spawned coding-agent subprocesses (Claude Code / Codex CLIs) run with their own tool-approval
 * sandbox bypassed (see `commandFor` in agent-runner.ts), so the process environment is the only
 * remaining boundary between them and Workbench's own secrets. The CLIs authenticate from local
 * config under HOME, not from env vars, and have no legitimate need for anything Workbench itself
 * reads via `process.env` — LINEAR_API_KEY, GITHUB_TOKEN, WORKBENCH_TOKEN, SLACK_*, CLOUDFLARE_*,
 * WORKBENCH_*_MODEL*, pricing vars, etc. This is an explicit allowlist of what the agent actually
 * needs to run, not a denylist of what it shouldn't have — new Workbench secrets are excluded by
 * default instead of requiring someone to remember to add them here.
 */
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
