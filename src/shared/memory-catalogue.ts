export const MEMORY_TIERS = ['portable', 'workbench', 'writer'] as const;
export type MemoryTier = typeof MEMORY_TIERS[number];

export interface MemoryEntry {
  id: number;
  title: string;
  /** Text between this entry's heading and the next numbered heading. */
  body: string;
}

export interface MemoryFileAnalysis {
  tier: string | null;
  entries: MemoryEntry[];
  duplicateEntryNumbers: number[];
  hasUnnumberedHeading: boolean;
  citations: Array<{ file: string; entry: number }>;
}

export interface CatalogueRow {
  file: string;
  statedEntries: number;
  tier: string;
  crossRefs: string[];
}

const tierHeader = /^(?:---\n)?tier: (\S+)\s*(?:\n|$)/;
const numberedHeading = /^#{2,3} <a id="(\d+)"><\/a>\1\. (.*)$/gm;
const unnumberedHeading = /^#{2,3} (?!<a id="\d+"><\/a>\d+\. ).+$/m;
const citation = /\[([\w.-]+\.md)#(\d+)\]/g;

export function analyzeMemoryFile(source: string): MemoryFileAnalysis {
  const headings = [...source.matchAll(numberedHeading)];
  const entries = headings.map((match, index) => ({
    id: Number(match[1]),
    title: match[2],
    body: source.slice(match.index + match[0].length, headings[index + 1]?.index ?? source.length).trim(),
  }));
  const counts = new Map<number, number>();
  for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  return {
    tier: source.match(tierHeader)?.[1] ?? null,
    entries,
    duplicateEntryNumbers: [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
    hasUnnumberedHeading: unnumberedHeading.test(source),
    citations: [...source.matchAll(citation)].map((match) => ({ file: match[1], entry: Number(match[2]) })),
  };
}

export function parseCatalogue(source: string): Map<string, CatalogueRow> {
  const rows = new Map<string, CatalogueRow>();
  for (const line of source.split('\n')) {
    const match = line.match(/^\| `([^`]+\.md)` \| (\d+) \| ([^|]+?) \| [^|]+ \| [^|]+ \| (.+) \|$/);
    if (!match) continue;
    const crossRefs = match[4].trim() === '—' ? [] : [...match[4].matchAll(/`([^`]+\.md)`/g)].map((ref) => ref[1]);
    rows.set(match[1], { file: match[1], statedEntries: Number(match[2]), tier: match[3].trim(), crossRefs });
  }
  return rows;
}

export function isMemoryTier(value: string | null): value is MemoryTier {
  return value !== null && MEMORY_TIERS.includes(value as MemoryTier);
}
