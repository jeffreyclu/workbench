import { openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [statusPath, logPath, cwd, command] = process.argv.slice(2);

function readStatus() {
  return JSON.parse(readFileSync(statusPath, 'utf8'));
}

function writeStatus(update) {
  const status = { ...readStatus(), ...update };
  const temporary = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(status, null, 2));
  renameSync(temporary, statusPath);
}

writeStatus({ pid: process.pid });
const log = openSync(logPath, 'a');
const child = spawn('/bin/zsh', ['-c', command], {
  cwd,
  env: process.env,
  stdio: ['ignore', log, log],
});

let stopping = false;
let finalized = false;
const finalize = (update, exitCode) => {
  if (finalized) return;
  finalized = true;
  writeStatus(update);
  closeSync(log);
  process.exitCode = exitCode;
};
const stop = () => {
  stopping = true;
  try { child.kill('SIGTERM'); } catch { /* already stopped */ }
};

process.once('SIGTERM', stop);
process.once('SIGINT', stop);

child.once('error', (error) => {
  finalize({
    status: 'failed',
    exitCode: null,
    signal: null,
    error: error.message,
    completedAt: new Date().toISOString(),
  }, 1);
});

child.once('close', (code, signal) => {
  finalize({
    status: stopping || signal === 'SIGTERM' || signal === 'SIGKILL'
      ? 'canceled'
      : code === 0 ? 'completed' : 'failed',
    exitCode: code,
    signal,
    error: null,
    completedAt: new Date().toISOString(),
  }, code ?? (signal ? 1 : 0));
});
