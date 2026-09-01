#!/usr/bin/env node
/** Bounds network probes launched by coding agents without disabling curl. */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const guardDirectory = resolve(dirname(process.argv[1]));
const input = process.argv.slice(2);
const output = [];
let hasMaxTime = false;
let hasConnectTimeout = false;

const boundedNumber = (value, maximum) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? String(Math.min(numeric, maximum)) : value;
};

for (let index = 0; index < input.length; index += 1) {
  const argument = input[index];
  if (argument === '--retry') {
    output.push(argument, boundedNumber(input[++index], 2));
  } else if (argument.startsWith('--retry=')) {
    output.push(`--retry=${boundedNumber(argument.slice('--retry='.length), 2)}`);
  } else if (argument === '--max-time' || argument === '-m') {
    hasMaxTime = true;
    output.push(argument, boundedNumber(input[++index], 20));
  } else if (argument.startsWith('--max-time=')) {
    hasMaxTime = true;
    output.push(`--max-time=${boundedNumber(argument.slice('--max-time='.length), 20)}`);
  } else if (argument === '--connect-timeout') {
    hasConnectTimeout = true;
    output.push(argument, boundedNumber(input[++index], 10));
  } else if (argument.startsWith('--connect-timeout=')) {
    hasConnectTimeout = true;
    output.push(`--connect-timeout=${boundedNumber(argument.slice('--connect-timeout='.length), 10)}`);
  } else {
    output.push(argument);
  }
}

if (!hasMaxTime) output.unshift('--max-time', '20');
if (!hasConnectTimeout) output.unshift('--connect-timeout', '10');

if (process.env.WORKBENCH_CURL_GUARD_CHECK_ONLY === '1') {
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

const inheritedPath = (process.env.PATH || '').split(':').filter((entry) => resolve(entry || '.') !== guardDirectory).join(':');
const child = spawn('curl', output, { stdio: 'inherit', env: { ...process.env, PATH: inheritedPath } });
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
