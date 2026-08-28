#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const guardDirectory = resolve(dirname(process.argv[1]));
// The guard ships inside the Workbench checkout: scripts/workbench-agent-bin.
const workbenchRoot = resolve(guardDirectory, '..', '..');
const args = process.argv.slice(2);
const inheritedPath = (process.env.PATH || '').split(':').filter((entry) => resolve(entry || '.') !== guardDirectory).join(':');

// Leading options may relocate the command; -C decides which repository it hits.
let index = 0;
let cwd = process.cwd();
while (index < args.length && args[index].startsWith('-')) {
  if (args[index] === '-C') { cwd = resolve(cwd, args[index + 1] ?? '.'); index += 2; }
  else index += 1;
}
const subcommand = args[index] || '';
const rest = args.slice(index + 1);

const branchReadOnly = new Set(['', '--show-current', '--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '--verbose']);
// `git checkout <tree-ish> -- <paths>` restores files; it never moves HEAD, and
// integration depends on it to refresh the primary checkout after a commit.
const pathspecScoped = rest.includes('--');
const mutatesBranchOrWorktree = (subcommand === 'checkout' && !pathspecScoped)
  || subcommand === 'switch'
  || (subcommand === 'worktree' && rest[0] !== 'list')
  || (subcommand === 'branch' && !rest.every((argument) => branchReadOnly.has(argument) || argument.startsWith('--format=')));

const canonical = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * The guard exists to keep the Workbench repository itself on main. It is on
 * PATH for the whole agent process, so it would otherwise also govern scratch
 * repositories under /tmp and any other checkout the agent legitimately works
 * in. Enforce against the target repository, not against the command's name.
 */
function targetsWorkbenchRepository() {
  let toplevel = '';
  try {
    toplevel = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: inheritedPath } }).trim();
  } catch {
    return false; // Not a repository, or Git cannot answer: nothing to protect.
  }
  if (!toplevel) return false;
  const resolved = canonical(toplevel);
  return resolved === canonical(workbenchRoot) || resolved.includes('/.workbench/run-worktrees/workbench-');
}

if (mutatesBranchOrWorktree && targetsWorkbenchRepository()) {
  process.stderr.write(`Workbench blocked Git branch/worktree mutation: git ${args.join(' ')}\nWorkbench work must remain on main; detached run worktrees are managed only by the runtime.\n`);
  process.exit(126);
}

const child = spawn('git', args, { stdio: 'inherit', env: { ...process.env, PATH: inheritedPath } });
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
