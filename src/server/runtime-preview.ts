import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SOURCE_DIRECTORIES = ['src/client', 'src/server', 'src/shared', 'scripts'];
const SOURCE_FILES = ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json'];

function runtimeSourceFiles(root: string) {
  const files: string[] = [];
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) files.push(path);
  };
  for (const directory of SOURCE_DIRECTORIES) visit(join(root, directory));
  for (const file of SOURCE_FILES) visit(join(root, file));
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export function runtimeSourceFingerprint(root = process.cwd()) {
  const resolvedRoot = resolve(root);
  const hash = createHash('sha256');
  for (const file of runtimeSourceFiles(resolvedRoot)) {
    hash.update(relative(resolvedRoot, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface RuntimeSourceManifest {
  fingerprint: string;
  createdAt: string;
}

export function runtimePreviewStatus(root = process.cwd()) {
  const currentFingerprint = runtimeSourceFingerprint(root);
  const manifestPath = join(resolve(root), '.workbench-runtime', 'current', 'source-manifest.json');
  let manifest: RuntimeSourceManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeSourceManifest;
  } catch {
    // An older release without a manifest is necessarily behind the editable source.
  }
  return {
    pending: manifest?.fingerprint !== currentFingerprint,
    currentFingerprint,
    promotedFingerprint: manifest?.fingerprint ?? null,
    promotedAt: manifest?.createdAt ?? null,
  };
}
