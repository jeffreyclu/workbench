// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildKnowledgeUsage, KNOWLEDGE_USAGE_NOTICE } from '../../../shared/knowledge-usage';
import { KnowledgeUsagePanel } from './knowledge-usage';

afterEach(cleanup);

const fixture = buildKnowledgeUsage({
  now: '2026-10-08T12:00:00.000Z',
  usage: [
    { entryId: 'doc:shared:workbench-product-decisions.md#3', retrievals: 9, citations: 1 },
    { entryId: 'doc:shared:working-with-jeffrey.md#12', retrievals: 4, citations: 6 },
    { entryId: 'working-with-jeffrey.md#12', retrievals: 0, citations: 2 },
  ],
  knownFiles: ['workbench-product-decisions.md', 'working-with-jeffrey.md', 'writer-context.md'],
  recentRetrievalsByFile: new Map([['workbench-product-decisions.md', 5]]),
  activeProjects: [{ project: 'Workbench', runs: 8 }, { project: 'Writer', runs: 3 }],
});

describe('KnowledgeUsagePanel', () => {
  it('ranks entries and flags the one project whose knowledge is not being found', () => {
    render(<KnowledgeUsagePanel data={fixture} loading={false} error={false} onRetry={() => undefined} />);
    expect(screen.getByText(KNOWLEDGE_USAGE_NOTICE)).toBeTruthy();
    const retrieved = within(screen.getByRole('rowgroup', { name: 'Most retrieved' }));
    expect(retrieved.getAllByRole('row')[1].textContent).toContain('workbench-product-decisions.md #3');
    const cited = within(screen.getByRole('rowgroup', { name: 'Most cited' }));
    expect(cited.getAllByRole('row')[1].textContent).toContain('working-with-jeffrey.md #12');
    const gaps = within(screen.getByRole('rowgroup', { name: 'Gaps' })).getAllByRole('row').slice(1);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].textContent).toContain('Writer');
    expect(gaps[0].textContent).toContain('writer-context.md was never retrieved');
    expect(gaps[0].textContent).toContain('needs a learning or is not being found');
  });

  it('flags a project with no matching file', () => {
    const report = buildKnowledgeUsage({ now: fixture.generatedAt, usage: [], knownFiles: [], recentRetrievalsByFile: new Map(), activeProjects: [{ project: 'Palmyra', runs: 1 }] });
    expect(report.gaps).toEqual([{ project: 'Palmyra', runs: 1, file: null, reason: 'no_file' }]);
  });
});
