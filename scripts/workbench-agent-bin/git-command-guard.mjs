#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const guardDirectory = resolve(dirname(process.argv[1]));
const args = process.argv.slice(2);
let index = 0;
while (index < args.length && args[index].startsWith('-')) index += args[index] === '-C' ? 2 : 1;
const subcommand = args[index] || '';
const branchReadOnly = new Set(['', '--show-current', '--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '--verbose']);
const branchArgs = args.slice(index + 1);
const blocked = subcommand === 'checkout' || subcommand === 'switch' || subcommand === 'worktree'
  || (subcommand === 'branch' && !branchArgs.every((argument) => branchReadOnly.has(argument) || argument.startsWith('--format=')));

if (blocked) {
  process.stderr.write(`Workbench blocked Git branch/worktree mutation: git ${args.join(' ')}\nWorkbench work must remain on main; detached run worktrees are managed only by the runtime.\n`);
  process.exit(126);
}

const inheritedPath = (process.env.PATH || '').split(':').filter((entry) => resolve(entry || '.') !== guardDirectory).join(':');
const child = spawn('git', args, { stdio: 'inherit', env: { ...process.env, PATH: inheritedPath } });
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
