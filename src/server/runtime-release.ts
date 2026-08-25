import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const CLIENT_ENTRY = 'client/index.html';
const SERVER_ENTRY = 'src/server/index.ts';

/**
 * A release is assembled completely off to the side.  The gateway can only
 * observe it after this validation succeeds and the `current` symlink flips.
 * This is deliberately stricter than a post-switch existence check: a failed
 * copy must retain the last known-good release.
 */
export function assertUsableRuntimeRelease(releasePath: string): void {
  const clientEntry = join(releasePath, CLIENT_ENTRY);
  const serverEntry = join(releasePath, SERVER_ENTRY);
  const manifestPath = join(releasePath, 'source-manifest.json');
  if (!existsSync(clientEntry) || !existsSync(serverEntry) || !existsSync(manifestPath)) {
    throw new Error(`Incomplete runtime release: ${releasePath}`);
  }

  const html = readFileSync(clientEntry, 'utf8');
  if (!html.includes('<html') || !html.includes('/assets/')) {
    throw new Error(`Runtime client entry is invalid: ${clientEntry}`);
  }
  const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)[^\"]*"/g)].map((match) => match[1]);
  if (assetPaths.length === 0 || assetPaths.some((asset) => !existsSync(join(releasePath, 'client', asset)))) {
    throw new Error(`Runtime client assets are incomplete: ${clientEntry}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { fingerprint?: unknown; createdAt?: unknown };
  if (typeof manifest.fingerprint !== 'string' || typeof manifest.createdAt !== 'string') {
    throw new Error(`Runtime release manifest is invalid: ${manifestPath}`);
  }
}

export function publishRuntimeRelease(root: string, releaseId: string, fingerprint: string): string {
  const runtimeRoot = join(root, '.workbench-runtime');
  const releasesRoot = join(runtimeRoot, 'releases');
  const releasePath = join(releasesRoot, releaseId);
  const stagingPath = join(releasesRoot, `.${releaseId}.staging`);
  const currentLink = join(runtimeRoot, 'current');
  const nextLink = join(runtimeRoot, `.current-${process.pid}-${Date.now()}`);

  mkdirSync(releasesRoot, { recursive: true });
  rmSync(stagingPath, { recursive: true, force: true });
  try {
    mkdirSync(stagingPath, { recursive: true });
    writeFileSync(join(stagingPath, 'source-manifest.json'), JSON.stringify({ fingerprint, createdAt: new Date().toISOString() }, null, 2));
    cpSync(join(root, 'dist/client'), join(stagingPath, 'client'), { recursive: true, errorOnExist: true });
    cpSync(join(root, 'src/server'), join(stagingPath, 'src/server'), { recursive: true, errorOnExist: true });
    cpSync(join(root, 'src/shared'), join(stagingPath, 'src/shared'), { recursive: true, errorOnExist: true });
    assertUsableRuntimeRelease(stagingPath);
    renameSync(stagingPath, releasePath);
    // A rename of a symlink is atomic on the local filesystems we support.
    symlinkSync(relative(runtimeRoot, releasePath), nextLink, 'dir');
    renameSync(nextLink, currentLink);
    return releasePath;
  } catch (error) {
    rmSync(nextLink, { force: true });
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}
