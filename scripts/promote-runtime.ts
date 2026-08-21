import { cpSync, existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runtimeSourceFingerprint } from '../src/server/runtime-preview.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const runtimeRoot = join(root, '.workbench-runtime');
const releasesRoot = join(runtimeRoot, 'releases');
const releaseId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const releasePath = join(releasesRoot, releaseId);
const nextLink = join(runtimeRoot, `.current-${process.pid}`);
const currentLink = join(runtimeRoot, 'current');

function activeAgentProcesses(): string[] {
  const processList = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  return processList.split('\n').filter((command) =>
    (command.includes('codex exec') && command.includes(`-C ${root}`))
    || (command.includes('claude -p') && command.includes(`--add-dir ${root}`)),
  );
}

const activeAgents = activeAgentProcesses();
if (activeAgents.length > 0) {
  console.error(`Refusing to promote Workbench while ${activeAgents.length} live agent process${activeAgents.length === 1 ? ' is' : 'es are'} working in the source checkout. Wait for them to finish, then explicitly approve the preview.`);
  process.exit(2);
}

const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

// Building takes long enough for a new chat/run to start after the first
// safety check. Check again immediately before switching the runtime snapshot;
// otherwise the gateway restart interrupts work that began during the build.
const agentsStartedDuringBuild = activeAgentProcesses();
if (agentsStartedDuringBuild.length > 0) {
  console.error(`Preview verified, but ${agentsStartedDuringBuild.length} agent process${agentsStartedDuringBuild.length === 1 ? ' started' : 'es started'} while it was building. Live was not changed; approve again after the active work finishes.`);
  process.exit(2);
}

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
