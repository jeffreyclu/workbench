import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const CLIENT_DIST = resolve(REPO_ROOT, 'dist/client');
const REPORTED_EXTENSIONS = new Set(['.js', '.css', '.html']);

interface BundleEntry {
  file: string;
  rawBytes: number;
  gzipBytes: number;
}

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(entryPath);
    return REPORTED_EXTENSIONS.has(extname(entry.name)) ? [entryPath] : [];
  });
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function buildReport(): BundleEntry[] {
  return collectFiles(CLIENT_DIST)
    .map((file) => {
      const contents = readFileSync(file);
      return { file: relative(CLIENT_DIST, file), rawBytes: statSync(file).size, gzipBytes: gzipSync(contents).length };
    })
    .sort((a, b) => b.rawBytes - a.rawBytes);
}

const entries = buildReport();
const totalRaw = entries.reduce((sum, entry) => sum + entry.rawBytes, 0);
const totalGzip = entries.reduce((sum, entry) => sum + entry.gzipBytes, 0);

console.log('\nBundle size report (dist/client)');
console.log('---------------------------------');
for (const entry of entries) {
  console.log(`${entry.file.padEnd(40)} raw ${formatBytes(entry.rawBytes).padStart(9)}   gzip ${formatBytes(entry.gzipBytes).padStart(9)}`);
}
console.log('---------------------------------');
console.log(`${'TOTAL'.padEnd(40)} raw ${formatBytes(totalRaw).padStart(9)}   gzip ${formatBytes(totalGzip).padStart(9)}\n`);
