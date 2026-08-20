import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function artifactRoots(workspace: string, cwd = process.cwd(), configured = process.env.WORKBENCH_ARTIFACT_ROOTS ?? ''): string[] {
  const configuredRoots = configured.split(',').map((entry) => entry.trim()).filter(Boolean);
  const defaults = [workspace, dirname(realpathSync(cwd)), join(homedir(), 'notes')];
  return [...new Set([...defaults, ...configuredRoots]
    .map((entry) => resolve(entry))
    .filter((entry) => existsSync(entry))
    .map((entry) => realpathSync(entry)))];
}

export function isArtifactAllowed(candidate: string, workspace: string, cwd = process.cwd(), configured?: string): boolean {
  const realCandidate = realpathSync(candidate);
  return artifactRoots(workspace, cwd, configured).some((root) => contains(root, realCandidate));
}
