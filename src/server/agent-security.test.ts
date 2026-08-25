import { describe, expect, it } from 'vitest';
import { agentAccountEnv, agentSubprocessEnv } from './agent-security.js';

describe('agentSubprocessEnv', () => {
  it('keeps only the runtime environment a spawned agent CLI needs to run', () => {
    const source = { PATH: '/usr/bin', HOME: '/Users/jeffrey', TERM: 'xterm-256color' };
    expect(agentSubprocessEnv(source)).toEqual(source);
  });

  it('drops every Workbench application secret and pricing/config var, however it is named', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/Users/jeffrey',
      WORKBENCH_TOKEN: 'secret-token',
      LINEAR_API_KEY: 'linear-secret',
      GITHUB_TOKEN: 'github-secret',
      SLACK_BOT_TOKEN: 'slack-secret',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x',
      CLOUDFLARE_API_TOKEN: 'cf-secret',
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      FIGMA_ACCESS_TOKEN: 'figma-secret',
      DATABASE_PATH: './data/workbench.db',
      WORKBENCH_CODEX_MODEL: 'gpt-5.6-terra',
      WORKBENCH_CODEX_INPUT_TOKEN_USD_PER_MILLION: '2',
      APP_ORIGIN: 'http://localhost:5180',
    };
    const filtered = agentSubprocessEnv(source);
    expect(filtered).toEqual({ PATH: '/usr/bin', HOME: '/Users/jeffrey' });
    expect(filtered.WORKBENCH_TOKEN).toBeUndefined();
    expect(filtered.LINEAR_API_KEY).toBeUndefined();
    expect(filtered.GITHUB_TOKEN).toBeUndefined();
    expect(filtered.CLOUDFLARE_API_TOKEN).toBeUndefined();
  });

  it('passes proxy configuration through since it is network setup, not a Workbench secret', () => {
    const source = { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.internal:8080', WORKBENCH_TOKEN: 'secret' };
    const filtered = agentSubprocessEnv(source);
    expect(filtered.HTTPS_PROXY).toBe('http://proxy.internal:8080');
    expect(filtered.WORKBENCH_TOKEN).toBeUndefined();
  });

  it('never leaks an env var by silently allowlisting an undefined value', () => {
    const filtered = agentSubprocessEnv({ PATH: undefined } as unknown as NodeJS.ProcessEnv);
    expect(filtered).toEqual({});
  });
});

describe('agentAccountEnv', () => {
  it('selects isolated Claude and Codex credential directories', () => {
    expect(agentAccountEnv('claude', 'personal', { PATH: '/bin', HOME: '/tmp', WORKBENCH_CLAUDE_ACCOUNT_PERSONAL_DIR: '/tmp' })).toMatchObject({ CLAUDE_CONFIG_DIR: '/tmp' });
    expect(agentAccountEnv('codex', 'personal', { PATH: '/bin', HOME: '/tmp', WORKBENCH_CODEX_ACCOUNT_PERSONAL_DIR: '/tmp' })).toMatchObject({ CODEX_HOME: '/tmp' });
  });

  it('fails closed for unknown profiles', () => {
    expect(() => agentAccountEnv('claude', 'missing', { PATH: '/bin', HOME: '/tmp' })).toThrow(/No credential directory configured/);
  });
});
