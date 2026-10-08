#!/usr/bin/env node
/** Runtime boundary for Git/GitHub mutations launched by provisioned agents. */
import { appendFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const guardDirectory = resolve(dirname(process.argv[1]));
const invokedAs = basename(process.argv[2] || '');
const args = process.argv.slice(3);

function gitSubcommand(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(value)) { index += 1; continue; }
    if (value.startsWith('-')) continue;
    return value;
  }
  return null;
}

function ghArguments(values) {
  const positional = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (['--repo', '-R', '--hostname'].includes(value)) { index += 1; continue; }
    if (value.startsWith('-')) continue;
    positional.push(value);
  }
  return positional;
}

function ghApiMutation(values) {
  let method = 'GET';
  let endpoint = '';
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '-X' || values[index] === '--method') { method = values[++index] || method; continue; }
    else if (values[index].startsWith('--method=')) method = values[index].slice('--method='.length);
    else if (values[index] !== 'api' && !values[index].startsWith('-') && !endpoint) endpoint = values[index];
  }
  return method.toUpperCase() !== 'GET' && /\/(?:comments|reviews)(?:\/|$)/i.test(endpoint);
}

export function requiredExternalCapability(command, values) {
  if (command === 'git' && gitSubcommand(values) === 'push') {
    if (values.includes('--delete') || values.includes('-d')) return { id: 'remote_branch', alternates: [], command: 'git push --delete' };
    return { id: 'push', alternates: ['pr_create'], command: 'git push' };
  }
  if (command !== 'gh') return null;
  const positional = ghArguments(values);
  if (positional[0] === 'pr' && positional[1] === 'create') return { id: 'pr_create', alternates: [], command: 'gh pr create' };
  if (positional[0] === 'pr' && positional[1] === 'merge') return { id: 'pr_lifecycle', alternates: [], command: 'gh pr merge' };
  if (positional[0] === 'pr' && ['review', 'comment'].includes(positional[1])) return { id: 'pr_review', alternates: [], command: `gh pr ${positional[1]}` };
  if (positional[0] === 'api' && ghApiMutation(values)) return { id: 'pr_review', alternates: ['github_issue'], command: 'gh api comments' };
  return null;
}

function activeCapabilities(now = Date.now()) {
  try {
    const parsed = JSON.parse(process.env.WORKBENCH_EXTERNAL_CAPABILITY || '{}');
    return Object.fromEntries(Object.entries(parsed).filter(([, expiresAt]) => Date.parse(String(expiresAt)) > now));
  } catch {
    return {};
  }
}

const required = requiredExternalCapability(invokedAs, args);
const allowedCapabilities = activeCapabilities();
const allowed = !required || [required.id, ...required.alternates].some((id) => Boolean(allowedCapabilities[id]));

if (process.env.WORKBENCH_EXTERNAL_ACTION_GUARD_CHECK_ONLY === '1') {
  process.stdout.write(`${JSON.stringify({ allowed, required })}\n`);
  process.exit(allowed ? 0 : 126);
}

if (!allowed && required) {
  const detail = `refused: ${required.command} (needs capability ${required.id})`;
  process.stderr.write(`${detail}\n`);
  const eventFile = process.env.WORKBENCH_EXTERNAL_ACTION_EVENT_FILE;
  if (eventFile) {
    try { appendFileSync(eventFile, `${JSON.stringify({ detail, command: required.command, requiredCapability: required.id })}\n`, { encoding: 'utf8' }); } catch { /* stderr remains the fail-closed audit signal */ }
  }
  process.exit(126);
}

const inheritedPath = (process.env.PATH || '').split(':').filter((entry) => resolve(entry || '.') !== guardDirectory).join(':');
const child = spawn(invokedAs, args, { stdio: 'inherit', env: { ...process.env, PATH: inheritedPath } });
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
