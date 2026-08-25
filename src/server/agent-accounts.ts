import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentAccountEnv, accountProfileKey, managedAccountDirectory } from './agent-security.js';

export type AccountProvider = 'codex' | 'claude';
export interface AgentAccountProfile {
  name: string;
  providers: Record<AccountProvider, { configured: boolean; loggedIn: boolean; email: string | null; detail: string | null }>;
}

const providers: AccountProvider[] = ['codex', 'claude'];
const profileName = (value: string): string => {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(name)) throw new Error('Account profile must use letters, numbers, spaces, hyphens, or underscores.');
  return name;
};
const root = (source: NodeJS.ProcessEnv = process.env) => source.WORKBENCH_AGENT_ACCOUNT_ROOT?.trim() || join(homedir(), '.workbench', 'agent-accounts');

export function parseAgentAccountStatus(provider: AccountProvider, stdout: string, stderr: string, succeeded: boolean) {
  const detail = [stdout, stderr].filter(Boolean).join('\n').trim() || null;
  if (!succeeded) return { loggedIn: false, email: null, detail };
  if (provider === 'claude') {
    try {
      const status = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; authMethod?: string };
      return { loggedIn: Boolean(status.loggedIn), email: status.email ?? null, detail: status.authMethod ?? null };
    } catch {
      return { loggedIn: false, email: null, detail };
    }
  }
  // Codex 0.149 writes `Logged in using ChatGPT` to stderr, even on success.
  return { loggedIn: /Logged in/i.test(detail ?? ''), email: null, detail };
}

function readStatus(provider: AccountProvider, name: string, source: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(provider, provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], {
    env: agentAccountEnv(provider, name, source), encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : result.error?.message ?? '';
  return parseAgentAccountStatus(provider, stdout, stderr, result.status === 0 && !result.error);
}

export function listAgentAccounts(source: NodeJS.ProcessEnv = process.env): AgentAccountProfile[] {
  const names = new Map<string, string>([['default', 'default']]);
  for (const provider of providers) {
    const directory = join(root(source), provider);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) names.set(entry.name, entry.name);
  }
  return [...names.values()].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)).map((name) => ({
    name,
    providers: Object.fromEntries(providers.map((provider) => {
      const directory = managedAccountDirectory(provider, name, source);
      const configured = name === 'default' || Boolean(directory && existsSync(directory));
      return [provider, { configured, ...(configured ? readStatus(provider, name, source) : { loggedIn: false, email: null, detail: null }) }];
    })) as AgentAccountProfile['providers'],
  }));
}

/** Opens the provider's own interactive login in Terminal. The CLI opens its browser
 * OAuth page, where Google sign-in remains between the provider and Google. */
export function startAgentAccountLogin(provider: AccountProvider, rawName: string, source: NodeJS.ProcessEnv = process.env): AgentAccountProfile[] {
  const name = profileName(rawName);
  const directory = managedAccountDirectory(provider, name, source);
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = directory ? `${provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'}=${shellQuote(directory)} ` : '';
  const command = provider === 'codex' ? 'codex login' : 'claude auth login --claudeai';
  const terminalCommand = `${env}${command}; printf '\\nLogin finished. You can close this window.\\n'`;
  const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(`exec ${process.env.SHELL || '/bin/zsh'} -lc ${shellQuote(terminalCommand)}`)}\nend tell`;
  execFileSync('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
  return listAgentAccounts(source);
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function appleScriptString(value: string): string { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
