import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkKnowledgeDrift, type KnowledgeDriftInput, type KnowledgeDriftSource } from './knowledge-drift.js';

const fixtureRoot = join(import.meta.dirname, 'fixtures/knowledge-drift');
const NOW = '2026-10-08T12:00:00.000Z';

async function sources(directory: string): Promise<KnowledgeDriftSource[]> {
  return Promise.all((await readdir(directory)).map(async (file) => ({
    file,
    source: await readFile(join(directory, file), 'utf8'),
    modifiedAt: NOW,
  })));
}

async function fixture(variant: 'passing' | 'dangling' | 'stale' = 'passing'): Promise<KnowledgeDriftInput> {
  const passing = join(fixtureRoot, 'passing');
  const input: KnowledgeDriftInput = {
    sharedFiles: await sources(join(passing, 'shared')),
    knowledgeFiles: await sources(join(passing, 'knowledge')),
    sharedIndex: await readFile(join(passing, 'shared-index.md'), 'utf8'),
    knowledgeIndex: await readFile(join(passing, 'knowledge-index.md'), 'utf8'),
    now: NOW,
  };
  if (variant === 'dangling') {
    const source = await readFile(join(fixtureRoot, 'dangling/shared/portable.md'), 'utf8');
    input.sharedFiles = input.sharedFiles.map((file) => file.file === 'portable.md' ? { ...file, source } : file);
  }
  if (variant === 'stale') input.sharedIndex = await readFile(join(fixtureRoot, 'stale/shared-index.md'), 'utf8');
  return input;
}

describe('checkKnowledgeDrift', () => {
  it('reports every check healthy for the passing fixture set', async () => {
    const report = checkKnowledgeDrift(await fixture());
    expect(report.status).toBe('healthy');
    expect(Object.values(report.checks).map(({ status }) => status)).toEqual(Array(9).fill('healthy'));
    expect(report.checks.consolidation.details.daysSinceLastConsolidation).toBe(7);
  });

  it('finds the dangling citation fixture', async () => {
    const report = checkKnowledgeDrift(await fixture('dangling'));
    expect(report.checks.danglingCitations).toMatchObject({ status: 'failed', details: { citations: [{ sourceFile: 'portable.md', target: 'workbench.md#99' }] } });
  });

  it('finds the stale stated count fixture', async () => {
    const report = checkKnowledgeDrift(await fixture('stale'));
    expect(report.checks.entryCounts).toMatchObject({ status: 'degraded', details: { mismatches: [{ file: 'portable.md', stated: 2, actual: 1 }] } });
  });

  it('checks index rows, duplicate numbers, cross-refs, tiers, consolidation, size, and tier writes', async () => {
    const input = await fixture();
    input.sharedFiles = input.sharedFiles
      .filter(({ file }) => file !== 'discard-log.md')
      .map((file) => file.file === 'portable.md' ? { ...file, modifiedAt: '2026-08-01T00:00:00.000Z', source: 'tier: invalid\n## <a id="1"></a>1. One\n## <a id="1"></a>1. Again\n' } : file);
    input.sharedIndex = input.sharedIndex.replace('| `workbench.md` | 1 | workbench | core | workbench | `portable.md` |', '| `workbench.md` | 1 | workbench | core | workbench | — |');
    input.entryThreshold = 0;

    const report = checkKnowledgeDrift(input);
    expect(report.checks.indexRows.status).toBe('failed');
    expect(report.checks.duplicateEntryNumbers.status).toBe('failed');
    expect(report.checks.asymmetricCrossRefs.status).toBe('degraded');
    expect(report.checks.tierHeaders.status).toBe('failed');
    expect(report.checks.consolidation.details.daysSinceLastConsolidation).toBe('never');
    expect(report.checks.oversizedFiles.status).toBe('degraded');
    expect(report.checks.tierWrites.status).toBe('degraded');
  });
});
