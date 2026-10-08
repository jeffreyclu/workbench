import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultRecordLearningDirectories,
  indexedFiles,
  recordLearning,
  RecordLearningError,
  type RecordLearningDirectories,
} from './record-learning.js';

/**
 * The only path that removes a numbered memory entry. Every removal first
 * appends the entry's full text to docs/shared-memory/discard-log.md, re-reads
 * the log to confirm it landed, then replaces the entry with a tombstone that
 * keeps its number (so `[file.md#N]` citations still resolve) and re-reads the
 * source to confirm. There is deliberately no exported raw delete.
 */
export const DISCARD_LOG_FILE = 'discard-log.md';

export class DiscardLogError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'VERIFICATION_FAILED', message: string) {
    super(message);
  }
}

export interface RemoveEntriesInput {
  file: string;
  numbers: number[];
  reason: string;
  /** Citation of the entry that supersedes each removed number, e.g. `[topic.md#3]`; omit when none. */
  supersededBy?: Record<number, string>;
  /** ISO date (YYYY-MM-DD); defaults to today. */
  date?: string;
}

export interface RemoveEntriesResult {
  file: string;
  pass: string;
  removed: number[];
  logRecords: number;
  logCitations: string[];
}

const heading = /^(#{2,3}) <a id="(\d+)"><\/a>\2\. (.*)$/gm;
const citationPattern = /^\[[\w.-]+\.md#\d+\]$/;

interface Located { number: number; start: number; end: number; level: string; title: string; text: string }

function locate(source: string): Located[] {
  const found = [...source.matchAll(heading)].map((match) => ({
    number: Number(match[2]), start: match.index, level: match[1], title: match[3],
  }));
  return found.map((entry, index) => {
    const limit = found[index + 1]?.start ?? source.length;
    const text = source.slice(entry.start, limit).trimEnd();
    return { ...entry, end: entry.start + text.length, text };
  });
}

function isTombstone(entry: Located): boolean {
  return entry.title.startsWith(`REMOVED -> ${DISCARD_LOG_FILE}`);
}

function topicPath(file: string, directories: RecordLearningDirectories): string {
  const catalogue = indexedFiles(directories).get(file);
  if (!catalogue) throw new DiscardLogError('NOT_FOUND', `Unknown memory file "${file}".`);
  return join(catalogue.directory, file);
}

export function removeKnowledgeEntries(
  input: RemoveEntriesInput,
  directories: RecordLearningDirectories = defaultRecordLearningDirectories(),
): RemoveEntriesResult {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DiscardLogError('INVALID_ARGUMENT', 'date must be YYYY-MM-DD.');
  const reason = input.reason.replace(/\s+/g, ' ').trim();
  if (!reason) throw new DiscardLogError('INVALID_ARGUMENT', 'reason is required.');
  const numbers = input.numbers;
  if (!numbers.length || new Set(numbers).size !== numbers.length || numbers.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new DiscardLogError('INVALID_ARGUMENT', 'numbers must be a non-empty list of distinct positive integers.');
  }
  if (input.file === DISCARD_LOG_FILE) throw new DiscardLogError('INVALID_ARGUMENT', 'The discard log is append-only.');
  for (const [number, citation] of Object.entries(input.supersededBy ?? {})) {
    if (!citationPattern.test(citation)) throw new DiscardLogError('INVALID_ARGUMENT', `supersededBy[${number}] must look like [file.md#N].`);
  }

  const sourcePath = topicPath(input.file, directories);
  if (!indexedFiles(directories).has(DISCARD_LOG_FILE)) {
    throw new DiscardLogError('NOT_FOUND', `${DISCARD_LOG_FILE} is not catalogued; refusing to remove anything without a log.`);
  }
  const source = readFileSync(sourcePath, 'utf8');
  const entries = locate(source);
  const targets = numbers.map((number) => {
    const entry = entries.find((candidate) => candidate.number === number);
    if (!entry) throw new DiscardLogError('NOT_FOUND', `${input.file} has no entry ${number}.`);
    if (isTombstone(entry)) throw new DiscardLogError('INVALID_ARGUMENT', `${input.file}#${number} is already removed.`);
    return entry;
  });

  // 1. Log first. A failure here leaves the source untouched.
  const pass = randomUUID();
  const logCitations: string[] = [];
  for (const entry of targets) {
    const superseded = input.supersededBy?.[entry.number];
    const quoted = entry.text.split('\n').map((line) => `> ${line}`).join('\n');
    let result;
    try {
      result = recordLearning({
        file: DISCARD_LOG_FILE,
        title: `${input.file}#${entry.number} removed ${date}`,
        body: [
          `- Date: ${date}`,
          `- Source file: ${input.file}`,
          `- Number: ${entry.number}`,
          `- Reason: ${reason}`,
          `- Superseded by: ${superseded ?? 'none'}`,
          `- Pass: ${pass}`,
          '',
          quoted,
        ].join('\n'),
      }, directories);
    } catch (error) {
      if (error instanceof RecordLearningError) throw new DiscardLogError('INVALID_ARGUMENT', `Not removing ${input.file}#${entry.number}: ${error.message}`);
      throw error;
    }
    logCitations.push(result.citation);
  }

  // 2. Re-read the log: one record per target, each carrying the full text.
  const logSource = readFileSync(topicPath(DISCARD_LOG_FILE, directories), 'utf8');
  const logRecords = logSource.split(`- Pass: ${pass}\n`).length - 1;
  if (logRecords !== targets.length) {
    throw new DiscardLogError('VERIFICATION_FAILED', `Discard log holds ${logRecords} records for this pass but ${targets.length} removals were requested; nothing removed.`);
  }
  for (const entry of targets) {
    if (!logSource.includes(entry.text.split('\n').map((line) => `> ${line}`).join('\n'))) {
      throw new DiscardLogError('VERIFICATION_FAILED', `Full text of ${input.file}#${entry.number} not found in the discard log; nothing removed.`);
    }
  }

  // 3. Replace each entry with a tombstone, last to first so offsets stay valid.
  let next = source;
  [...targets].reverse().forEach((entry) => {
    const citation = logCitations[targets.indexOf(entry)];
    const tombstone = `${entry.level} <a id="${entry.number}"></a>${entry.number}. REMOVED -> ${DISCARD_LOG_FILE} ${date}\n\nFull text: ${citation}`;
    next = `${next.slice(0, entry.start)}${tombstone}${next.slice(entry.end)}`;
  });
  writeFileSync(sourcePath, next);

  // 4. Re-read the source: every target is a tombstone, entry count unchanged, and removals == log records.
  const after = locate(readFileSync(sourcePath, 'utf8'));
  const tombstoned = targets.filter((entry) => {
    const now = after.find((candidate) => candidate.number === entry.number);
    return now && isTombstone(now) && !now.text.includes(entry.text.slice(entry.text.indexOf('\n') + 1).trim() || '\0');
  });
  if (after.length !== entries.length || tombstoned.length !== logRecords) {
    throw new DiscardLogError('VERIFICATION_FAILED', `Removal count ${tombstoned.length} does not equal discard-log record count ${logRecords} for pass ${pass}.`);
  }
  return { file: input.file, pass, removed: numbers, logRecords, logCitations };
}
