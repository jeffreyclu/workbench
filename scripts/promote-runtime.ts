import { cpSync, existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeSourceFingerprint } from '../src/server/runtime-preview.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const runtimeRoot = join(root, '.workbench-runtime');
const releasesRoot = join(runtimeRoot, 'releases');
const releaseId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const releasePath = join(releasesRoot, releaseId);
const nextLink = join(runtimeRoot, `.current-${process.pid}`);
const currentLink = join(runtimeRoot, 'current');

const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(releasePath, { recursive: true });
writeFileSync(join(releasePath, 'source-manifest.json'), JSON.stringify({
  fingerprint: runtimeSourceFingerprint(root),
  createdAt: new Date().toISOString(),
}, null, 2));
cpSync(join(root, 'dist/client'), join(releasePath, 'client'), { recursive: true });
cpSync(join(root, 'src/server'), join(releasePath, 'src/server'), { recursive: true });
cpSync(join(root, 'src/shared'), join(releasePath, 'src/shared'), { recursive: true });

rmSync(nextLink, { force: true });
symlinkSync(relative(runtimeRoot, releasePath), nextLink, 'dir');
renameSync(nextLink, currentLink);

const target = readlinkSync(currentLink);
if (!existsSync(resolve(runtimeRoot, target, 'client/index.html'))) {
  throw new Error('Runtime promotion did not produce a usable client snapshot.');
}
console.log(`Promoted Workbench runtime ${releaseId}. The stable gateway will switch to it after its health check.`);
