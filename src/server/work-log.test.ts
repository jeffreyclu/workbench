import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendWorkLog } from './work-log.js';
import type { ObservedRunEvent } from './review-handoff.js';

const run = { id: 'run-1', kind: 'execute', workItemId: 'task-1' };
const tools = (count: number): ObservedRunEvent[] => Array.from({ length: count }, () => ({ category: 'agent_tool_use', detail: 'x', streamKind: 'tool' }));
const write: ObservedRunEvent = { category: 'agent_file_write', detail: 'update: a.ts', streamKind: 'file_write' };

describe('work log', () => {
  it('appends exactly one line for a non-trivial run and none for a trivial one', () => {
    const docs = mkdtempSync(join(tmpdir(), 'worklog-'));
    const base = { run, repoPath: '/Users/j/dev/workbench/', summary: 'Did the thing', output: 'see https://github.com/acme/repo/pull/42', completedAt: '2026-10-08T10:00:00.000Z' };
    expect(appendWorkLog({ ...base, events: [...tools(2)] }, docs)).toBe(false);
    expect(appendWorkLog({ ...base, events: [write] }, docs)).toBe(true);
    expect(appendWorkLog({ ...base, run: { ...run, id: 'run-2' }, events: tools(8) }, docs)).toBe(true);
    const lines = readFileSync(join(docs, 'work-log.md'), 'utf8').split('\n').filter((line) => line.startsWith('## ['));
    expect(lines).toEqual([
      '## [2026-10-08] execute | workbench | Did the thing [run:run-1] [task:task-1] [pr:42]',
      '## [2026-10-08] execute | workbench | Did the thing [run:run-2] [task:task-1] [pr:42]',
    ]);
  });
});
