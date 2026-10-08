import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeMemoryFile, isMemoryTier, MEMORY_TIERS, parseCatalogue, type MemoryTier } from '../shared/memory-catalogue.js';

export type KnowledgeDriftStatus = 'healthy' | 'degraded' | 'failed';

export interface KnowledgeDriftSource {
  file: string;
  source: string;
  modifiedAt: string;
}

export interface KnowledgeDriftInput {
  sharedFiles: KnowledgeDriftSource[];
  knowledgeFiles: KnowledgeDriftSource[];
  sharedIndex: string;
  knowledgeIndex: string;
  now: string;
  entryThreshold?: number;
}

interface Check<T> {
  status: KnowledgeDriftStatus;
  reason: string;
  details: T;
}

export interface KnowledgeDriftReport {
  checkedAt: string;
  status: KnowledgeDriftStatus;
  checks: {
    indexRows: Check<{ missingFromIndex: string[]; missingOnDisk: string[] }>;
    entryCounts: Check<{ mismatches: Array<{ file: string; stated: number; actual: number }> }>;
    duplicateEntryNumbers: Check<{ duplicates: Array<{ file: string; entries: number[] }> }>;
    danglingCitations: Check<{ citations: Array<{ sourceFile: string; target: string }> }>;
    asymmetricCrossRefs: Check<{ references: Array<{ from: string; to: string }> }>;
    tierHeaders: Check<{ invalid: Array<{ file: string; tier: string | null }> }>;
    consolidation: Check<{ daysSinceLastConsolidation: number | 'never'; lastConsolidatedAt: string | null }>;
    oversizedFiles: Check<{ threshold: number; files: Array<{ file: string; entries: number }> }>;
    tierWrites: Check<{ windowDays: number; tiers: Array<{ tier: MemoryTier; receivedWrite: boolean; lastWriteAt: string | null }> }>;
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const severity: Record<KnowledgeDriftStatus, number> = { healthy: 0, degraded: 1, failed: 2 };

function check<T>(status: KnowledgeDriftStatus, reason: string, details: T): Check<T> {
  return { status, reason, details };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Pure drift evaluation. Filesystem reads and report storage stay outside this function. */
export function checkKnowledgeDrift(input: KnowledgeDriftInput): KnowledgeDriftReport {
  const files = [...input.sharedFiles, ...input.knowledgeFiles];
  const analyses = new Map(files.map((file) => [file.file, analyzeMemoryFile(file.source)]));
  const catalogue = new Map([...parseCatalogue(input.sharedIndex), ...parseCatalogue(input.knowledgeIndex)]);
  const diskNames = new Set(files.map(({ file }) => file));
  const indexNames = new Set(catalogue.keys());

  const missingFromIndex = [...diskNames].filter((file) => !indexNames.has(file)).sort();
  const missingOnDisk = [...indexNames].filter((file) => !diskNames.has(file)).sort();
  const indexProblems = missingFromIndex.length + missingOnDisk.length;
  const indexRows = check(indexProblems ? 'failed' : 'healthy', indexProblems
    ? `${plural(indexProblems, 'catalogue mismatch')} between index rows and files on disk.`
    : `All ${diskNames.size} memory files have matching index rows.`, { missingFromIndex, missingOnDisk });

  const mismatches = [...catalogue.values()].flatMap((row) => {
    const actual = analyses.get(row.file)?.entries.length;
    return actual === undefined || actual === row.statedEntries ? [] : [{ file: row.file, stated: row.statedEntries, actual }];
  });
  const entryCounts = check(mismatches.length ? 'degraded' : 'healthy', mismatches.length
    ? `${plural(mismatches.length, 'file')} ${mismatches.length === 1 ? 'has' : 'have'} a stale stated entry count.`
    : 'Every stated entry count matches the re-derived count.', { mismatches });

  const duplicates = [...analyses].flatMap(([file, analysis]) => analysis.duplicateEntryNumbers.length
    ? [{ file, entries: analysis.duplicateEntryNumbers }] : []);
  const duplicateEntryNumbers = check(duplicates.length ? 'failed' : 'healthy', duplicates.length
    ? `${plural(duplicates.length, 'file')} ${duplicates.length === 1 ? 'contains' : 'contain'} duplicate entry numbers.`
    : 'No duplicate entry numbers were found.', { duplicates });

  const dangling = files.flatMap((file) => analyses.get(file.file)?.citations.flatMap((citation) => {
    const target = analyses.get(citation.file);
    return target?.entries.some(({ id }) => id === citation.entry) ? [] : [{ sourceFile: file.file, target: `${citation.file}#${citation.entry}` }];
  }) ?? []);
  const danglingCitations = check(dangling.length ? 'failed' : 'healthy', dangling.length
    ? `${plural(dangling.length, 'citation')} ${dangling.length === 1 ? 'points' : 'point'} to a missing entry.`
    : 'Every memory citation points to an existing entry.', { citations: dangling });

  const asymmetric = [...catalogue.values()].flatMap((row) => row.crossRefs.flatMap((target) =>
    catalogue.get(target)?.crossRefs.includes(row.file) ? [] : [{ from: row.file, to: target }]
  ));
  const asymmetricCrossRefs = check(asymmetric.length ? 'degraded' : 'healthy', asymmetric.length
    ? `${plural(asymmetric.length, 'cross-reference')} ${asymmetric.length === 1 ? 'is' : 'are'} missing a reciprocal link.`
    : 'Every catalogue cross-reference is reciprocal.', { references: asymmetric });

  const invalidTiers = [...analyses].flatMap(([file, analysis]) => isMemoryTier(analysis.tier) ? [] : [{ file, tier: analysis.tier }]);
  const tierHeaders = check(invalidTiers.length ? 'failed' : 'healthy', invalidTiers.length
    ? `${plural(invalidTiers.length, 'file')} ${invalidTiers.length === 1 ? 'has' : 'have'} a missing or invalid tier header.`
    : 'Every memory file has a valid tier header.', { invalid: invalidTiers });

  const discardLog = files.find(({ file }) => file === 'discard-log.md');
  const consolidationSources = discardLog ? [discardLog] : files.filter(({ file }) => file === 'migration-log.md');
  const consolidationDates = consolidationSources.flatMap((file) => file.source.split('\n').flatMap((line) => {
    if (file.file !== 'discard-log.md' && !/consolidat|migrat/i.test(line)) return [];
    return [...line.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
  })).filter((value) => Number.isFinite(Date.parse(value)));
  const lastConsolidatedAt = consolidationDates.sort().at(-1) ?? null;
  const daysSinceLastConsolidation: number | 'never' = lastConsolidatedAt === null
    ? 'never'
    : Math.max(0, Math.floor((Date.parse(input.now) - Date.parse(lastConsolidatedAt)) / DAY_MS));
  const consolidationStatus: KnowledgeDriftStatus = daysSinceLastConsolidation === 'never' ? 'failed' : daysSinceLastConsolidation > 90 ? 'failed' : daysSinceLastConsolidation > 30 ? 'degraded' : 'healthy';
  const consolidation = check(consolidationStatus, daysSinceLastConsolidation === 'never'
    ? 'No consolidation activity was found.'
    : `The newest consolidation activity was ${daysSinceLastConsolidation} days ago.`, { daysSinceLastConsolidation, lastConsolidatedAt });

  const threshold = input.entryThreshold ?? 60;
  const oversized = [...analyses].flatMap(([file, analysis]) => analysis.entries.length > threshold ? [{ file, entries: analysis.entries.length }] : []);
  const oversizedFiles = check(oversized.length ? 'degraded' : 'healthy', oversized.length
    ? `${plural(oversized.length, 'file')} ${oversized.length === 1 ? 'exceeds' : 'exceed'} the ${threshold}-entry threshold.`
    : `No memory file exceeds the ${threshold}-entry threshold.`, { threshold, files: oversized });

  const tierWriteDetails = MEMORY_TIERS.map((tier) => {
    const writes = files.filter((file) => analyses.get(file.file)?.tier === tier).map((file) => file.modifiedAt).filter((date) => Number.isFinite(Date.parse(date))).sort();
    const lastWriteAt = writes.at(-1) ?? null;
    return { tier, receivedWrite: lastWriteAt !== null && Date.parse(input.now) - Date.parse(lastWriteAt) <= 30 * DAY_MS, lastWriteAt };
  });
  const staleTiers = tierWriteDetails.filter(({ receivedWrite }) => !receivedWrite);
  const tierWrites = check(staleTiers.length ? 'degraded' : 'healthy', staleTiers.length
    ? `${plural(staleTiers.length, 'tier')} received no write in the last 30 days.`
    : 'Every tier received a write in the last 30 days.', { windowDays: 30, tiers: tierWriteDetails });

  const checks = { indexRows, entryCounts, duplicateEntryNumbers, danglingCitations, asymmetricCrossRefs, tierHeaders, consolidation, oversizedFiles, tierWrites };
  const status = Object.values(checks).reduce<KnowledgeDriftStatus>((worst, item) => severity[item.status] > severity[worst] ? item.status : worst, 'healthy');
  return { checkedAt: input.now, status, checks };
}

async function readMemoryFiles(directory: string): Promise<KnowledgeDriftSource[]> {
  const names = (await readdir(directory)).filter((file) => file.endsWith('.md') && file !== 'index.md').sort();
  return Promise.all(names.map(async (file) => {
    const path = join(directory, file);
    const [source, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { file, source, modifiedAt: metadata.mtime.toISOString() };
  }));
}

export async function runKnowledgeDriftCheck(options: { root?: string; knowledgeDirectory?: string; now?: string; entryThreshold?: number } = {}) {
  const root = options.root ?? process.cwd();
  const knowledgeDirectory = options.knowledgeDirectory ?? join(homedir(), 'Documents/Workbench/notes/knowledge');
  const [sharedFiles, knowledgeFiles, sharedIndex, knowledgeIndex] = await Promise.all([
    readMemoryFiles(join(root, 'docs/shared-memory')),
    readMemoryFiles(knowledgeDirectory),
    readFile(join(root, 'docs/shared-memory.md'), 'utf8'),
    readFile(join(knowledgeDirectory, 'index.md'), 'utf8'),
  ]);
  return checkKnowledgeDrift({ sharedFiles, knowledgeFiles, sharedIndex, knowledgeIndex, now: options.now ?? new Date().toISOString(), entryThreshold: options.entryThreshold });
}
