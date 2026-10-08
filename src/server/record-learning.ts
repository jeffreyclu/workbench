import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Appends a numbered lesson to a memory topic file. Markdown stays the source
 * of truth so Claude and Codex can read lessons without Workbench running; the
 * entry heading format and catalogue row mirror scripts/lint-memory-citations.ts.
 */
export class RecordLearningError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_ARGUMENT', message: string) {
    super(message);
  }
}

export interface RecordLearningDirectories {
  /** Directory holding the shared topic files; its catalogue is `<directory>/../shared-memory.md`. */
  shared: string;
  /** Directory holding knowledge topic files; its catalogue is `<directory>/index.md`. */
  knowledge: string;
}

export interface RecordLearningInput {
  file: string;
  title: string;
  body: string;
  tier?: string;
  provenance?: string;
}

export interface RecordLearningResult {
  file: string;
  id: number;
  citation: string;
  entries: number;
  path: string;
}

export function defaultRecordLearningDirectories(): RecordLearningDirectories {
  return {
    shared: join(process.cwd(), 'docs/shared-memory'),
    knowledge: join(homedir(), 'Documents/Workbench/notes/knowledge'),
  };
}

// Value patterns, not key names: a lesson body is free text, so the key-based
// trace redaction in agent-runner cannot see a pasted credential.
const secretPatterns: Array<[string, RegExp]> = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API key', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ['credential assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"']{8,}/i],
];

export function findSecretPattern(text: string): string | null {
  return secretPatterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

const provenancePattern = /^(?:https?:\/\/\S+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const numberedHeading = /^#{2,3} <a id="(\d+)"><\/a>\1\. /gm;

interface Catalogue { path: string; directory: string }

function catalogues(directories: RecordLearningDirectories): Catalogue[] {
  return [
    { directory: directories.shared, path: join(directories.shared, '..', 'shared-memory.md') },
    { directory: directories.knowledge, path: join(directories.knowledge, 'index.md') },
  ];
}

function indexedFiles(directories: RecordLearningDirectories): Map<string, Catalogue> {
  const files = new Map<string, Catalogue>();
  for (const catalogue of catalogues(directories)) {
    if (!existsSync(catalogue.path)) continue;
    for (const match of readFileSync(catalogue.path, 'utf8').matchAll(/^\| `([\w.-]+\.md)` \|/gm)) {
      if (existsSync(join(catalogue.directory, match[1]))) files.set(match[1], catalogue);
    }
  }
  return files;
}

export function recordLearning(input: RecordLearningInput, directories = defaultRecordLearningDirectories()): RecordLearningResult {
  const indexed = indexedFiles(directories);
  const catalogue = indexed.get(input.file);
  if (!catalogue) {
    throw new RecordLearningError('NOT_FOUND', `Unknown memory file "${input.file}". Valid files: ${[...indexed.keys()].sort().join(', ')}.`);
  }
  const title = input.title.replace(/\s+/g, ' ').trim();
  const body = input.body.trim();
  if (!title || !body) throw new RecordLearningError('INVALID_ARGUMENT', 'title and body are required.');
  const provenance = input.provenance?.trim();
  if (provenance && !provenancePattern.test(provenance)) {
    throw new RecordLearningError('INVALID_ARGUMENT', 'provenance must be a run id, message id, work item id (UUID), or an http(s) URL.');
  }
  const leaked = findSecretPattern(`${title}\n${body}\n${provenance ?? ''}`);
  if (leaked) throw new RecordLearningError('INVALID_ARGUMENT', `Refusing to record: the text looks like it contains a secret (${leaked}). Remove it and retry.`);
  if (/^#{1,6} /m.test(body)) throw new RecordLearningError('INVALID_ARGUMENT', 'body must not contain markdown headings; the entry heading is generated.');

  const topicPath = join(catalogue.directory, input.file);
  const source = readFileSync(topicPath, 'utf8');
  const fileTier = source.match(/^(?:---\n)?tier: (\S+)/)?.[1];
  if (input.tier && input.tier !== fileTier) {
    throw new RecordLearningError('INVALID_ARGUMENT', `${input.file} is tier "${fileTier ?? 'unknown'}", not "${input.tier}".`);
  }
  const ids = [...source.matchAll(numberedHeading)].map((match) => Number(match[1]));
  const id = Math.max(0, ...ids) + 1;
  const entry = `\n### <a id="${id}"></a>${id}. ${title}\n\n${body}\n${provenance ? `\n*Provenance: ${provenance}*\n` : ''}`;
  const entries = ids.length + 1;

  const catalogueSource = readFileSync(catalogue.path, 'utf8');
  const row = new RegExp(`^(\\| \`${input.file.replace(/\./g, '\\.')}\` \\| )\\d+( \\|)`, 'm');
  // Write the topic file only after the row is known to be updatable.
  if (!row.test(catalogueSource)) throw new RecordLearningError('NOT_FOUND', `${input.file} has no catalogue row.`);
  writeFileSync(topicPath, `${source.replace(/\s*$/, '\n')}${entry}`);
  writeFileSync(catalogue.path, catalogueSource.replace(row, `$1${entries}$2`));
  return { file: input.file, id, citation: `[${input.file}#${id}]`, entries, path: topicPath };
}
